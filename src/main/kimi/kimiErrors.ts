/**
 * Erros do Kimi Code no formato que o CLI entende.
 * - Estouro de tamanho/contexto ("…exceeded model token limit: N", "total message
 *   size N exceeds limit …") → 400 "prompt is too long: N tokens > M maximum", o
 *   texto que o CLI reconhece para compactar sozinho.
 * - 401 → mensagem clara de chave; 403 de acesso → mensagem clara, sem nova
 *   tentativa com outra identidade.
 * - 429 (cota ou transitório) e o resto: repassados como vieram — as frases de
 *   cota caem em providerQuota.ts (Ordem de reserva) e o 429 transitório o CLI repete.
 */

export interface TranslatedError {
  status: number
  body: string
}

function anthropicError(type: string, message: string): string {
  return JSON.stringify({ type: 'error', error: { type, message } })
}

function messageOf(raw: string): string {
  try {
    const j = JSON.parse(raw) as { error?: { message?: unknown } | string; message?: unknown }
    if (typeof j.error === 'object' && typeof j.error?.message === 'string') return j.error.message
    if (typeof j.error === 'string') return j.error
    if (typeof j.message === 'string') return j.message
  } catch {
    // corpo não-JSON
  }
  return raw
}

/** Tradução de um erro do upstream do Kimi; null = repassar intacto. */
export function translateKimiError(status: number, raw: string, contextWindow: number, requestBytes: number): TranslatedError | null {
  const message = messageOf(raw)
  const tokenLimit = /exceeded model token limit:?\s*(\d+)/i.exec(message)
  const sizeLimit = /total message size\s*(\d+)\s*exceeds limit/i.exec(message)
  if (status === 400 && (tokenLimit || sizeLimit)) {
    const max = tokenLimit ? Number(tokenLimit[1]) || contextWindow : contextWindow
    // Sem o número de tokens do Kimi, estima pelo tamanho do corpo (~4 bytes/token), sempre acima do teto.
    const estimated = Math.max(Math.ceil(requestBytes / 4), max + 1)
    return { status: 400, body: anthropicError('invalid_request_error', `prompt is too long: ${estimated} tokens > ${max} maximum`) }
  }
  if (status === 401) {
    return { status: 401, body: anthropicError('authentication_error', 'Chave do Kimi inválida ou expirada. Atualize em Configurações → Kimi.') }
  }
  if (status === 403 && /access_terminated|only available for Coding Agents/i.test(raw)) {
    return { status: 403, body: anthropicError('permission_error', 'O Kimi recusou a chave neste endpoint. Confira a assinatura no console do Kimi Code.') }
  }
  return null
}
