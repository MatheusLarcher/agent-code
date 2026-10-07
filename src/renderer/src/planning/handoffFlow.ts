/**
 * As peças do fluxo "Enviar para implementação" que não são tela: o pedido
 * fixo ao Agent Manager, o filtro dos prompts que ele gravou DEPOIS do pedido
 * e o lançamento da conversa de implementação. Puras e testáveis sem o App.
 */
import type { AgentCodeApi } from '@shared/api'
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
      '(TodoWrite/TaskCreate), cada item começando pelo id da etapa entre colchetes, [id-da-etapa] (ex.: "[pagamento] Integrar o checkout"), ' +
      `e consultar ${planDir} sem replanejar. A conversa de implementação só verá esse texto e os cards.`,
    '',
    'Etapas e estimativas: em cada chamada de mcp__planning__plan_handoff_write, informe em "etapas" os ids das etapas do roteiro que ' +
      'aquele prompt cobre, na ordem. No texto do prompt, traga a tabela etapa → estimativa (minutos de trabalho do agente, como estão no ' +
      'roteiro) e o total do prompt.',
    '',
    'Cada prompt também exige da implementação, sem exceção: ao começar cada etapa, registrar a própria estimativa com ' +
      'mcp__entregas__entrega_estimar e escrever "Etapa N — <título>: estimativa do plano X min (prazo), minha estimativa Z min"; ' +
      'ao concluir, consultar mcp__entregas__entrega_tempo e escrever "levou Y min de trabalho (dentro/fora do prazo)" e, se passou, o motivo. ' +
      'O prazo é a estimativa do plano; a do agente não o muda, e o tempo que vale é o medido pelo app.',
    '',
    'Não implemente nada e não altere cards nem o roteiro agora: só grave os prompts e, no fim, diga quantos gravou. Única exceção: etapa ' +
      'sem estimativa — estime-a antes com mcp__planning__plan_roteiro_set mandando a lista INTEIRA de etapas (o plan_roteiro_set substitui ' +
      'o roteiro todo: etapa que ficar de fora é apagada), iguais ao que estão, mudando só a estimativa que faltava, para a tabela bater com o roteiro.'
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
 *
 * As perguntas saem do ROTEIRO (etapa por etapa) e de pesquisa na web sobre o
 * que o usuário disse — não da memória do Manager, que declarava "nenhuma
 * pergunta" com etapas ainda pendentes.
 */
export function managerQuestionnaireRequest(): string {
  return (
    'Lance agora o questionário. Antes de perguntar, leia o plano com mcp__planning__plan_read e percorra o ' +
    'roteiro etapa por etapa: para cada etapa não concluída, levante o que o usuário ainda precisa decidir para ' +
    'ela poder ser implementada (decisões, dados, critérios de aceite, riscos), junto das ambiguidades abertas e ' +
    'das lacunas que você apontou. Com base no que o usuário já disse, pesquise na web (WebSearch/WebFetch) ' +
    'práticas, bibliotecas e limitações relevantes e transforme o que achar em perguntas com opções concretas. ' +
    "Faça-as com AskUserQuestion, até 4 por vez, com a sua recomendação como primeira opção e marcada '(Recomendado)'. " +
    'Depois de cada resposta, registre nos cards (decisão, ambiguidade resolvida), marque a etapa concluída com ' +
    'mcp__planning__plan_etapa_marcar quando ela ficar especificada e lance a próxima leva, até acabarem. ' +
    'Etapa que não precise de nada do usuário: diga por quê e marque-a concluída. Só diga ' +
    "'Nenhuma pergunta em aberto.' se todas as etapas do roteiro estiverem concluídas e não houver ambiguidade " +
    'aberta. Não implemente nada.'
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

/** Um prompt a enviar: o texto e, quando veio de _handoff/, o nome do arquivo. */
export interface HandoffPrompt {
  text: string
  name?: string
}

/** Prazo do registro no banco antes do 1º envio: banco travado não segura a conversa. */
export const HANDOFF_REGISTER_TIMEOUT_MS = 15_000

export interface HandoffLaunchDeps<C extends { id: string }> {
  /** Cria a conversa de implementação, ativa, e JÁ visível para o caminho de
   *  envio (estado e refs) — o envio logo abaixo não pode achar a conversa
   *  "inexistente" por esperar o próximo render. */
  create: () => C
  /** Caminho normal de envio. true = entregue (enviado agora ou na fila). */
  send: (conv: C, text: string) => Promise<boolean>
  /**
   * Registra o envio no banco (um envio `na_fila` por prompt, com as entregas):
   * chamado depois do `create` e ANTES do 1º `send`, com os prompts que vão
   * sair (já sem os em branco, cada um com o seu arquivo), na ordem. Falha —
   * exceção ou prazo estourado — não impede o envio: vai para `onRegisterError`.
   */
  register?: (conv: C, prompts: readonly HandoffPrompt[]) => Promise<void>
  onRegisterError?: (err: unknown) => void
  /** Prazo do `register`, em ms (padrão HANDOFF_REGISTER_TIMEOUT_MS). */
  registerTimeoutMs?: number
  /**
   * FILA DO QUADRO E DO PROJETO: com o registro no banco feito, nenhum prompt
   * sai pelo `send` — todos esperam como envios `na_fila`, e o despachante
   * (main) solta o 1º quando chegar a vez do plano na pasta (e a pasta estiver
   * limpa) e cada seguinte quando o anterior concluir. `kick` pede a primeira
   * conferência. Registro que falhou: todos pelo `send`, como antes (a fila do
   * chat), para nada se perder sem o banco.
   */
  queueInBoard?: boolean
  /** Com a fila do quadro: confere a fila da conversa nova (o 1º prompt sai daí). */
  kick?: (conv: C) => void
}

export interface HandoffLaunchResult<C> {
  conv: C | null
  /** Quantos prompts foram entregues, na ordem (os da fila do quadro contam). */
  delivered: number
  total: number
  /** Quantos ficaram na fila do quadro (0 sem ela). */
  queued?: number
}

async function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`o registro não respondeu em ${Math.round(ms / 1000)} s`)), ms)
  })
  try {
    await Promise.race([work, expired])
  } finally {
    clearTimeout(timer)
  }
}

async function registerSafely<C extends { id: string }>(
  conv: C,
  prompts: readonly HandoffPrompt[],
  deps: HandoffLaunchDeps<C>
): Promise<boolean> {
  const register = deps.register
  if (!register) return false
  try {
    // Promise.resolve().then: um register que lança SÍNCRONO também é falha, não exceção.
    await withTimeout(
      Promise.resolve().then(() => register(conv, prompts)),
      deps.registerTimeoutMs ?? HANDOFF_REGISTER_TIMEOUT_MS
    )
    return true
  } catch (err) {
    try {
      deps.onRegisterError?.(err)
    } catch {
      // O aviso não pode derrubar o envio.
    }
    return false
  }
}

/**
 * Cria a conversa, registra o envio (`register`) e entrega os prompts NA ORDEM:
 * com a fila do quadro (`queueInBoard`, registro feito), todos esperam no banco
 * e o despachante solta um por vez (`kick` pede a 1ª conferência); sem ela, vão
 * pelo `send` (com a conversa ocupada, entram na fila do chat). Se um envio
 * falha (false ou exceção), os seguintes não são tentados — ficariam fora de
 * ordem (estão gravados em _handoff/). Prompt em branco é descartado; sem
 * nenhum, nada é criado. `prompts`: texto puro ou `{ text, name }` — o par
 * texto↔arquivo é feito ANTES do filtro, para o nome não escorregar de prompt.
 */
export async function launchHandoff<C extends { id: string }>(
  prompts: readonly (string | HandoffPrompt)[],
  deps: HandoffLaunchDeps<C>
): Promise<HandoffLaunchResult<C>> {
  const items = prompts
    .map((p): HandoffPrompt => (typeof p === 'string' ? { text: p } : p))
    .filter((p) => p.text.trim() !== '')
  if (items.length === 0) return { conv: null, delivered: 0, total: 0 }
  const conv = deps.create()
  const registered = await registerSafely(conv, items, deps)
  const texts = items.map((p) => p.text)
  // Fila do quadro e do projeto: o despachante solta até o 1º (a vez do plano na pasta).
  if (deps.queueInBoard && registered) {
    try {
      deps.kick?.(conv)
    } catch {
      // A conferência volta no próximo aviso do main (handoff:changed) ou na abertura.
    }
    return { conv, delivered: texts.length, total: texts.length, queued: texts.length }
  }
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
  /** Quantos esperam na fila do quadro (saem um a um, com o anterior concluído). */
  queued?: number
}

export function handoffOutcome(res: HandoffLaunchResult<{ id: string; title: string }>): HandoffSendOutcome {
  const { delivered, total } = res
  if (!res.conv) return { status: 'not-created', delivered, total }
  return {
    status: delivered === total ? 'sent' : 'created-failed',
    delivered,
    total,
    conversation: { id: res.conv.id, title: res.conv.title },
    ...(res.queued ? { queued: res.queued } : {})
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

/** Teto do título da conversa no registro (o IPC aceita até 500). */
const MAX_REGISTER_TITLE = 500

/**
 * O `register` do launchHandoff ligado ao IPC handoff:register: cada prompt vai
 * com o arquivo de _handoff/ dele (o main lê ali as etapas declaradas). Falha
 * do main vira exceção — o launchHandoff a entrega ao `onRegisterError`.
 */
export function handoffRegistrar(
  api: Pick<AgentCodeApi, 'handoffRegister'>,
  projectCwd: string,
  slug: string
): (conv: { id: string; title: string }, prompts: readonly HandoffPrompt[]) => Promise<void> {
  return async (conv, prompts) => {
    const pairs = prompts.flatMap((p) => (p.name ? [{ arquivo: p.name, conteudo: p.text }] : []))
    if (pairs.length === 0) return
    const res = await api.handoffRegister({
      projectCwd,
      slug,
      conversationId: conv.id,
      conversationTitle: conv.title.slice(0, MAX_REGISTER_TITLE).trim() || 'Implementação',
      prompts: pairs
    })
    if (!res || res.ok !== true) {
      throw new Error(res && 'message' in res ? res.message : 'resposta inválida do processo principal')
    }
  }
}

/** O toast de quando o registro no banco falhou (o envio seguiu mesmo assim). */
export function handoffRegisterWarning(err: unknown): string {
  return (
    'O envio para a implementação seguiu, mas não consegui registrá-lo no banco — ' +
    `este envio fica sem o acompanhamento de status e prazo: ${errText(err)}`
  )
}
