import type { AskQuestion } from '../../shared/ipc'
import { destructiveTextReason } from '../tasks/destructiveCommand'
import type { HandoffAutonomy } from './handoffAutonomy'

/**
 * O que fazer com uma AskUserQuestion numa conversa de handoff, pela política
 * de autonomia do plano. Pura: a sessão só executa a decisão.
 *
 * - `ui`: como sempre (modal + prazo) — política "como hoje", pergunta sobre
 *   ação destrutiva, ou item da lista "só o que listar";
 * - `answer`: toda pergunta tem uma opção marcada "(Recommended)"/"(Recomendado)"
 *   — resolve com ela, sem UI;
 * - `deny`: sem recomendada — o modelo decide pelos cards e segue.
 */

export type HandoffQuestionDecision =
  | { kind: 'ui' }
  | { kind: 'answer'; picks: Array<{ header: string; question: string; label: string }> }
  | { kind: 'deny'; message: string }

export const HANDOFF_DECIDE_YOURSELF =
  "Conversa de handoff: decida você pelos cards do plano (leitura mais conservadora se eles não responderem), registre a decisão em 'Decisões tomadas sozinho' no relatório e continue."

const RECOMMENDED = /\s*\((?:recommended|recomendad[oa])\)\s*/iu

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/gu, '').toLowerCase().trim()

/** O rótulo sem o "(Recommended)". */
export function cleanOptionLabel(label: string): string {
  return label.replace(RECOMMENDED, ' ').replace(/\s+/gu, ' ').trim()
}

function questionText(q: AskQuestion): string {
  return [q.header, q.question, ...q.options.flatMap((o) => [o.label, o.description])].join('\n')
}

function matchesListItem(q: AskQuestion, lista: readonly string[]): boolean {
  const text = fold(`${q.header}\n${q.question}`)
  const header = fold(q.header)
  return lista.some((raw) => {
    const item = fold(raw)
    return item.length > 0 && (text.includes(item) || (header.length > 2 && item.includes(header)))
  })
}

export function decideHandoffQuestion(autonomy: HandoffAutonomy | null, questions: readonly AskQuestion[]): HandoffQuestionDecision {
  if (!autonomy || autonomy.perguntas === 'como_hoje' || questions.length === 0) return { kind: 'ui' }
  if (questions.some((q) => destructiveTextReason(questionText(q)))) return { kind: 'ui' }
  const lista = typeof autonomy.perguntas === 'object' ? autonomy.perguntas.lista : []
  if (lista.length && questions.some((q) => matchesListItem(q, lista))) return { kind: 'ui' }

  const picks: Array<{ header: string; question: string; label: string }> = []
  for (const q of questions) {
    const recommended = q.options.find((o) => RECOMMENDED.test(o.label))
    if (!recommended) return { kind: 'deny', message: HANDOFF_DECIDE_YOURSELF }
    picks.push({ header: q.header, question: q.question, label: cleanOptionLabel(recommended.label) })
  }
  return { kind: 'answer', picks }
}

/** A linha de sistema no chat de cada escolha automática. */
export function decidedAloneLine(pick: { header: string; question: string; label: string }): string {
  return `Decidido sozinho: ${pick.label} (recomendada) — pergunta: ${pick.header || pick.question}`
}

/** O que volta ao modelo: o mesmo formato da resposta do usuário (deny com as escolhas). */
export function decidedAloneMessage(picks: ReadonlyArray<{ header: string; question: string; label: string }>): string {
  const lines = picks.map((p) => `- ${p.header || p.question}: ${p.label}`)
  return `Conversa de handoff: ninguém foi perguntado; a opção recomendada foi escolhida automaticamente:\n${lines.join('\n')}\nSiga com ela e registre a escolha em 'Decisões tomadas sozinho' no relatório.`
}
