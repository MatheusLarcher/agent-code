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

/** A decisão do despachante para uma conversa. */
export type HandoffQueueDecision =
  | { kind: 'next'; envio: HandoffQueuedPrompt }
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

/** O envio que o usuário tirou da fila: nem saiu nem espera mais a vez. */
export function isEnvioRemoved(envio: Pick<HandoffEnvio, 'status' | 'enviadoEm' | 'motivo'>): boolean {
  return envio.status === 'parada' && envio.enviadoEm === null && envio.motivo === HANDOFF_REMOVED_MOTIVO
}

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

function parseMs(iso: string | null | undefined): number | null {
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
