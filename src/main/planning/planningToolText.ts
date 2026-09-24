import path from 'node:path'
import { MEDIA_KIND_LABEL, mediaKindOf, type PlanMediaDto } from '../../shared/planningMedia'
import type { PlanCard, Roteiro } from './planningModel'
import { PlanNotFoundError, RevConflictError, RoteiroConflictError, type OpenedPlan } from './planningStore'

/**
 * O texto que as ferramentas plan_* devolvem ao Agent Manager. Tudo em pt-BR
 * e em frases que o modelo consegue agir em cima: conflito devolve a versão
 * atual (card ou roteiro), nunca stack trace.
 */

export type ToolBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export type ToolText = { content: ToolBlock[] }
export const text = (t: string): ToolText => ({ content: [{ type: 'text', text: t }] })

const EXCERPT_CHARS = 160
const MAX_CARDS_LISTED = 200
const MAX_MEDIA_LISTED = 200

/** As mídias de <plano>/midia/ por nome, para citar anexos com tipo e caminho. */
export interface MediaIndex {
  /** Pasta ABSOLUTA midia/ do plano. */
  dir: string
  byName: ReadonlyMap<string, PlanMediaDto>
}

export function mediaIndexOf(dir: string, media: readonly PlanMediaDto[]): MediaIndex {
  return { dir, byName: new Map(media.map((m) => [m.name, m])) }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(Math.round((bytes / (1024 * 1024)) * 10) / 10).toString().replace('.', ',')} MB`
}

/** Uma mídia como o Manager a vê: `[Imagem] nome — <caminho absoluto>`. */
export function mediaLine(media: PlanMediaDto): string {
  return `[${MEDIA_KIND_LABEL[media.kind]}] ${media.name} — ${media.path}`
}

/** Um anexo do card, com tipo e caminho; sem o arquivo em midia/, diz isso. */
export function anexoLine(name: string, index?: MediaIndex): string {
  const found = index?.byName.get(name)
  if (found) return mediaLine(found)
  const label = MEDIA_KIND_LABEL[mediaKindOf(name)]
  if (!index) return `[${label}] ${name}`
  return `[${label}] ${name} — ${path.join(index.dir, name)} (arquivo não encontrado em midia/)`
}

/** O que vem depois do nome do card: etapa, status, links, fonte, anexos e rev. */
function cardMeta(card: PlanCard): string[] {
  const parts: string[] = []
  if (card.etapa) parts.push(`etapa ${card.etapa}`)
  if (card.status) parts.push(`status ${card.status}`)
  if (card.links.length) parts.push(`links ${card.links.join(', ')}`)
  if (card.fonte) parts.push(`fonte ${card.fonte}`)
  if (card.anexos?.length) parts.push(`anexos ${card.anexos.join(', ')}`)
  parts.push(`rev ${card.rev}`)
  return parts
}

export function cardHeader(card: PlanCard): string {
  return [`${card.id} [${card.tipo}] ${card.titulo}`, ...cardMeta(card)].join(' · ')
}

/**
 * A linha do card na lista do plan_read: o título em destaque, no formato em
 * que o usuário o cita ([[Título]]), e ao lado o id que as ferramentas pedem.
 */
export function cardListLine(card: PlanCard): string {
  return [`[[${card.titulo}]] (id ${card.id}, ${card.tipo})`, ...cardMeta(card)].join(' · ')
}

/** O card inteiro: cabeçalho, anexos (com tipo e caminho, se houver índice) e corpo. */
export function describeCard(card: PlanCard, index?: MediaIndex): string {
  const anexos = card.anexos?.length
    ? `\nAnexos (${card.anexos.length}):\n${card.anexos.map((name) => `  - ${anexoLine(name, index)}`).join('\n')}`
    : ''
  return `${cardHeader(card)}${anexos}\n---\n${card.corpo.trim() || '(corpo vazio)'}`
}

function excerpt(corpo: string): string {
  const flat = corpo.replace(/\s+/g, ' ').trim()
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat
}

/** Uma linha por etapa, numerada na ordem do roteiro. */
export function etapaLines(etapas: Roteiro['etapas']): string[] {
  return etapas.map((e, i) => `  ${i + 1}. [${e.status}] ${e.id}: ${e.titulo}`)
}

export function describeRoteiro(roteiro: Roteiro): string {
  const head = `Roteiro atual (rev ${roteiro.rev}): ${roteiro.titulo}`
  if (!roteiro.etapas.length) return `${head}\n  (sem etapas)`
  return [head, ...etapaLines(roteiro.etapas)].join('\n')
}

/**
 * A seção final do plan_read: toda mídia de midia/ com tipo, caminho, tamanho e
 * os cards que a citam ("sem card" para as órfãs) e os anexos sem arquivo.
 */
function mediaSection(cards: readonly PlanCard[], index: MediaIndex): string[] {
  const usedBy = new Map<string, string[]>()
  for (const card of cards) {
    for (const name of card.anexos ?? []) usedBy.set(name, [...(usedBy.get(name) ?? []), card.id])
  }
  const media = [...index.byName.values()]
  if (!media.length) {
    return [`Mídias do plano: nenhuma (pasta ${index.dir}). Para trazer um arquivo ao plano, use plan_midia_importar.`]
  }
  const lines = [`Mídias do plano (${media.length}) — abra imagem e PDF com Read pelo caminho absoluto:`]
  for (const m of media.slice(0, MAX_MEDIA_LISTED)) {
    const cardsOf = usedBy.get(m.name)
    lines.push(`  - ${mediaLine(m)} · ${formatSize(m.size)} · ${cardsOf ? `cards ${cardsOf.join(', ')}` : 'sem card'}`)
  }
  if (media.length > MAX_MEDIA_LISTED) lines.push(`  … mais ${media.length - MAX_MEDIA_LISTED} mídias em ${index.dir}.`)
  const missing = [...usedBy.keys()].filter((name) => !index.byName.has(name))
  if (missing.length) {
    lines.push(`Anexos sem arquivo em midia/ (${missing.length}): ${missing.map((n) => `${n} (cards ${usedBy.get(n)?.join(', ')})`).join('; ')}.`)
  }
  return lines
}

/** O plano resumido. Com `index`, cada card lista os anexos e o texto termina com "Mídias do plano". */
export function describePlan(plan: OpenedPlan, index?: MediaIndex): string {
  const lines = [`Planejamento ${plan.slug}: ${plan.roteiro.titulo}`]
  const etapas = plan.roteiro.etapas
  lines.push(etapas.length ? `Roteiro (${etapas.length} etapas, na ordem):` : 'Roteiro: vazio — separe e ordene as etapas com plan_roteiro_set.')
  lines.push(...etapaLines(etapas))
  lines.push(
    plan.cards.length
      ? `Cards (${plan.cards.length}) — [[Título]] é o nome com que o usuário cita o card; as ferramentas pedem o id:`
      : 'Cards: nenhum.'
  )
  for (const card of plan.cards.slice(0, MAX_CARDS_LISTED)) {
    const body = excerpt(card.corpo)
    lines.push(`  - ${cardListLine(card)}${body ? ` — ${body}` : ''}`)
    if (index) for (const name of card.anexos ?? []) lines.push(`      anexo: ${anexoLine(name, index)}`)
  }
  if (plan.cards.length > MAX_CARDS_LISTED) {
    lines.push(`  … mais ${plan.cards.length - MAX_CARDS_LISTED} cards; leia um a um com plan_read(card_id).`)
  }
  if (plan.invalid.length) {
    lines.push(`Arquivos inválidos (${plan.invalid.length}) — não entram no planejamento até serem corrigidos:`)
    for (const bad of plan.invalid) lines.push(`  - ${bad.file}: ${bad.error}`)
  }
  if (index) lines.push(...mediaSection(plan.cards, index))
  return lines.join('\n')
}

export function describeError(error: unknown): string {
  if (error instanceof RevConflictError) {
    if (!error.current) return `${error.message}. O card não existe (já foi apagado?); consulte plan_read.`
    return (
      `${error.message}. Nada foi gravado: o card mudou desde a sua leitura. Refaça a alteração sobre a versão ` +
      `atual, com expected_rev=${error.current.rev}.\nCard atual:\n${describeCard(error.current)}`
    )
  }
  if (error instanceof RoteiroConflictError) {
    return (
      `${error.message}. Nada foi gravado: o roteiro mudou enquanto você trabalhava (a tela ou outra gravação ` +
      `mexeu nele). Refaça a alteração sobre a versão atual abaixo (em plan_roteiro_set, mande de novo a lista ` +
      `inteira, sem perder o que mudou).\n` +
      describeRoteiro(error.current)
    )
  }
  if (error instanceof PlanNotFoundError) {
    return `${error.message}. O planejamento precisa ser criado pela Tela de Planejamento antes.`
  }
  if (error instanceof Error) return error.message
  return String(error)
}
