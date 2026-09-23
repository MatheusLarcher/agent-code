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
 * - o pedido do usuário que nunca virou tarefa nenhuma;
 * - o cartão que o agente terminou e esqueceu de marcar;
 * - o título técnico que não diz nada a quem lê ("add board table + migration");
 * - o trabalho que aconteceu (ou ficou faltando) e nunca foi declarado.
 *
 * Tudo o que ele escreve vai com motivo e carimbo, porque uma correção
 * automática que não dá para auditar é pior do que nenhuma — e um modelo pequeno
 * vai errar alguma hora.
 */

/**
 * As duas rodadas do PO dentro de um turno.
 *
 * `open` roda quando o pedido do usuário chega: ali o quadro ainda não tem o
 * trabalho de agora, e o que importa é o pedido virar cartão ANTES de o agente
 * começar — o buraco que o fechamento sozinho nunca fechou, porque quando ele
 * roda o pedido já passou e ninguém mais sabe que ele existiu.
 *
 * `close` roda no `result`: ali o turno acabou e dá para julgar o que de fato
 * terminou. São prompts separados porque as perguntas são opostas ("o que vai
 * começar?" e "o que terminou?") e um prompt que faz as duas ao mesmo tempo
 * convida o modelo a responder a errada.
 */
export type PoPhase = 'open' | 'close'

/** Uma análise por FASE por turno, e não mais que uma por minuto na mesma
 *  conversa. O cooldown é por fase de propósito: com um contador só, a abertura
 *  gastaria a janela e o fechamento daquele turno nunca rodaria. */
export const PO_COOLDOWN_MS = 60_000
/**
 * A retentativa de uma análise que passou do cooldown e NÃO chegou ao fim
 * (modelo fora, Luna indisponível, quadro ilegível, exceção). Sem ela, a
 * evidência que voltou para a fila só era julgada no PRÓXIMO turno — e o turno
 * que terminou a conversa não tem próximo: a tarefa concluída ficava "em
 * andamento" no quadro até alguém voltar a falar. O intervalo é o do cooldown
 * de propósito: a retentativa nunca consulta o modelo com mais frequência do
 * que um turno real consultaria.
 */
export const PO_RETRY_DELAY_MS = 60_000
/** Retentativas SEGUIDAS por fase. O teto existe porque uma falha que dura
 *  (chave revogada, quadro fora do ar) não pode virar uma consulta por minuto
 *  para sempre; esgotado, a evidência continua na fila para o próximo turno ou
 *  para o `dispose`, como antes da retentativa existir. */
export const PO_MAX_RETRIES = 2
/** Tetos do digest: o custo não pode crescer com o tamanho da conversa. */
export const PO_MAX_USER_CHARS = 1200
/**
 * Numa sessão longa e cheia de delegação (dezenas de turnos por hora, cada
 * um com um subagente), o cooldown de 60s pula quase todo fechamento e
 * `mergeDeferred` mantém só as ÚLTIMAS ações de todos os turnos acumulados.
 * Com o teto antigo (20), a evidência de "o arquivo foi escrito, o teste
 * rodou" que provava a conclusão de um cartão saía da janela bem antes de o
 * cooldown liberar uma análise — e o PO, corretamente pela própria regra
 * ("só conclua com evidência"), nunca tinha motivo para marcar CONCLUIR.
 * 60 não elimina o limite, mas dá margem para o volume real deste modo de
 * trabalho sem inflar o prompt a cada turno de uma sessão comum.
 */
export const PO_MAX_CALLS = 60
export const PO_MAX_CARDS = 30
/** Teto da seção de tarefas do registro (mcp__tasks) no digest — mesmo
 *  espírito de PO_MAX_CARDS: uma lista longa não ajuda o modelo a decidir. */
export const PO_MAX_LEDGER_TASKS = 15
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
  /** ANDAMENTO: o pedido é coberto por um cartão que já existe. */
  | { kind: 'start'; id: string; reason: string }
  | { kind: 'retitle'; id: string; title: string }
  /** O status com que o cartão nasce: `in_progress` na abertura (o trabalho está
   *  começando), `pending` no fechamento (ficou faltando) e `completed` no
   *  FEITA (aconteceu neste turno e ninguém registrou). */
  | { kind: 'create'; title: string; reason: string; status: BoardItemStatus }

export const PO_SYSTEM_PROMPT_OPEN = `Você é o PO (product owner) de um quadro de tarefas.

O usuário ACABOU de pedir uma coisa e um agente de programação vai começar agora. Seu
trabalho aqui é um só: garantir que o pedido apareça no quadro antes do trabalho começar.
Pedido que não vira cartão some sem deixar rastro — é assim que trabalho combinado se perde.

Responda com uma operação por linha, no formato exato:

ANDAMENTO <id> | <motivo curto>
NOVA | <título> | <motivo curto>

Se o pedido não for trabalho para o quadro, responda exatamente OK. Na dúvida, responda OK.

Regras inegociáveis:
- Só vira cartão o que for TRABALHO no projeto: mudar código, corrigir, criar, investigar para
  depois mudar. PERGUNTA, dúvida, conversa, pedido de explicação ou de status NÃO viram cartão
  — responder não é trabalho de quadro, e um quadro cheio de conversa não serve para nada.
- Se algum cartão do quadro JÁ cobre o pedido, use ANDAMENTO nele em vez de criar outro. Dois
  cartões para o mesmo trabalho é pior do que nenhum: ninguém sabe qual seguir.
- Um pedido de CONTINUAÇÃO ("continua", "pode", "sim", "beleza", uma instrução extra sobre o
  mesmo assunto) não é diferente de um pedido novo quando já existe um cartão "a fazer" cobrindo
  aquele trabalho: use ANDAMENTO nele. Não responda OK só porque a mensagem, isolada, não parece
  um pedido "novo" — o trabalho está retomando, e o cartão tem que acompanhar.
- NOVA aqui cria o cartão JÁ EM ANDAMENTO, porque o trabalho está começando agora — não é uma
  intenção para depois.
- O <id> tem que ser um dos ids listados no quadro. Não invente id.
- Um pedido é UM cartão. Não quebre o pedido em passos: quem decompõe é o agente, e o plano
  dele entra no quadro sozinho.
- O título diz o que o usuário pediu, em uma linha e em português claro.
- Se houver uma seção "TAREFAS DO REGISTRO NESTA CONVERSA" com uma tarefa do MESMO assunto,
  trate como cartão já existente — não crie outro.
- No máximo ${PO_MAX_OPS} operações. Sem texto fora das linhas de operação.`

export const PO_SYSTEM_PROMPT_CLOSE = `Você é o PO (product owner) de um quadro de tarefas.

Um agente de programação acabou de trabalhar e declarou uma lista de tarefas. Essa lista é a
fonte da verdade do que existe e de qual é o status — você NÃO a reescreve. Seu trabalho é
só consertar os buracos que ela não cobre:

1. O agente TERMINOU uma tarefa e esqueceu de marcá-la como concluída.
2. O título é técnico demais para quem lê o quadro (ex.: "add board table + migration 5/7").
3. Um trabalho REAL aconteceu neste turno e nenhum cartão registra que ele aconteceu.
4. Um trabalho REAL ainda falta e nenhum cartão cobre ele.

Responda com uma operação por linha, no formato exato:

CONCLUIR <id> | <motivo curto>
TITULO <id> | <novo título>
FEITA | <título> | <motivo curto>
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
- FEITA é para o trabalho que JÁ ACONTECEU neste turno e que nenhum cartão registra: o cartão
  nasce concluído, com o motivo dizendo o que foi feito. É assim que um pedido atendido sem
  plano nenhum deixa rastro.
- NOVA é o contrário: só para trabalho que AINDA FALTA e que nenhum cartão cobre — tipicamente
  algo que o agente disse que ia fazer depois. Nunca use NOVA para algo que já aconteceu (para
  isso existe FEITA), nem para sugerir uma tarefa que você acha que seria boa ideia.
- Ação de apoio não é cartão: ler arquivo, rodar teste, typecheck e build fazem parte do
  trabalho — não crie um cartão para cada uma delas.
- Se já existe cartão com o mesmo assunto, não crie outro.
- Se houver uma seção "TAREFAS DO REGISTRO NESTA CONVERSA", uma tarefa marcada [done] ali é
  evidência de conclusão tão válida quanto uma ação direta desta lista — use para CONCLUIR ou
  FEITA mesmo sem ver o arquivo sendo escrito nas AÇÕES DESTE TURNO.
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

/**
 * Normalização de título para comparar dois cartões: NFD sem diacríticos,
 * minúsculas, espaços colapsados. É a mesma regra de busca acento-insensível do
 * resto do projeto, e aqui ela decide se um cartão novo é na verdade o cartão
 * que já está lá — "Corrigir a exportação" e "corrigir a exportacao" têm que
 * bater, senão o PO recria o mesmo cartão a cada turno.
 */
function normalizeTitle(text: string): string {
  return (text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Uma tarefa do registro (mcp__tasks), reduzida ao que o PO precisa: título e
 *  status. `done`/`failed` são evidência DURÁVEL de que algo aconteceu — ao
 *  contrário do histórico de ações, não se perde no teto de PO_MAX_CALLS
 *  quando o cooldown empurra a análise para muitos turnos à frente. */
export interface PoLedgerTask {
  title: string
  status: string
}

/** A fase é opcional e cai em `close` porque o fechamento é o PO que já existia:
 *  quem chamava antes da abertura existir continua recebendo o mesmo prompt. */
export function buildPoDigest(input: {
  userText: string
  cards: { id: string; title: string; status: BoardItemStatus }[]
  calls: PoCall[]
  phase?: PoPhase
  ledgerTasks?: PoLedgerTask[]
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
      : cards.map((card) => `${card.id} [${statusLabel(card.status)}] ${clamp(card.title, PO_MAX_TITLE_CHARS)}`))
  ]
  // Na abertura o turno ainda não aconteceu. Uma seção de ações sempre vazia só
  // ensinaria o modelo a procurar evidência que não existe — e evidência
  // imaginada é exatamente o erro que as barreiras tentam impedir.
  if ((input.phase ?? 'close') === 'close') {
    lines.push(
      '',
      'AÇÕES DESTE TURNO:',
      ...(calls.length === 0 ? ['(nenhuma)'] : calls.map((call) => `- ${call.tool}: ${call.detail}`))
    )
  }
  // Só aparece quando há algo a mostrar: uma seção vazia ensinaria o modelo a
  // esperar por uma fonte de evidência que não existe nesta conversa.
  const ledgerTasks = (input.ledgerTasks ?? []).slice(0, PO_MAX_LEDGER_TASKS)
  if (ledgerTasks.length > 0) {
    lines.push(
      '',
      'TAREFAS DO REGISTRO NESTA CONVERSA:',
      ...ledgerTasks.map((task) => `- ${clamp(task.title, PO_MAX_TITLE_CHARS)} [${task.status}]`)
    )
  }
  return lines.join('\n')
}

export function buildPoPrompt(input: Parameters<typeof buildPoDigest>[0]): string {
  const rules = input.phase === 'open' ? PO_SYSTEM_PROMPT_OPEN : PO_SYSTEM_PROMPT_CLOSE
  return `${rules}\n\n---\n\n${buildPoDigest(input)}`
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
 *
 * `phase` é a terceira: cada fase só aceita as operações que fazem sentido nela.
 * Um CONCLUIR numa análise de ABERTURA falaria de um trabalho que ainda nem
 * começou, e um ANDAMENTO no fechamento reabriria o que acabou de terminar —
 * nos dois casos o modelo respondeu a pergunta errada, e a resposta errada não
 * vira escrita. A fase cai em `close` quando não é informada: é o PO que já
 * existia antes da abertura.
 */
export function parsePoVerdict(raw: string, knownIds: Iterable<string>, phase: PoPhase = 'close'): PoOp[] {
  const ids = new Set(knownIds)
  const ops: PoOp[] = []
  const seen = new Set<string>()
  for (const line of (raw ?? '').split(/\r?\n/)) {
    if (ops.length >= PO_MAX_OPS) break
    const text = line.replace(/^[`\s>*-]+/, '').trim()
    if (!text || /^OK\b/i.test(text)) continue

    const complete = /^CONCLUIR\s+(\S+)\s*\|\s*(.+)$/i.exec(text)
    if (complete) {
      if (phase !== 'close') continue
      const [, id, reason] = complete
      if (!ids.has(id) || seen.has(`c:${id}`) || !reason.trim()) continue
      seen.add(`c:${id}`)
      ops.push({ kind: 'complete', id, reason: clamp(reason, 160) })
      continue
    }

    const start = /^ANDAMENTO\s+(\S+)\s*\|\s*(.+)$/i.exec(text)
    if (start) {
      if (phase !== 'open') continue
      const [, id, reason] = start
      if (!ids.has(id) || seen.has(`a:${id}`) || !reason.trim()) continue
      seen.add(`a:${id}`)
      ops.push({ kind: 'start', id, reason: clamp(reason, 160) })
      continue
    }

    const retitle = /^TITULO\s+(\S+)\s*\|\s*(.+)$/i.exec(text)
    if (retitle) {
      if (phase !== 'close') continue
      const [, id, title] = retitle
      if (!ids.has(id) || seen.has(`t:${id}`) || !title.trim()) continue
      seen.add(`t:${id}`)
      ops.push({ kind: 'retitle', id, title: clamp(title, PO_MAX_TITLE_CHARS) })
      continue
    }

    const create = /^(NOVA|FEITA)\s*\|\s*([^|]+)\|\s*(.+)$/i.exec(text)
    if (create) {
      const [, verb, title, reason] = create
      // FEITA é retroativo ("aconteceu neste turno"): só o fechamento tem turno
      // para olhar. Na abertura, o cartão nasce EM ANDAMENTO — o trabalho está
      // começando agora, não é uma intenção para depois nem coisa já feita.
      const done = verb.toUpperCase() === 'FEITA'
      if (done && phase !== 'close') continue
      if (!title.trim() || !reason.trim()) continue
      const clean = clamp(title, PO_MAX_TITLE_CHARS)
      const key = `n:${normalizeTitle(clean)}`
      if (seen.has(key)) continue
      seen.add(key)
      ops.push({
        kind: 'create',
        title: clean,
        reason: clamp(reason, 160),
        status: done ? 'completed' : phase === 'open' ? 'in_progress' : 'pending'
      })
    }
  }
  return ops
}

/**
 * Descarta (ou, num caso, TRANSFORMA) as operações que contrariam o esqueleto —
 * a última barreira antes do banco, e a que protege o invariante do recurso: o
 * PO corrige o que o agente esqueceu, não discute com o que o agente acabou de
 * dizer.
 *
 * A fase importa para um caso: um `create` rejeitado pelo dedupe de título, na
 * ABERTURA, contra um cartão existente que ainda está `pending`. Descartar em
 * silêncio perderia a intenção real do modelo ("isso está começando agora") —
 * e é exatamente essa perda que prende um cartão em "a fazer" enquanto o
 * trabalho de fato continua (o pedido virou uma continuação, "NOVA" colidiu
 * com o que já existe, e ninguém promoveu o cartão para `in_progress`). Em vez
 * de só rejeitar, convertemos em `start` no cartão colidido — uma garantia de
 * código, que não depende do modelo escolher a operação certa na próxima
 * rodada. No fechamento não existe ANDAMENTO, então a conversão não se aplica:
 * um `create`/`FEITA` duplicado ali continua simplesmente descartado, como
 * sempre foi.
 */
export function rejectUnsafeOps(ops: PoOp[], cards: BoardItem[], phase: PoPhase = 'close'): PoOp[] {
  const byId = new Map(cards.map((card) => [card.id, card]))
  // Os títulos que a conversa já tem, nas DUAS camadas: o cartão pode ter sido
  // renomeado pelo PO, e comparar só com o do agente deixaria passar a cópia.
  // `titleToCard` guarda o cartão por trás do título — só ele permite converter
  // um dedupe em `start`; um título que colide com outra operação desta MESMA
  // resposta (ainda sem cartão nenhum) não tem para onde converter.
  const titles = new Set<string>()
  const titleToCard = new Map<string, BoardItem>()
  for (const card of cards) {
    const sourceKey = normalizeTitle(card.sourceTitle)
    titles.add(sourceKey)
    titleToCard.set(sourceKey, card)
    if (card.poTitle) {
      const poKey = normalizeTitle(card.poTitle)
      titles.add(poKey)
      titleToCard.set(poKey, card)
    }
  }
  // Ids que já vão sair com `start` — seja porque o próprio modelo emitiu essa
  // operação nesta resposta, seja porque uma conversão anterior já a criou.
  // Sem isso, um segundo `create` duplicado para o mesmo cartão viraria um
  // segundo `start`, e `applyPo` seria chamado duas vezes à toa para o mesmo id.
  const startedIds = new Set(ops.filter((op) => op.kind === 'start').map((op) => op.id))

  const out: PoOp[] = []
  for (const op of ops) {
    if (op.kind === 'create') {
      // Sem esta barreira o PO recria o mesmo cartão a cada turno: ele não se
      // lembra do que criou ontem, e o quadro vira uma pilha de duplicatas que
      // ninguém sabe qual seguir. Um título só acrescenta trabalho ao quadro
      // quando ele é um trabalho NOVO.
      const title = normalizeTitle(op.title)
      if (!title) continue
      if (titles.has(title)) {
        const existing = titleToCard.get(title)
        if (
          phase === 'open' &&
          existing &&
          boardItemStatus(existing) === 'pending' &&
          !startedIds.has(existing.id)
        ) {
          startedIds.add(existing.id)
          out.push({ kind: 'start', id: existing.id, reason: op.reason })
        }
        continue
      }
      titles.add(title)
      out.push(op)
      continue
    }
    const card = byId.get(op.id)
    if (!card) continue
    if (op.kind === 'retitle') {
      if (op.title.trim() !== card.sourceTitle.trim()) out.push(op)
      continue
    }
    if (op.kind === 'start') {
      // Só entra em andamento o que ainda não começou: marcar de novo o que já
      // está em andamento é escrita à toa, e "reabrir" o que foi concluído é o
      // PO desfazendo um fato que o agente já registrou.
      if (boardItemStatus(card) === 'pending') out.push(op)
      continue
    }
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
    if (boardItemStatus(card) !== 'completed') out.push(op)
  }
  return out
}
