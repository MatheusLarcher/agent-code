/**
 * O plano visto no celular, sem canvas: uma coluna por etapa do roteiro, com os
 * cards dela em lista, e a coluna "Sem etapa" no fim para o resto. Lógica pura.
 */
import type { PlanningCardDto, PlanningStageStatus } from '@shared/ipc'
import { CARD_TYPE_ORDER } from '@renderer/planning/cardTypes'
import type { ConvSummary, RemotePlan, RemotePlanSummary } from '../core/types'

/** Quantos planos cada projeto mostra antes do "Ver mais". */
export const PLANS_VISIBLE = 5

/** A data do slug `plano-AAAAMMDD-HHMM` (hora local), em ms; 0 se o slug não tem data. */
export function slugTime(slug: string): number {
  const m = /^plano-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(slug)
  if (!m) return 0
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime()
  return Number.isFinite(t) ? t : 0
}

/**
 * Quando o plano mudou pela última vez, para ordenar: `atualizadoEm` (PC novo);
 * no PC antigo, o updatedAt da conversa do Manager do plano e, sem ela, a data do slug.
 */
export function planTime(p: RemotePlanSummary, cwd: string, conversations: readonly ConvSummary[]): number {
  if (p.atualizadoEm && p.atualizadoEm > 0) return p.atualizadoEm
  let conv = 0
  for (const c of conversations) {
    if (c.mode === 'planning' && c.planningSlug === p.slug && c.cwd === cwd) conv = Math.max(conv, c.updatedAt || 0)
  }
  return conv || slugTime(p.slug)
}

/** Os planos do mais recente para o mais antigo (empate: a ordem do PC). */
export function sortPlans(plans: readonly RemotePlanSummary[], cwd: string, conversations: readonly ConvSummary[]): RemotePlanSummary[] {
  return plans
    .map((p, i) => ({ p, i, t: planTime(p, cwd, conversations) }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map((x) => x.p)
}

/** Os projetos pelo plano mais recente de cada um; sem plano (carregando, erro) vão ao fim, na ordem de antes. */
export function sortProjects(
  cwds: readonly string[],
  plansOf: (cwd: string) => readonly RemotePlanSummary[],
  conversations: readonly ConvSummary[]
): string[] {
  const latest = (cwd: string): number => Math.max(-1, ...plansOf(cwd).map((p) => planTime(p, cwd, conversations)))
  return cwds
    .map((cwd, i) => ({ cwd, i, t: latest(cwd) }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map((x) => x.cwd)
}

export interface StageColumn {
  /** Id da etapa; null = "Sem etapa". */
  id: string | null
  titulo: string
  status: PlanningStageStatus | null
  estimativa?: number
  cards: PlanningCardDto[]
}

const typeRank = (c: PlanningCardDto): number => {
  const i = CARD_TYPE_ORDER.indexOf(c.tipo)
  return i < 0 ? CARD_TYPE_ORDER.length : i
}

/** Cards na ordem dos tipos (etapa, requisito, decisão…), estável dentro do tipo. */
function sortCards(cards: PlanningCardDto[]): PlanningCardDto[] {
  return cards.map((c, i) => ({ c, i })).sort((a, b) => typeRank(a.c) - typeRank(b.c) || a.i - b.i).map((x) => x.c)
}

export function stageColumns(plan: Pick<RemotePlan, 'roteiro' | 'cards'>): StageColumn[] {
  const etapas = plan.roteiro.etapas
  const ids = new Set(etapas.map((e) => e.id))
  const cols: StageColumn[] = etapas.map((e) => ({
    id: e.id,
    titulo: e.titulo,
    status: e.status,
    estimativa: e.estimativa,
    cards: sortCards(plan.cards.filter((c) => c.etapa === e.id))
  }))
  const loose = plan.cards.filter((c) => !c.etapa || !ids.has(c.etapa))
  if (loose.length || cols.length === 0) cols.push({ id: null, titulo: 'Sem etapa', status: null, cards: sortCards(loose) })
  return cols
}

export function isOpenAmbiguity(c: Pick<PlanningCardDto, 'tipo' | 'status'>): boolean {
  return c.tipo === 'ambiguidade' && c.status !== 'resolvida'
}

/** Trecho do corpo para a lista: sem marcação de Markdown, [[Nome]] vira Nome. */
export function cardSnippet(corpo: string, max = 140): string {
  const t = (corpo || '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/\[\[([^[\]\r\n]+)\]\]/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' · ')
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t
}

/** Anexos do card separados em imagens (a ponte serve) e o resto (só no PC). */
export function cardAttachments(card: Pick<PlanningCardDto, 'anexos'>, media: RemotePlan['media']): { images: string[]; others: string[] } {
  const images: string[] = []
  const others: string[] = []
  for (const name of card.anexos ?? []) {
    const m = media.find((x) => x.name === name)
    if (m?.kind === 'imagem') images.push(name)
    else others.push(name)
  }
  return { images, others }
}

/** O título de um prompt de _handoff/ na folha: a 1ª linha com texto (sem o "#"); sem nenhuma, o nome do arquivo. */
export function handoffTitle(content: string, name: string): string {
  for (const line of (content || '').split(/\r?\n/)) {
    const t = line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/[*_`]+/g, '').trim()
    if (t) return t.length > 120 ? t.slice(0, 119).trimEnd() + '…' : t
  }
  return name
}

/** "http(s)://…" vira link; o resto é arquivo do projeto (fica como texto). */
export function isWebFonte(fonte: string | undefined): boolean {
  return !!fonte && /^https?:\/\//i.test(fonte)
}
