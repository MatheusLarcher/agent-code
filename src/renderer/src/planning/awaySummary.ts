import { boardItemAwaitingBadge, boardItemStatus, boardItemTitle, type BoardItem } from '@shared/ipc'
import { isEnvioRemoved, isRoutineEnvio, type HandoffEnvio } from '@shared/handoffTracking'

/**
 * O RESUMO "DESDE QUE VOCÊ SAIU", por projeto — regra fixa, sem modelo, sobre o
 * que já está no banco. A última visita é a última vez que o quadro ou uma
 * conversa do projeto esteve aberta com a janela em foco (gravada neste PC, ver
 * awayVisits.ts). Ao voltar depois de 30 min ou mais, e só se algo mudou nesse
 * meio-tempo (tudo com `updatedAt` depois da última visita):
 * - concluídas: cartões que viraram concluídos;
 * - espera você: cartões com o selo "Aguardando você"/"Interrompido" (o mesmo
 *   contador da aba do Quadro);
 * - falhou: envios `falhou`/`parada` (menos o que você mesmo tirou da fila) e a
 *   fila parada — o envio incompleto com prompts esperando atrás dele, a mesma
 *   regra do aviso "A fila parou" (deliveryChanges.ts).
 * Nada mudou → `null`, e nada aparece.
 */

export const AWAY_MIN_MS = 30 * 60_000

export type AwayKind = 'concluida' | 'espera' | 'falhou'

export interface AwayEntry {
  kind: AwayKind
  /** O cartão que o clique abre; `null` no envio sem cartão ligado (o clique abre a conversa). */
  cardId: string | null
  conversationId: string
  title: string
  /** O motivo da espera ou da falha. */
  detail: string | null
  /** Quando mudou (ms) — a lista vem do mais recente para o mais antigo. */
  at: number
}

export interface AwaySummary {
  projectKey: string
  projectCwd: string
  /** A última visita (ms) e quanto tempo você ficou fora. */
  since: number
  awayMs: number
  counts: Record<AwayKind, number>
  entries: AwayEntry[]
}

export interface AwayInput {
  projectKey: string
  projectCwd: string
  /** Cartões do projeto inteiro (todas as conversas). */
  items: readonly BoardItem[]
  envios: readonly HandoffEnvio[]
  since: number
  now: number
}

const KIND_ORDER: readonly AwayKind[] = ['concluida', 'espera', 'falhou']

function stamp(iso: string | null | undefined): number {
  const ms = Date.parse(iso ?? '')
  return Number.isFinite(ms) ? ms : 0
}

function promptsWaiting(envios: readonly HandoffEnvio[], conversationId: string): number {
  return envios.filter((e) => e.conversationId === conversationId && e.status === 'na_fila' && !isEnvioRemoved(e)).length
}

function envioTitle(envio: HandoffEnvio, envios: readonly HandoffEnvio[]): string {
  if (isRoutineEnvio(envio)) return `Rotina do PO: ${envio.conteudo}`
  const total = envios.filter((e) => e.loteId === envio.loteId && !isRoutineEnvio(e)).length
  return `Prompt ${envio.ordem} de ${Math.max(total, envio.ordem)} — ${envio.planTitulo}`
}

function waitingText(n: number): string {
  return n === 1 ? '1 prompt espera no quadro' : `${n} prompts esperam no quadro`
}

/** O que falhou: o envio que falhou/parou, ou a fila que parou atrás de um incompleto. */
function envioEntry(envio: HandoffEnvio, envios: readonly HandoffEnvio[]): AwayEntry | null {
  const failed = envio.status === 'falhou' || (envio.status === 'parada' && !isEnvioRemoved(envio))
  const waiting = promptsWaiting(envios, envio.conversationId)
  if (!failed && !(envio.status === 'incompleta' && waiting > 0)) return null
  const reason = failed ? envio.motivo : 'a fila parou'
  const detail = [reason, waiting > 0 ? waitingText(waiting) : null].filter(Boolean).join(' — ')
  return {
    kind: 'falhou',
    cardId: envio.entregas.find((e) => e.boardItemId)?.boardItemId ?? null,
    conversationId: envio.conversationId,
    title: envioTitle(envio, envios),
    detail: detail || null,
    at: stamp(envio.updatedAt)
  }
}

function itemEntry(item: BoardItem): AwayEntry | null {
  if (item.dismissedAt !== null) return null
  const base = { cardId: item.id, conversationId: item.conversationId, title: boardItemTitle(item), at: stamp(item.updatedAt) }
  if (boardItemStatus(item) === 'completed') return { ...base, kind: 'concluida', detail: null }
  const badge = boardItemAwaitingBadge(item)
  return badge ? { ...base, kind: 'espera', detail: badge.label } : null
}

export function buildAwaySummary(input: AwayInput): AwaySummary | null {
  const { since, now } = input
  if (!Number.isFinite(since) || now - since < AWAY_MIN_MS) return null
  const entries: AwayEntry[] = []
  for (const item of input.items) {
    if (stamp(item.updatedAt) <= since) continue
    const entry = itemEntry(item)
    if (entry) entries.push(entry)
  }
  for (const envio of input.envios) {
    if (stamp(envio.updatedAt) <= since) continue
    const entry = envioEntry(envio, input.envios)
    if (entry) entries.push(entry)
  }
  if (entries.length === 0) return null
  entries.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.at - a.at)
  const counts: Record<AwayKind, number> = { concluida: 0, espera: 0, falhou: 0 }
  for (const entry of entries) counts[entry.kind]++
  return { projectKey: input.projectKey, projectCwd: input.projectCwd, since, awayMs: now - since, counts, entries }
}

/** "45 min", "2 h", "1 dia", "3 dias". */
export function awayDuration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000))
  if (min < 60) return `${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h`
  const d = Math.round(h / 24)
  return d === 1 ? '1 dia' : `${d} dias`
}

const COUNT_TEXT: Record<AwayKind, (n: number) => string> = {
  concluida: (n) => (n === 1 ? '1 concluída' : `${n} concluídas`),
  espera: (n) => (n === 1 ? '1 espera você' : `${n} esperam você`),
  falhou: (n) => (n === 1 ? '1 falhou' : `${n} falharam`)
}

/** As partes que não são zero, na ordem concluídas · espera você · falhou. */
export function awayParts(counts: Record<AwayKind, number>): string[] {
  return KIND_ORDER.filter((k) => counts[k] > 0).map((k) => COUNT_TEXT[k](counts[k]))
}

/** "Desde que você saiu (há 2 h): 3 concluídas · 1 espera você · 1 falhou". */
export function awayHeadline(summary: AwaySummary): string {
  return `Desde que você saiu (há ${awayDuration(summary.awayMs)}): ${awayParts(summary.counts).join(' · ')}`
}

/** A versão curta, para o balão (e a voz) do PO no escritório. */
export function awaySpeech(summary: AwaySummary): string {
  const parts = awayParts(summary.counts)
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}` : parts[0]
  return `Desde que você saiu: ${list}.`
}
