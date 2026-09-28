/**
 * As peças do fluxo "Enviar para implementação" que não são tela: o pedido
 * fixo ao Agent Manager, o filtro dos prompts que ele gravou DEPOIS do pedido
 * e o lançamento da conversa de implementação. Puras e testáveis sem o App.
 */
import type {
  PlanningFailure,
  PlanningHandoffDto,
  PlanningHandoffSentDto,
  PlanningHandoffSentMark,
  PlanningResult
} from '@shared/ipc'

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function failureText(f: PlanningFailure): string {
  return 'message' in f ? f.message : 'conflito de versão'
}

/** IPC que rejeita vira falha 'io', não exceção. */
export async function safe<T extends object>(call: () => Promise<PlanningResult<T>>): Promise<PlanningResult<T>> {
  try {
    const res = await call()
    if (res && typeof res === 'object' && 'ok' in res) return res
    return { ok: false, code: 'io', message: 'resposta inválida do processo principal' }
  } catch (err) {
    return { ok: false, code: 'io', message: errText(err) }
  }
}

/** Folga para a resolução do relógio do sistema de arquivos (FAT: 2 s). */
export const HANDOFF_CLOCK_SLACK_MS = 2_000

/**
 * O pedido que vai para a conversa de planejamento (pelo caminho normal de
 * envio): gerar o handoff com plan_handoff_write, um ou mais prompts
 * autocontidos. Com ambiguidades abertas (o usuário escolheu enviar mesmo
 * assim), o Manager é avisado para registrar a leitura recomendada.
 *
 * `planDir` é a pasta ABSOLUTA do plano, como o main a informou (plan.dir):
 * o renderer não a monta. Com mídia no plano (`mediaCount` > 0), o Manager é
 * instruído a pôr em cada prompt o caminho absoluto + tipo das mídias que ele
 * usa — a conversa de implementação não vê o plano, só o texto.
 */
export function managerHandoffRequest(planDir: string, openAmbiguities = 0, mediaCount = 0): string {
  const lines = [
    'Gere agora o handoff deste planejamento para a conversa de implementação.',
    '',
    'Grave com mcp__planning__plan_handoff_write UM OU MAIS prompts autocontidos — um arquivo por prompt, na ordem em que devem ser executados. ' +
      'Divida em mais de um só se o trabalho não couber numa conversa: cada prompt vai numa mensagem, e o seguinte só roda quando o anterior terminar.',
    '',
    'Cada prompt precisa trazer: o objetivo; as etapas do roteiro na ordem, com os cards de cada uma; os requisitos; as decisões com o porquê; ' +
      'as sugestões com a fonte; as ambiguidades resolvidas; riscos e critérios de aceite; e a instrução de declarar as etapas como plano ' +
      `(TodoWrite/TaskCreate) e consultar ${planDir} sem replanejar. A conversa de implementação só verá esse texto e os cards.`,
    '',
    'Não implemente nada e não altere cards nem o roteiro agora: só grave os prompts e, no fim, diga quantos gravou.'
  ]
  if (mediaCount > 0) {
    const n = mediaCount === 1 ? 'uma mídia' : `${mediaCount} mídias`
    lines.push(
      '',
      `Mídia: o plano tem ${n} em midia/ (o plan_read lista o tipo e o caminho absoluto de cada uma). ` +
        'Em cada prompt, inclua o CAMINHO ABSOLUTO e o TIPO de toda mídia relevante ao que ele pede, no formato ' +
        '"[Tipo] nome — caminho absoluto", e mande abri-la com Read (imagem e PDF o Read mostra de verdade). ' +
        'Nome solto ou caminho relativo não serve: a conversa de implementação não acharia o arquivo.'
    )
  }
  if (openAmbiguities > 0) {
    const n = openAmbiguities === 1 ? 'Uma ambiguidade continua aberta' : `${openAmbiguities} ambiguidades continuam abertas`
    lines.push(
      '',
      `Atenção: ${n} e o usuário decidiu enviar mesmo assim. Em cada prompt, diga qual leitura seguir (a sua recomendação) e marque-a como pendente de confirmação do usuário.`
    )
  }
  return lines.join('\n')
}

/**
 * Os prompts que surgiram em _handoff/ depois do pedido: nome que não existia
 * antes dele E criado a partir dele (com folga para o relógio do disco). Na
 * ordem em que vieram da lista (a do main, por nome).
 */
export function newHandoffsSince(
  list: readonly PlanningHandoffDto[],
  before: ReadonlySet<string>,
  requestedAt: number
): PlanningHandoffDto[] {
  return list.filter((h) => !before.has(h.name) && h.createdAt >= requestedAt - HANDOFF_CLOCK_SLACK_MS)
}

/**
 * O pedido do botão "Iniciar questionário" (chat do Agent Manager): lançar
 * como AskUserQuestion as perguntas em aberto do plano, em levas, e registrar
 * as respostas nos cards. Vai pelo caminho normal de envio (fila, se ocupado).
 */
export function managerQuestionnaireRequest(): string {
  return (
    'Lance agora o questionário: reúna todas as perguntas em aberto deste planejamento (ambiguidades abertas, ' +
    'decisões pendentes, lacunas que você apontou) e faça-as com AskUserQuestion, até 4 por vez, com a sua ' +
    "recomendação como primeira opção e marcada '(Recomendado)'. Depois de cada resposta, registre nos cards " +
    '(decisão, ambiguidade resolvida) e lance a próxima leva, até acabarem. Sem perguntas em aberto, diga só ' +
    "'Nenhuma pergunta em aberto.' Não implemente nada."
  )
}

/**
 * Os prompts "a enviar": os de _handoff/ sem registro em enviados.json
 * (enviado, substituído por um editado ou marcado à mão). Sem registro nenhum
 * (plano antigo, ou enviados.json ilegível), todos. Na ordem da lista do main,
 * que é a dos nomes (AAAA-MM-DD-NN) — a ordem de envio.
 */
export function pendingHandoffs(
  list: readonly PlanningHandoffDto[],
  sent: readonly PlanningHandoffSentDto[]
): PlanningHandoffDto[] {
  const done = new Set(sent.map((e) => e.nome))
  return list.filter((h) => !done.has(h.name))
}

/** O que gravar em enviados.json depois do envio: só os `delivered` primeiros
 *  prompts (os que a conversa recebeu), ligados a ela. */
export function deliveredMarks(names: readonly string[], outcome: HandoffSendOutcome): PlanningHandoffSentMark[] {
  const conv = outcome.conversation
  if (!conv || outcome.delivered <= 0) return []
  return names
    .slice(0, outcome.delivered)
    .map((nome) => ({ nome, conversaId: conv.id, conversaTitulo: conv.title }))
}

/**
 * Onde o diálogo estava (passo, pedido em espera, prompts em revisão), por
 * plano, enquanto o app estiver aberto: fechar o diálogo — Esc, clique fora —
 * não perde o que o Agent Manager está gerando nem o que foi editado.
 */
export interface HandoffSession<D> {
  step: 'review' | 'waiting' | 'prompts'
  waiting: { requestedAt: number; before: Set<string> } | null
  drafts: D[]
}

const sessions = new Map<string, HandoffSession<unknown>>()
const sessionKey = (projectCwd: string, slug: string): string => `${projectCwd}\n${slug}`

export function loadHandoffSession<D>(projectCwd: string, slug: string): HandoffSession<D> | null {
  return (sessions.get(sessionKey(projectCwd, slug)) as HandoffSession<D> | undefined) ?? null
}

/** `review` sem pedido em espera nem prompts em revisão é o estado inicial: não
 *  é guardado, e a próxima abertura decide de novo (abre direto nos pendentes). */
export function saveHandoffSession<D>(projectCwd: string, slug: string, s: HandoffSession<D>): void {
  if (s.step === 'review' && !s.waiting && s.drafts.length === 0) sessions.delete(sessionKey(projectCwd, slug))
  else sessions.set(sessionKey(projectCwd, slug), s)
}

export function clearHandoffSession(projectCwd: string, slug: string): void {
  sessions.delete(sessionKey(projectCwd, slug))
}

export interface HandoffLaunchDeps<C extends { id: string }> {
  /** Cria a conversa de implementação, ativa, e JÁ visível para o caminho de
   *  envio (estado e refs) — o envio logo abaixo não pode achar a conversa
   *  "inexistente" por esperar o próximo render. */
  create: () => C
  /** Caminho normal de envio. true = entregue (enviado agora ou na fila). */
  send: (conv: C, text: string) => Promise<boolean>
}

export interface HandoffLaunchResult<C> {
  conv: C | null
  /** Quantos prompts foram entregues, na ordem. */
  delivered: number
  total: number
}

/**
 * Cria a conversa e envia os prompts NA ORDEM: o 1º sai já; os seguintes, com a
 * conversa ocupada, entram na fila dela. Se um envio falha (false ou exceção),
 * os seguintes não são tentados — ficariam fora de ordem (estão gravados em
 * _handoff/). Prompt em branco é descartado; sem nenhum, nada é criado.
 */
export async function launchHandoff<C extends { id: string }>(
  prompts: readonly string[],
  deps: HandoffLaunchDeps<C>
): Promise<HandoffLaunchResult<C>> {
  const texts = prompts.filter((p) => p.trim() !== '')
  if (texts.length === 0) return { conv: null, delivered: 0, total: 0 }
  const conv = deps.create()
  let delivered = 0
  for (const text of texts) {
    // Depois de criada, a conversa existe: uma exceção no envio não pode
    // subir como "nada aconteceu" (o diálogo deixaria criar outra).
    let ok = false
    try {
      ok = await deps.send(conv, text)
    } catch {
      ok = false
    }
    if (!ok) break
    delivered++
  }
  return { conv, delivered, total: texts.length }
}

/**
 * O resultado do envio visto pelo diálogo:
 * - `sent`: conversa criada e todos os prompts entregues;
 * - `created-failed`: a conversa FOI criada, mas um envio falhou. Tentar de
 *   novo pelo diálogo criaria uma SEGUNDA conversa; o caminho é o "Tentar de
 *   novo" da mensagem que falhou, na conversa nova;
 * - `not-created`: nada foi criado (nenhum prompt com texto).
 */
export interface HandoffSendOutcome {
  status: 'sent' | 'created-failed' | 'not-created'
  delivered: number
  total: number
  /** A conversa criada (ausente em `not-created`): vai para enviados.json. */
  conversation?: { id: string; title: string }
}

export function handoffOutcome(res: HandoffLaunchResult<{ id: string; title: string }>): HandoffSendOutcome {
  const { delivered, total } = res
  if (!res.conv) return { status: 'not-created', delivered, total }
  return {
    status: delivered === total ? 'sent' : 'created-failed',
    delivered,
    total,
    conversation: { id: res.conv.id, title: res.conv.title }
  }
}

/** O toast de uma conversa criada cujo envio não terminou. */
export function handoffPartialMessage(titulo: string, outcome: HandoffSendOutcome): string {
  const rest = outcome.total - outcome.delivered - 1
  return (
    `A conversa "Implementação: ${titulo}" foi criada, mas o envio parou no prompt ${outcome.delivered + 1} de ${outcome.total}. ` +
    'Abra essa conversa e use "Tentar de novo" na mensagem que falhou' +
    (rest > 0
      ? `; ${rest === 1 ? 'o prompt seguinte está' : `os ${rest} prompts seguintes estão`} em _handoff/, para mandar depois`
      : '') +
    '. Enviar de novo por aqui criaria outra conversa.'
  )
}
