/**
 * O histórico de uma conversa em texto, para o PO ler num arquivo (a avaliação
 * da fila do projeto). Só o trilho principal: o que o usuário disse, o que o
 * agente respondeu, as ferramentas e os erros. Comprido demais, fica o FIM —
 * é onde está o porquê da parada.
 */

export const HISTORY_MAX_CHARS = 400_000
const BRIEF_CHARS = 240

function brief(value: unknown): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  text = (text ?? '').replace(/\s+/g, ' ').trim()
  return text.length > BRIEF_CHARS ? `${text.slice(0, BRIEF_CHARS - 1)}…` : text
}

type StoredMessage = {
  kind?: string
  text?: unknown
  name?: unknown
  input?: unknown
  isError?: unknown
  parentToolUseId?: unknown
}

export function formatConversationHistory(payload: Record<string, unknown> | null | undefined): string {
  if (!payload) return ''
  const messages = Array.isArray(payload.messages) ? (payload.messages as StoredMessage[]) : []
  const out: string[] = [`# ${typeof payload.title === 'string' ? payload.title : 'Conversa'}`, '']
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    // Subagentes ficam fora: o painel de agentes é que mostra esse trilho.
    if (m.parentToolUseId) continue
    if (m.kind === 'user') out.push('## Usuário', String(m.text ?? ''), '')
    else if (m.kind === 'assistant-text' && typeof m.text === 'string' && m.text.trim()) out.push('## Agente', m.text, '')
    else if (m.kind === 'tool-use') out.push(`- ferramenta ${String(m.name ?? '?')}: ${brief(m.input)}`)
    else if (m.kind === 'tool-result' && m.isError) out.push(`- erro da ferramenta: ${brief(m.text)}`)
    else if (m.kind === 'result') out.push(`--- fim do turno${m.isError ? ' (com erro)' : ''} ---`, '')
    else if (m.kind === 'error') out.push('## Erro', String(m.text ?? ''), '')
  }
  const text = out.join('\n')
  return text.length > HISTORY_MAX_CHARS
    ? `(o começo foi cortado: o histórico tinha ${text.length} caracteres)\n…${text.slice(-HISTORY_MAX_CHARS)}`
    : text
}
