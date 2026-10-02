/**
 * O espelho de um turno na Central: das mensagens da conversa de destino, só o
 * que a Central mostra — os comentários do agente, a resposta final, as ações da
 * trilha principal (para a linha-resumo e para os cartões que abrem ao clique) e
 * se o turno acabou. Módulo puro: lê, nunca copia nem altera as mensagens.
 *
 * O turno é ancorado na bolha do usuário lá (a que a Central entregou, ou a que
 * foi enviada na própria conversa): vai da âncora até a próxima mensagem do
 * usuário que NÃO seja ajuste injetado (o "agora" da fila entra no turno em
 * andamento, não abre outro).
 */
import type { CentralActivity } from '@shared/central'
import type { UIMessage } from '../types'
import { summarizeActivity } from './activitySummary'

export interface CentralTurnMirror {
  /** Os textos completos (`final`) do agente no turno, em ordem, menos a resposta. */
  notes: string[]
  /** O texto marcado `answer` (o último, se houver mais de um); ausente até existir. */
  answer?: string
  /** Os tool-use da trilha principal do turno — as próprias mensagens, com o resultado colado. */
  tools: UIMessage[]
  activity: CentralActivity
  /**
   * O turno acabou: tem texto marcado `answer` (o `result` do SDK nunca entra em
   * `messages` — só deixa essa marca), uma mensagem do usuário depois o fechou, ou
   * o destino está parado (`running: false`), o que cobre o turno sem texto.
   */
  done: boolean
  /** Já chegou alguma mensagem depois da âncora. */
  started: boolean
}

type ToolUse = Extract<UIMessage, { kind: 'tool-use' }>
type AssistantText = Extract<UIMessage, { kind: 'assistant-text' }>

/** Trilha principal: `parentToolUseId` nulo (ou ausente, em dado antigo). Subagente nunca entra. */
const isMainToolUse = (m: UIMessage): m is ToolUse => m.kind === 'tool-use' && m.parentToolUseId == null

/** As mensagens do turno da âncora e se uma mensagem do usuário depois o fechou; null sem a âncora. */
function sliceTurn(messages: UIMessage[], anchorMsgId: string): { turn: UIMessage[]; closed: boolean } | null {
  const start = messages.findIndex((m) => m.kind === 'user' && m.id === anchorMsgId)
  if (start < 0) return null
  let end = start + 1
  while (end < messages.length) {
    const m = messages[end]
    if (m.kind === 'user' && !m.injected) break
    end++
  }
  return { turn: messages.slice(start + 1, end), closed: end < messages.length }
}

/**
 * O espelho do turno ancorado em `anchorMsgId`; null enquanto a âncora não está
 * nas mensagens (a mensagem ainda na fila). `running`: a conversa de destino está
 * ocupada agora.
 */
export function mirrorTurn(messages: UIMessage[], anchorMsgId: string, running: boolean): CentralTurnMirror | null {
  const slice = sliceTurn(messages, anchorMsgId)
  if (!slice) return null
  const { turn, closed } = slice
  const texts = turn.filter((m): m is AssistantText => m.kind === 'assistant-text')
  // Texto parcial (`final: false`) nunca é espelhado; o vazio também não.
  const complete = texts.filter((m) => m.final && m.text.trim() !== '')
  let answerAt = -1
  for (let i = complete.length - 1; i >= 0 && answerAt < 0; i--) if (complete[i].answer) answerAt = i
  const done = closed || !running || texts.some((m) => m.answer)
  const tools = turn.filter(isMainToolUse)
  return {
    notes: complete.filter((_, i) => i !== answerAt).map((m) => m.text.trim()),
    ...(answerAt >= 0 ? { answer: complete[answerAt].text.trim() } : {}),
    tools,
    activity: summarizeActivity(tools, { running: running && !done }),
    done,
    started: turn.length > 0
  }
}

/** Os tool-use do turno (a mesma lista de `mirrorTurn().tools`), para a vista que abre ao clique; [] sem a âncora. */
export function turnToolUses(messages: UIMessage[], anchorMsgId: string): UIMessage[] {
  return sliceTurn(messages, anchorMsgId)?.turn.filter(isMainToolUse) ?? []
}
