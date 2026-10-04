/**
 * Perguntas e permissões dos destinos na Central, puro: quais aparecem (as das
 * conversas com turno em aberto aqui) e a linha de histórico que fica depois de
 * respondidas (só texto curto — o pedido inteiro mora na conversa).
 */
import type { PermissionRequest, PermissionResponse } from '@shared/ipc'
import type { CentralEntry, CentralQuestionEntry } from '@shared/central'
import { describeTool } from '../components/toolDescribe'
import { clip, hasActiveAnchor, type CentralLiveAnchor } from './centralEntries'

/** Corte da pergunta e da resposta guardadas no histórico. */
const QUESTION_MAX_CHARS = 300

/** As conversas cuja pergunta/permissão pendente a Central mostra: as com o turno de um pedido dela vivo. */
export function pendingConvIds(
  entries: readonly CentralEntry[],
  permissions: Readonly<Record<string, PermissionRequest>>,
  isLive: CentralLiveAnchor
): string[] {
  return Object.keys(permissions).filter((convId) => hasActiveAnchor(entries, convId, isLive))
}

function questionText(req: PermissionRequest): string {
  if (req.questions?.length) return req.questions.map((q) => q.question).join(' · ')
  const { verb, detail } = describeTool(req.toolName, req.input)
  return `permissão: ${verb}${detail ? ` ${detail}` : ''}`
}

function answerText(req: PermissionRequest, res: PermissionResponse): string {
  if (res.behavior === 'deny') return req.questions ? 'sem resposta' : 'negado'
  if (res.answers?.length) {
    return res.answers.map((a) => a.selected.join(', ')).filter(Boolean).join(' · ') || 'sem resposta'
  }
  return res.always ? 'sempre permitido' : 'permitido'
}

let questionSeq = 0

/** A pergunta respondida pela Central, para o histórico dela. */
export function answeredQuestionEntry(
  convId: string,
  req: PermissionRequest,
  res: PermissionResponse,
  device: string | undefined,
  now: number = Date.now()
): CentralQuestionEntry {
  questionSeq += 1
  return {
    kind: 'question',
    id: `q-${now.toString(36)}-${questionSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    ts: now,
    convId,
    question: clip(questionText(req), QUESTION_MAX_CHARS),
    answer: clip(answerText(req, res), QUESTION_MAX_CHARS),
    ...(device ? { device } : {})
  }
}
