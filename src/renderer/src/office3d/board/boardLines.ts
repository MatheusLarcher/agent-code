/**
 * As falas do quadro — PURO. O texto nunca troca o autor:
 *
 *   agent   primeira pessoa, gerada do dado (o agente não grava motivo):
 *           "Comecei: …", "Concluí: …", "Anotei: …", "Tirei do plano: …";
 *   po      o motivo dele (a nota do evento), em primeira pessoa;
 *   system  dito pelo PO, mas como REGRA, nunca como decisão dele:
 *           "Regra do fim do turno: …", "Regra da retomada: …";
 *   user    sem fala: o papel desliza com o selinho "Você".
 *
 * Sem personagem para levar o papel, a MESMA frase em terceira pessoa vai no
 * selo preso ao quadro ("O agente concluiu: …", "Sistema — fim do turno: …").
 * Tudo cortado em QUIP_MAX com "…"; o texto inteiro fica no cartão (clique).
 */
import { parseBoardTurnEndReason } from '@shared/ipc'
import { QUIP_MAX } from '../quips/format'
import { columnLabel, stepText, type BoardStep } from './boardModel'

export const USER_SEAL = 'Você'

/** Corta em `max` com "…" (o cartão grande tem o texto inteiro). */
export function clip(text: string, max = QUIP_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}

/** A nota do passo é motivo de verdade (não o texto genérico que o modelo pôs no lugar). */
function realNote(s: BoardStep): string | null {
  const t = s.text.trim()
  return t && t !== stepText(s.kind, s.toStatus) && t !== 'Quadro atualizado' ? t : null
}

function agentLine(s: BoardStep, first: boolean): string {
  const t = s.title
  const say = (me: string, they: string, what: string): string => (first ? `${me}: ${what}` : `O agente ${they}: ${what}`)
  switch (s.kind) {
    case 'new':
      return say('Anotei', 'anotou', t)
    case 'moved':
      if (s.toStatus === 'completed') return say('Concluí', 'concluiu', t)
      if (s.toStatus === 'in_progress') return say('Comecei', 'começou', s.activeForm?.trim() || t)
      return say('Voltei para a fazer', 'voltou para a fazer', t)
    case 'renamed':
      return say('Reescrevi', 'reescreveu', t)
    case 'removed':
      return say('Tirei do plano', 'tirou do plano', t)
    case 'restored':
      return say('Voltei ao plano', 'voltou ao plano', t)
    case 'justified':
      return say('Expliquei', 'explicou', t)
  }
}

function poLine(s: BoardStep, first: boolean): string {
  const note = realNote(s)
  const what = note ?? (s.toStatus && s.kind === 'moved' ? `${columnLabel(s.toStatus)}: ${s.title}` : `${stepText(s.kind, s.toStatus)}: ${s.title}`)
  return first ? what : `PO: ${what}`
}

function systemLine(s: BoardStep, first: boolean): string {
  const note = realNote(s) ?? s.text
  if (parseBoardTurnEndReason(note)) return first ? `Regra do fim do turno: ${note}` : `Sistema — fim do turno: ${note}`
  if (s.kind === 'moved' && s.toStatus === 'in_progress') {
    return first ? 'Regra da retomada: você respondeu, o trabalho voltou' : 'Sistema — retomada: você respondeu, o trabalho voltou'
  }
  return first ? `Regra do sistema: ${note}` : `Sistema: ${note}`
}

/**
 * A fala de um passo. `first`: dita pelo personagem que leva o papel (primeira
 * pessoa); false: o selo do quadro (terceira pessoa). null = sem fala (usuário,
 * autor desconhecido).
 */
export function stepLine(s: BoardStep, first: boolean): string | null {
  switch (s.actor) {
    case 'agent':
      return clip(agentLine(s, first))
    case 'po':
      return clip(poLine(s, first))
    case 'system':
      return clip(systemLine(s, first))
    default:
      return null
  }
}

const COUNT_WORDS: Record<string, [string, string]> = {
  complete: ['concluída', 'concluídas'],
  write: ['nova', 'novas'],
  move: ['movida', 'movidas'],
  rename: ['renomeada', 'renomeadas'],
  point: ['justificada', 'justificadas'],
  trash: ['retirada', 'retiradas'],
  restore: ['restaurada', 'restauradas']
}

/** "+5 mudanças: 3 concluídas, 2 novas" — o que passou do teto e foi aplicado direto. */
export function summaryLine(motions: readonly string[]): string {
  const n = new Map<string, number>()
  for (const m of motions) n.set(m, (n.get(m) ?? 0) + 1)
  const parts = [...n.entries()].sort((a, b) => b[1] - a[1]).map(([m, k]) => `${k} ${COUNT_WORDS[m]?.[k === 1 ? 0 : 1] ?? m}`)
  const total = motions.length
  return clip(`+${total} ${total === 1 ? 'mudança' : 'mudanças'}: ${parts.join(', ')}`)
}
