import { boardItemStatus } from '../../shared/ipc'
import type { BoardItem, BoardItemStatus } from '../../shared/ipc'
// O resumo de chamada é o MESMO do vigia, de propósito: os dois digests têm a
// mesma regra de segurança ("o alvo da ação, nunca o conteúdo"), e duas listas
// de chaves que ninguém garante iguais é como uma delas passa a vazar.
export { summarizeCall } from '../vigia/vigiaPrompt'

/**
 * As regras puras do PO — o agente que audita o quadro.
 *
 * Ele NÃO é o autor do quadro. O esqueleto (tarefas e status) vem do snapshot
 * autoritativo do CLI; o PO só conserta o buraco que o esqueleto não cobre:
 *
 * - o cartão que o agente terminou e esqueceu de marcar;
 * - o título técnico que não diz nada a quem lê ("add board table + migration");
 * - a tarefa que surgiu no meio e nunca foi declarada.
 *
 * Tudo o que ele escreve vai com motivo e carimbo, porque uma correção
 * automática que não dá para auditar é pior do que nenhuma — e um modelo pequeno
 * vai errar alguma hora.
 */

/** Uma análise por turno, e não mais que uma por minuto na mesma conversa. */
export const PO_COOLDOWN_MS = 60_000
/** Tetos do digest: o custo não pode crescer com o tamanho da conversa. */
export const PO_MAX_USER_CHARS = 1200
export const PO_MAX_CALLS = 20
export const PO_MAX_CARDS = 30
/** Teto de operações por análise. Um PO que reescreve o quadro inteiro de uma
 *  vez é quase certamente um PO que entendeu tudo errado. */
export const PO_MAX_OPS = 6
export const PO_MAX_TITLE_CHARS = 90

export interface PoCall {
  tool: string
  detail: string
}

export type PoOp =
  | { kind: 'complete'; id: string; reason: string }
  | { kind: 'retitle'; id: string; title: string }
  | { kind: 'create'; title: string; reason: string }

export const PO_SYSTEM_PROMPT = `Você é o PO (product owner) de um quadro de tarefas.

Um agente de programação está trabalhando e declarou uma lista de tarefas. Essa lista é a
fonte da verdade do que existe e de qual é o status — você NÃO a reescreve. Seu trabalho é
só consertar três buracos que ela não cobre:

1. O agente TERMINOU uma tarefa e esqueceu de marcá-la como concluída.
2. O título é técnico demais para quem lê o quadro (ex.: "add board table + migration 5/7").
3. Uma tarefa REAL apareceu no meio do trabalho e nunca foi declarada.

Responda com uma operação por linha, no formato exato:

CONCLUIR <id> | <motivo curto>
TITULO <id> | <novo título>
NOVA | <título> | <motivo curto>

Se não houver nada a corrigir, responda exatamente OK. Na dúvida, responda OK.

Regras inegociáveis:
- Só use CONCLUIR quando as AÇÕES mostrarem que o trabalho daquela tarefa terminou de fato
  (o arquivo foi escrito, o teste rodou). Suposição não basta: marcar como concluído algo
  que não terminou é o pior erro que você pode cometer aqui.
- Nunca use CONCLUIR numa tarefa que já está concluída.
- Uma tarefa que ficou "em andamento" no fim do turno é a candidata MAIS provável ao
  esquecimento — mas só conclua se as ações provarem que ela terminou. Trabalho que vai
  continuar na próxima mensagem continua em andamento.
- O <id> tem que ser um dos ids listados no quadro. Não invente id.
- TITULO é para deixar legível, não para mudar o significado. Mantenha o assunto.
- NOVA só para trabalho que AINDA FALTA e que nenhum cartão cobre — tipicamente algo que o
  agente disse que ia fazer depois. NUNCA crie NOVA para uma ação que já aconteceu (rodar
  teste, typecheck, build, ler arquivo): um cartão "a fazer" descrevendo algo já feito é pior
  do que cartão nenhum. E nunca para sugerir uma tarefa que você acha que seria boa ideia.
- No máximo ${PO_MAX_OPS} operações. Sem texto fora das linhas de operação.`

function clamp(text: string, max: number): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function statusLabel(status: BoardItemStatus): string {
  if (status === 'completed') return 'concluída'
  if (status === 'in_progress') return 'em andamento'
  return 'a fazer'
}

export function buildPoDigest(input: {
  userText: string
  cards: { id: string; title: string; status: BoardItemStatus }[]
  calls: PoCall[]
}): string {
  const cards = input.cards.slice(0, PO_MAX_CARDS)
  const calls = input.calls.slice(0, PO_MAX_CALLS)
  const lines = [
    'PEDIDO DO USUÁRIO:',
    clamp(input.userText, PO_MAX_USER_CHARS) || '(sem texto)',
    '',
    'QUADRO ATUAL:',
    ...(cards.length === 0
      ? ['(vazio)']
      : cards.map((card) => `${card.id} [${statusLabel(card.status)}] ${clamp(card.title, PO_MAX_TITLE_CHARS)}`)),
    '',
    'AÇÕES DESTE TURNO:',
    ...(calls.length === 0 ? ['(nenhuma)'] : calls.map((call) => `- ${call.tool}: ${call.detail}`))
  ]
  return lines.join('\n')
}

export function buildPoPrompt(input: Parameters<typeof buildPoDigest>[0]): string {
  return `${PO_SYSTEM_PROMPT}\n\n---\n\n${buildPoDigest(input)}`
}

/**
 * Lê a resposta do modelo.
 *
 * Falha FECHADA por linha: o que não casa com o formato é descartado em
 * silêncio, nunca vira uma operação inventada. Uma linha ruim não invalida as
 * outras — o contrário desperdiçaria uma análise inteira por um erro de
 * formatação.
 *
 * `knownIds` é a segunda barreira, e a que mais importa: uma operação sobre um
 * id que não está no quadro é descartada, então o PO não consegue mexer num
 * cartão que ele não viu.
 */
export function parsePoVerdict(raw: string, knownIds: Iterable<string>): PoOp[] {
  const ids = new Set(knownIds)
  const ops: PoOp[] = []
  const seen = new Set<string>()
  for (const line of (raw ?? '').split(/\r?\n/)) {
    if (ops.length >= PO_MAX_OPS) break
    const text = line.replace(/^[`\s>*-]+/, '').trim()
    if (!text || /^OK\b/i.test(text)) continue

    const complete = /^CONCLUIR\s+(\S+)\s*\|\s*(.+)$/i.exec(text)
    if (complete) {
      const [, id, reason] = complete
      if (!ids.has(id) || seen.has(`c:${id}`) || !reason.trim()) continue
      seen.add(`c:${id}`)
      ops.push({ kind: 'complete', id, reason: clamp(reason, 160) })
      continue
    }

    const retitle = /^TITULO\s+(\S+)\s*\|\s*(.+)$/i.exec(text)
    if (retitle) {
      const [, id, title] = retitle
      if (!ids.has(id) || seen.has(`t:${id}`) || !title.trim()) continue
      seen.add(`t:${id}`)
      ops.push({ kind: 'retitle', id, title: clamp(title, PO_MAX_TITLE_CHARS) })
      continue
    }

    const create = /^NOVA\s*\|\s*([^|]+)\|\s*(.+)$/i.exec(text)
    if (create) {
      const [, title, reason] = create
      if (!title.trim() || !reason.trim()) continue
      const clean = clamp(title, PO_MAX_TITLE_CHARS)
      if (seen.has(`n:${clean.toLowerCase()}`)) continue
      seen.add(`n:${clean.toLowerCase()}`)
      ops.push({ kind: 'create', title: clean, reason: clamp(reason, 160) })
    }
  }
  return ops
}

/**
 * Descarta as operações que contrariam o esqueleto — a última barreira antes do
 * banco, e a que protege o invariante do recurso: o PO corrige o que o agente
 * esqueceu, não discute com o que o agente acabou de dizer.
 */
export function rejectUnsafeOps(ops: PoOp[], cards: BoardItem[]): PoOp[] {
  const byId = new Map(cards.map((card) => [card.id, card]))
  return ops.filter((op) => {
    if (op.kind === 'create') return true
    const card = byId.get(op.id)
    if (!card) return false
    if (op.kind === 'retitle') return op.title.trim() !== card.sourceTitle.trim()
    // Concluir: tudo o que ainda não está concluído.
    //
    // Uma versão anterior exigia `sourceStatus === 'pending'` aqui, e isso
    // matava o recurso: o caso central ("o agente fez e esqueceu de marcar")
    // deixa o cartão exatamente em `in_progress`, porque ele marcou o início e
    // não marcou o fim. O snapshot do CLI não tem noção de "agora" — e o PO só
    // roda com o turno JÁ encerrado, então "em andamento" ali é estado parado,
    // não trabalho acontecendo. Quem segura o exagero é o prompt (exige
    // evidência nas ações) e o motivo gravado no cartão, não uma proibição que
    // também barra o caso certo.
    return boardItemStatus(card) !== 'completed'
  })
}
