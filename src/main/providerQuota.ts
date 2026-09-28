/**
 * Only inspect provider errors, never ordinary assistant/user/tool text.
 *
 * O CLI monta o estouro do plano como `You've hit your ${nome}` — nome da janela
 * ("session limit", "weekly limit", "Opus limit", "Sonnet limit", "Fable limit")
 * ou "limit"/"usage limit"; também "You've reached your Fable 5 limit" e "Fable
 * 5.1 requires usage credits", "monthly spend limit", "usage credit limit" e, no
 * plano de equipe, "You've hit your team's shared budget". "fast limit" é a pausa
 * temporária do modo rápido, e "(not your usage limit)" é o 429 transitório do
 * servidor: nenhum dos dois é estouro.
 *
 * A lista completa de prefixos que o CLI trata como estouro é a constante `VBr`
 * do claude.exe 0.3.283 (uso extra, verba da organização, do grupo e do assento
 * incluídos); cada um está coberto em `providerQuota.test.ts`.
 */
const EXHAUSTED_RE = new RegExp([
  'usage_limit_reached',
  'insufficient_quota',
  'credit balance is too low',
  // "You're out of usage credits", "You're out of extra usage", "Your org is out of usage".
  'out of (?:extra )?(?:usage|credits)',
  'requires usage credits',
  "seat type doesn['’]t include (?:extra )?usage",
  'usage allocation has been disabled',
  'usage limit is set to \\$0',
  'usage limit (?:has been )?(?:reached|exceeded)',
  '(?:limite de uso|cr[eé]ditos).{0,80}(?:atingido|esgotad)'
].join('|'), 'iu')

/** "hit/reached your … limit": o nome antes de "limit" (até 3 palavras) é o que decide. */
const HIT_LIMIT_RE = /(?:hit|reached) your ((?:[\p{L}\p{N}.'’$-]+ ){0,3})(?:limits?|shared budget)\b/giu
/** Limites que passam sozinhos (vazão, contexto, modo rápido): não são o plano esgotado. */
const TRANSIENT_LIMIT_WORDS = /\b(?:rate|fast|context|concurrency|concurrent|requests?|per-minute|minute|tokens?)\b/iu

export function isUsageExhausted(error: unknown): boolean {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (EXHAUSTED_RE.test(text)) return true
  for (const match of text.matchAll(HIT_LIMIT_RE)) {
    if (!TRANSIENT_LIMIT_WORDS.test(match[1])) return true
  }
  return false
}

export function sdkUsageExhausted(message: unknown): boolean {
  const m = message as { type?: string; error?: string; message?: { content?: unknown }; errors?: string[] }
  if (m.type === 'assistant' && m.error) {
    if (m.error === 'billing_error') return true
    // A bare 429 can mean temporary throttling. Require the provider's quota message.
    return isUsageExhausted(JSON.stringify(m.message?.content ?? ''))
  }
  return Array.isArray(m.errors) && m.errors.some(isUsageExhausted)
}
