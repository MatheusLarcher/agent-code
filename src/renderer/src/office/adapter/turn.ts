/**
 * Leitura do turno atual a partir de `conversation.messages`, de trás para a
 * frente, parando na última mensagem do usuário (o começo do turno).
 *
 * Como result e error ficam em messages (App.tsx, reduceMessages):
 *   - o evento `result` NÃO vira mensagem. Ele só marca o último
 *     `assistant-text` com `answer: true` e `ts: Date.now()`. Por isso o "ok"
 *     do turno é esse assistant-text com answer/ts depois da última mensagem
 *     do usuário, e o `isError` do result não deixa rastro próprio;
 *   - o evento `error` (falha da sessão) entra como mensagem `{ kind: 'error' }`;
 *   - turno que falhou e vai para a recuperação grava `error` na mensagem do
 *     usuário daquele turno (UserMessage.error).
 *   Logo "erro" = mensagem 'error' depois do último usuário, ou o último
 *   usuário com `error`. Vale até o próximo turno (nova mensagem do usuário).
 *   O contextTokens do último result fica em conversation.tokens.context.
 *
 * Custo: O(mensagens do turno atual), nunca o histórico inteiro.
 */
import type { UIMessage } from '../../types'
import type { Activity } from './kinds'

export interface TurnTool {
  id: string
  name: string
  input: unknown
}

export interface TurnScan {
  /** Última ferramenta do PRINCIPAL ainda sem resultado. */
  tool: TurnTool | null
  /** O turno terminou com erro. */
  error: boolean
  /** Epoch ms do fim do turno sem erro (answer.ts), se houver. */
  okAt: number | null
}

const TYPE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'])

/** Ferramenta → animação: digitando, lendo ou nenhuma. */
export function activityFor(name: string | undefined): Activity {
  if (!name) return null
  if (TYPE_TOOLS.has(name)) return 'type'
  if (READ_TOOLS.has(name)) return 'read'
  return null
}

export function scanTurn(messages: readonly UIMessage[]): TurnScan {
  const out: TurnScan = { tool: null, error: false, okAt: null }
  let toolDone = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind === 'user') {
      if (m.error) out.error = true
      break
    }
    if (m.kind === 'error') out.error = true
    else if (m.kind === 'assistant-text' && m.answer && out.okAt === null) out.okAt = m.ts ?? null
    else if (m.kind === 'tool-use' && !toolDone && m.parentToolUseId == null) {
      // Só a ÚLTIMA ferramenta do principal conta: com resultado, ele já saiu dela.
      toolDone = true
      if (!m.result) out.tool = { id: m.id, name: m.name, input: m.input }
    }
  }
  return out
}
