import type { HandoffEnvio, HandoffEnvioStatus } from '@shared/handoffTracking'

/**
 * As regras da tela Entregas, sem React: rótulos, o que precisa do usuário (o
 * contador da barra), a ordem, os filtros e a busca. Tudo lê o que o main gravou
 * no banco — nada vem do texto do modelo. As contas e o rótulo das etapas (e o
 * do status da entrega) são os da regra única: shared/stepProgress.
 */

export const ENVIO_STATUS_LABEL: Record<HandoffEnvioStatus, string> = {
  na_fila: 'na fila',
  enviado: 'enviado',
  em_execucao: 'em execução',
  aguardando_voce: 'aguardando você',
  parada: 'parada',
  falhou: 'falhou',
  incompleta: 'incompleta',
  concluida: 'concluída'
}

/** Busca do usuário: ignora maiúsculas e acentos — aplicada à busca E aos dados. */
export function normSearch(s: string | null | undefined): string {
  return (s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()
}

/** Nome da pasta do projeto ("C:\\a\\meu-app\\" → "meu-app"). */
export function projectName(cwd: string): string {
  const parts = (cwd || '').split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

/** Tem a marca de atraso: o envio, ou alguma entrega dele. */
export function isLate(envio: HandoffEnvio): boolean {
  return envio.atrasado || envio.entregas.some((e) => e.atrasada)
}

/** Atraso que ainda pede atenção: o envio concluído já não espera nada de você. */
export function isOpenLate(envio: HandoffEnvio): boolean {
  return envio.status !== 'concluida' && isLate(envio)
}

const NEEDS_USER: ReadonlySet<HandoffEnvioStatus> = new Set(['aguardando_voce', 'incompleta', 'parada'])

/** O que o contador da barra conta: aguardando você, incompleta, parada ou atrasada (uma vez por envio). */
export function needsUser(envio: HandoffEnvio): boolean {
  return NEEDS_USER.has(envio.status) || isOpenLate(envio)
}

export function needsUserCount(envios: readonly HandoffEnvio[] | null): number {
  return envios ? envios.filter(needsUser).length : 0
}

/** A faixa do atrasado em aberto: entre "falhou" e "em execução". */
const LATE_RANK = 4

/**
 * Uma posição para cada status: aguardando você → incompleta → parada → falhou
 * → (atrasada em aberto) → em execução → enviado → na fila → concluída.
 */
const STATUS_RANK: Record<HandoffEnvioStatus, number> = {
  aguardando_voce: 0,
  incompleta: 1,
  parada: 2,
  falhou: 3,
  em_execucao: 5,
  enviado: 6,
  na_fila: 7,
  concluida: 8
}

/** Posição na lista. O atraso só sobe quem está abaixo da faixa dele (em execução, enviado, na fila). */
export function sortRank(envio: HandoffEnvio): number {
  const rank = STATUS_RANK[envio.status] ?? STATUS_RANK.concluida
  return rank > LATE_RANK && isOpenLate(envio) ? LATE_RANK : rank
}

function recency(envio: HandoffEnvio): number {
  const ms = Date.parse(envio.updatedAt)
  return Number.isFinite(ms) ? ms : 0
}

export function sortEnvios(envios: readonly HandoffEnvio[]): HandoffEnvio[] {
  return [...envios].sort((a, b) => sortRank(a) - sortRank(b) || recency(b) - recency(a))
}

export const DELIVERY_FILTERS = [
  'aguardando_voce',
  'incompleta',
  'parada',
  'atrasada',
  'em_execucao',
  'concluida'
] as const
export type DeliveryFilter = (typeof DELIVERY_FILTERS)[number]

export const FILTER_LABEL: Record<DeliveryFilter, string> = {
  aguardando_voce: 'Aguardando você',
  incompleta: 'Incompleta',
  parada: 'Parada',
  atrasada: 'Atrasada',
  em_execucao: 'Em execução',
  concluida: 'Concluída'
}

/** `atrasada` mostra todos com a marca (inclusive os concluídos com atraso). */
export function matchesFilter(envio: HandoffEnvio, filter: DeliveryFilter | null): boolean {
  if (!filter) return true
  if (filter === 'atrasada') return isLate(envio)
  return envio.status === filter
}

/** Projeto, plano, conversa e os títulos das etapas, já normalizados. */
export function searchHaystack(envio: HandoffEnvio): string {
  return normSearch(
    [
      projectName(envio.projectCwd),
      envio.planTitulo,
      envio.planSlug,
      envio.conversationTitle,
      ...envio.entregas.map((e) => e.etapaTitulo)
    ].join('\n')
  )
}

export function matchesSearch(envio: HandoffEnvio, query: string): boolean {
  const q = normSearch(query)
  return !q || searchHaystack(envio).includes(q)
}

/** A lista da tela: filtro, busca e a ordem. */
export function visibleEnvios(
  envios: readonly HandoffEnvio[],
  filter: DeliveryFilter | null,
  query: string
): HandoffEnvio[] {
  return sortEnvios(envios.filter((e) => matchesFilter(e, filter) && matchesSearch(e, query)))
}

/** Quantos envios cada filtro mostraria (com a busca aplicada). */
export function filterCounts(envios: readonly HandoffEnvio[], query: string): Record<DeliveryFilter, number> {
  const out = Object.fromEntries(DELIVERY_FILTERS.map((f) => [f, 0])) as Record<DeliveryFilter, number>
  for (const envio of envios) {
    if (!matchesSearch(envio, query)) continue
    for (const f of DELIVERY_FILTERS) if (matchesFilter(envio, f)) out[f]++
  }
  return out
}
