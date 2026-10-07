/**
 * O plano visto no celular, sem canvas: uma coluna por etapa do roteiro, com os
 * cards dela em lista, e a coluna "Sem etapa" no fim para o resto. Lógica pura.
 */
import type { PlanningCardDto, PlanningStageStatus } from '@shared/ipc'
import { CARD_TYPE_ORDER } from '@renderer/planning/cardTypes'
import type { RemotePlan } from '../core/types'

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

/** "http(s)://…" vira link; o resto é arquivo do projeto (fica como texto). */
export function isWebFonte(fonte: string | undefined): boolean {
  return !!fonte && /^https?:\/\//i.test(fonte)
}
