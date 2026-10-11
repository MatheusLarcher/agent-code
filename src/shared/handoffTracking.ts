/**
 * Registro dos prompts de handoff mandados a conversas de implementação.
 *
 * Vocabulário: ENVIO = um prompt de handoff mandado a uma conversa. ENTREGA =
 * uma etapa do roteiro dentro de um envio (é ela que tem estimativa, prazo e
 * status). Os tempos são milissegundos inteiros (a contagem é incremental, em
 * fatias de segundos); as estimativas são minutos inteiros. A tela converte.
 *
 * Datas em ISO 8601 (UTC), iguais nos dois backends.
 */

export const HANDOFF_ENVIO_STATUSES = [
  'na_fila',
  'enviado',
  'em_execucao',
  'aguardando_voce',
  'parada',
  'falhou',
  'incompleta',
  'concluida'
] as const
export type HandoffEnvioStatus = (typeof HANDOFF_ENVIO_STATUSES)[number]

export const HANDOFF_ENTREGA_STATUSES = ['pendente', 'em_andamento', 'concluida', 'incompleta'] as const
export type HandoffEntregaStatus = (typeof HANDOFF_ENTREGA_STATUSES)[number]

export interface HandoffEntrega {
  id: string
  envioId: string
  etapaId: string
  etapaTitulo: string
  ordem: number
  /** Minutos, congelada no envio = PRAZO. */
  estimativaPlano: number | null
  /** Minutos, dada pela implementação; não muda o prazo. */
  estimativaAgente: number | null
  estimativaAgenteMotivo: string | null
  estimativaAgenteEm: string | null
  status: HandoffEntregaStatus
  atrasada: boolean
  motivo: string | null
  boardItemId: string | null
  /** PO ligado na conclusão; `null` = ainda não concluída. */
  auditada: boolean | null
  corrigidoPor: 'usuario' | null
  corrigidoEm: string | null
  iniciadaEm: string | null
  concluidaEm: string | null
  tempoAtivoMs: number
  tempoCorridoMs: number | null
  retrabalhoMs: number
  /** Aviso de prazo, uma vez por marco. */
  aviso80Em: string | null
  aviso100Em: string | null
  updatedAt: string
}

export interface HandoffEnvio {
  id: string
  planSlug: string
  planTitulo: string
  projectId: string
  projectCwd: string
  conversationId: string
  conversationTitle: string
  arquivo: string
  ordem: number
  loteId: string
  conteudo: string
  conteudoHash: string
  status: HandoffEnvioStatus
  motivo: string | null
  /** Soma das `estimativaPlano` das entregas; `null` sem nenhuma. */
  estimativaTotal: number | null
  prazoTotal: number | null
  atrasado: boolean
  tempoAtivoMs: number
  retrabalhoMs: number
  criadoEm: string
  enviadoEm: string | null
  iniciadoEm: string | null
  concluidoEm: string | null
  updatedAt: string
  /** Por `ordem`. */
  entregas: HandoffEntrega[]
}

// ---------------------------------------------------------------------------
// A FILA DO QUADRO: os prompts 2..N de um envio esperam aqui (envios que ainda
// não saíram), e uma regra fixa no main decide quando o próximo sai.
// ---------------------------------------------------------------------------

/** Um prompt que ainda não saiu, como o despachante o manda (pelo id). */
export interface HandoffQueuedPrompt {
  id: string
  conversationId: string
  loteId: string
  ordem: number
  arquivo: string
  conteudo: string
}

/** A decisão do despachante para uma conversa. `retomada`: o MESMO envio
 *  anterior, que parou por inatividade, sai de novo com o pedido de continuar. */
export type HandoffQueueDecision =
  | { kind: 'next'; envio: HandoffQueuedPrompt; retomada?: true }
  | { kind: 'hold'; envio: HandoffQueuedPrompt; motivo: string }
  | { kind: 'none' }

/** O estado de um prompt na fila: esperando a vez, parada (com motivo), segurada
 *  pelo PO ou rotina autorizada (commit/push) — os dois últimos vêm no prompt 3. */
export type HandoffQueueState = 'esperando' | 'parada' | 'segurada' | 'rotina'

/** Um prompt na fila, para a faixa "Próximos prompts" (por pasta de projeto). */
export interface HandoffQueueItem {
  envioId: string
  conversationId: string
  conversationTitle: string
  projectCwd: string
  planSlug: string
  planTitulo: string
  loteId: string
  ordem: number
  arquivo: string
  estado: HandoffQueueState
  motivo: string | null
  /** Soma das estimativas do plano das etapas do prompt (minutos); `null` sem nenhuma. */
  estimativaTotal: number | null
  /** A posição do plano na fila do projeto (1 = a vez); ausente fora dela. */
  planPosicao?: number
  /** As etapas do roteiro que o prompt cobre, na ordem. */
  etapas: { id: string; titulo: string }[]
  /** Quantos prompts o plano tem (o "de 3" de "Prompt 2 de 3"), tirados da fila fora. */
  totalPrompts: number
  /** O texto que vai sair (Ver/editar). */
  conteudo: string
}

/** "Tirar da fila": o envio sai com este motivo (o arquivo em `_handoff/` fica).
 *  Fica `parada` e sem `enviadoEm` — sem status novo no banco compartilhado. */
export const HANDOFF_REMOVED_MOTIVO = 'tirado da fila por você'

/** A conversa foi apagada: todo envio dela que não concluiu para com este motivo
 *  (o nunca enviado conta como tirado da fila) e o plano sai da fila do projeto. */
export const HANDOFF_CONVERSATION_DELETED_MOTIVO = 'a conversa foi apagada'

export function isEnvioOfDeletedConversation(envio: Pick<HandoffEnvio, 'status' | 'motivo'>): boolean {
  return envio.status === 'parada' && envio.motivo === HANDOFF_CONVERSATION_DELETED_MOTIVO
}

/** O envio que o usuário tirou da fila (ou cuja conversa foi apagada antes de ele sair): nem saiu nem espera mais a vez. */
export function isEnvioRemoved(envio: Pick<HandoffEnvio, 'status' | 'enviadoEm' | 'motivo'>): boolean {
  return (
    envio.status === 'parada' &&
    envio.enviadoEm === null &&
    (envio.motivo === HANDOFF_REMOVED_MOTIVO || envio.motivo === HANDOFF_CONVERSATION_DELETED_MOTIVO)
  )
}

/** A sessão morreu com o turno aberto (descarte, lease perdido, troca de sessão):
 *  sem `result`, o envio que rodava fica parado por INATIVIDADE — a fila retoma sozinha. */
export const HANDOFF_SESSION_ENDED_MOTIVO = 'a sessão encerrou no meio do turno, sem resultado'

/**
 * O envio parou por INATIVIDADE (o vigia do acompanhamento, handoffRules.stallReason):
 * nenhum turno rodando há N min. É o único `parada` que a fila retoma sozinha;
 * o Stop do usuário e o "tirar da fila" esperam você.
 */
export function isStallMotivo(motivo: string | null | undefined): boolean {
  const m = motivo ?? ''
  return (
    m === HANDOFF_SESSION_ENDED_MOTIVO ||
    /^o prompt ficou \d+ min na fila sem ser enviado$/u.test(m) ||
    /^o prompt foi enviado, mas nenhum turno começou em \d+ min$/u.test(m) ||
    /^esperava você, mas não há pergunta aberta nem turno rodando há \d+ min$/u.test(m) ||
    /^nenhum turno rodando há \d+ min, sem pergunta pendente e sem conclusão$/u.test(m)
  )
}

/**
 * Channels.handoffQueueUndispatch (main: handoffQueueIpc.ts): o despacho do
 * renderer falhou DEPOIS da marca "despachado" — o envio volta para a fila.
 * `undone: false` = já não cabia desfazer (o turno começou, ou outro estado).
 * O tipo mora aqui, e não em shared/api.ts, para a tela e o preload lerem o
 * mesmo contrato sem alterar a interface AgentCodeApi.
 */
export interface HandoffQueueUndispatchRequest {
  conversationId: string
  envioId: string
}
export type HandoffQueueUndispatchResult = { ok: true; undone: boolean } | { ok: false; message: string }
export interface HandoffQueueUndispatchApi {
  handoffQueueUndispatch(req: HandoffQueueUndispatchRequest): Promise<HandoffQueueUndispatchResult>
}

/** O incompleto que veio de um ERRO do turno (API caiu, sobrecarga): o motivo
 *  começa com este prefixo (o mesmo de handoffRules.TURN_ERROR_PREFIX). Erro de
 *  verdade segura a fila — mandar o próximo prompt para uma API que caiu não adianta. */
export const TURN_ERROR_MOTIVO_PREFIX = 'o turno terminou com erro'

export function isTurnErrorMotivo(motivo: string | null | undefined): boolean {
  return (motivo ?? '').startsWith(TURN_ERROR_MOTIVO_PREFIX)
}

/** O anterior ficou incompleto SEM erro do turno: a fila segue com a pendência na frente. */
export function isIncompleteWithoutError(envio: Pick<HandoffEnvio, 'status' | 'motivo'>): boolean {
  return envio.status === 'incompleta' && !isTurnErrorMotivo(envio.motivo)
}

/** A posição de um envio no lote dele (1-based) e o total de prompts do lote. */
export function envioPosition(envios: readonly HandoffEnvio[], envio: Pick<HandoffEnvio, 'id' | 'loteId'>): { n: number; m: number } {
  const lote = envios
    .filter((e) => e.loteId === envio.loteId && !isRoutineEnvio(e) && !isEnvioRemoved(e))
    .sort((a, b) => a.ordem - b.ordem || a.id.localeCompare(b.id))
  const index = lote.findIndex((e) => e.id === envio.id)
  return { n: index + 1 || 1, m: Math.max(lote.length, 1) }
}

/** O que a retomada manda à conversa (o mesmo envio, que parou por inatividade). */
export const HANDOFF_RESUME_TEXT =
  'Continue de onde parou. Não repita o que já está feito; retome do último item em andamento do seu plano e termine.'

/** "SEGURAR" do PO: o próximo prompt espera, com o motivo depois deste prefixo. */
export const HANDOFF_PO_HOLD_PREFIX = 'o PO segurou: '

/** O próximo prompt que o PO segurou (a resposta do agente contradiz uma premissa dele). */
export function isEnvioHeldByPo(envio: Pick<HandoffEnvio, 'status' | 'motivo'>): boolean {
  return envio.status === 'na_fila' && (envio.motivo ?? '').startsWith(HANDOFF_PO_HOLD_PREFIX)
}

/**
 * O item de ROTINA da fila: o commit (e push) que o PO está autorizado a mandar
 * sozinho. Um envio sem arquivo em `_handoff/`, na frente dos prompts, com o
 * texto fixo montado pelo código.
 */
export const HANDOFF_ROUTINE_FILE = 'rotina-po'

/** O "Mandar fazer" do "Fala, PO": um plano "Pedido do PO", sem etapas do roteiro. */
export const PO_REQUEST_FILE = 'pedido-po'

/** A entrega do "Pedido do PO" liga direto ao cartão citado: `card:<id>` no lugar do id da etapa. */
export const CARD_ETAPA_PREFIX = 'card:'

export function isPoRequestEnvio(envio: Pick<HandoffEnvio, 'arquivo'>): boolean {
  return envio.arquivo === PO_REQUEST_FILE
}

export function isRoutineEnvio(envio: Pick<HandoffEnvio, 'arquivo'>): boolean {
  return envio.arquivo === HANDOFF_ROUTINE_FILE
}

// ---------------------------------------------------------------------------
// Regras ÚNICAS que o main (acompanhamento, ferramentas entrega_*) e a tela
// (indicador de prazo) leem do mesmo jeito.
// ---------------------------------------------------------------------------

/** Uma data ISO em ms; `null` sem data ou inválida. */
export function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/** Já saiu para a conversa. O `parada` sem `enviadoEm` é o que encalhou na fila. */
export function isEnvioSent(envio: HandoffEnvio): boolean {
  return envio.enviadoEm !== null || (envio.status !== 'na_fila' && envio.status !== 'parada')
}

/**
 * O envio CORRENTE da conversa: o mais recente que já saiu. É a ele que o turno,
 * a pergunta e o tempo pertencem — a fila da tela só manda o prompt seguinte
 * quando o turno anterior acaba, então nunca há dois rodando.
 */
export function currentEnvio(envios: readonly HandoffEnvio[]): HandoffEnvio | null {
  let best: HandoffEnvio | null = null
  let bestAt = -Infinity
  for (const envio of envios) {
    if (!isEnvioSent(envio)) continue
    const at = parseMs(envio.enviadoEm) ?? parseMs(envio.criadoEm) ?? 0
    if (!best || at > bestAt || (at === bestAt && envio.ordem > best.ordem)) {
      best = envio
      bestAt = at
    }
  }
  return best
}

/** A etapa ATUAL do envio: a primeira em andamento; sem nenhuma, a primeira não
 *  concluída; todas concluídas (ou envio sem entregas), `null`. */
export function currentEntrega(envio: HandoffEnvio | null): HandoffEntrega | null {
  if (!envio) return null
  const byOrdem = [...envio.entregas].sort((a, b) => a.ordem - b.ordem)
  return byOrdem.find((e) => e.status === 'em_andamento') ?? byOrdem.find((e) => e.status !== 'concluida') ?? null
}

/** Marco de alerta do prazo: 80% (o mesmo do aviso ao agente). */
export const DEADLINE_ALERT_RATIO = 0.8

/**
 * Onde o tempo ativo está em relação ao prazo (a estimativa do plano):
 * `ok` < 80% ≤ `alerta` ≤ 100% < `estourado`. Exatamente no prazo ainda é
 * "dentro do prazo"; só passar dele atrasa. Sem prazo, `neutro`.
 */
export type DeadlineLevel = 'neutro' | 'ok' | 'alerta' | 'estourado'

export function deadlineLevel(tempoAtivoMs: number, prazoMin: number | null): DeadlineLevel {
  if (prazoMin === null || !(prazoMin > 0)) return 'neutro'
  const ratio = Math.max(0, tempoAtivoMs) / (prazoMin * 60_000)
  if (ratio > 1) return 'estourado'
  return ratio >= DEADLINE_ALERT_RATIO ? 'alerta' : 'ok'
}

/**
 * Tempo ativo em minutos INTEIROS, arredondado para cima: assim "levou Y min"
 * e "dentro/fora do prazo" nunca discordam (⌈t⌉ ≤ X ⟺ t ≤ X para X inteiro).
 */
export function tempoAtivoMinutos(ms: number): number {
  return Math.ceil(Math.max(0, ms) / 60_000)
}

/** Dentro do prazo = tempo ativo até a estimativa do plano, inclusive. `null` sem prazo. */
export function withinDeadline(tempoAtivoMs: number, prazoMin: number | null): boolean | null {
  if (prazoMin === null || !(prazoMin > 0)) return null
  return Math.max(0, tempoAtivoMs) <= prazoMin * 60_000
}
