import type { PlanCard, Roteiro } from './planningModel'
import { PlanNotFoundError, RevConflictError, RoteiroConflictError, type OpenedPlan } from './planningStore'

/**
 * O texto que as ferramentas plan_* devolvem ao Agent Manager. Tudo em pt-BR
 * e em frases que o modelo consegue agir em cima: conflito devolve a versão
 * atual (card ou roteiro), nunca stack trace.
 */

export type ToolText = { content: { type: 'text'; text: string }[] }
export const text = (t: string): ToolText => ({ content: [{ type: 'text', text: t }] })

const EXCERPT_CHARS = 160
const MAX_CARDS_LISTED = 200

export function cardHeader(card: PlanCard): string {
  const parts = [`${card.id} [${card.tipo}] ${card.titulo}`]
  if (card.etapa) parts.push(`etapa ${card.etapa}`)
  if (card.status) parts.push(`status ${card.status}`)
  if (card.links.length) parts.push(`links ${card.links.join(', ')}`)
  if (card.fonte) parts.push(`fonte ${card.fonte}`)
  parts.push(`rev ${card.rev}`)
  return parts.join(' · ')
}

export function describeCard(card: PlanCard): string {
  return `${cardHeader(card)}\n---\n${card.corpo.trim() || '(corpo vazio)'}`
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

export function describePlan(plan: OpenedPlan): string {
  const lines = [`Planejamento ${plan.slug}: ${plan.roteiro.titulo}`]
  const etapas = plan.roteiro.etapas
  lines.push(etapas.length ? `Roteiro (${etapas.length} etapas, na ordem):` : 'Roteiro: vazio — separe e ordene as etapas com plan_roteiro_set.')
  lines.push(...etapaLines(etapas))
  lines.push(plan.cards.length ? `Cards (${plan.cards.length}):` : 'Cards: nenhum.')
  for (const card of plan.cards.slice(0, MAX_CARDS_LISTED)) {
    const body = excerpt(card.corpo)
    lines.push(`  - ${cardHeader(card)}${body ? ` — ${body}` : ''}`)
  }
  if (plan.cards.length > MAX_CARDS_LISTED) {
    lines.push(`  … mais ${plan.cards.length - MAX_CARDS_LISTED} cards; leia um a um com plan_read(card_id).`)
  }
  if (plan.invalid.length) {
    lines.push(`Arquivos inválidos (${plan.invalid.length}) — não entram no planejamento até serem corrigidos:`)
    for (const bad of plan.invalid) lines.push(`  - ${bad.file}: ${bad.error}`)
  }
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
