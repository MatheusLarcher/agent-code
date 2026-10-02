/**
 * Máscara de segredos para tudo o que a Central manda ao TypeSafe (serviço de
 * terceiro): a mensagem nova, os destinos recentes, os resumos e os títulos.
 * Rotear nunca precisa do VALOR de um segredo, então o que tem cara de chave,
 * token ou senha vira `[segredo]` antes de sair do PC.
 *
 * Heurística, não detector completo (o mesmo espírito de memory/secretScan.ts,
 * de onde vêm as formas das chaves): o objetivo é não vazar o óbvio. Puro — sem
 * disco, sem Electron.
 */

export const SECRET_MASK = '[segredo]'

/** `senha: x`, `password=x`, `"api_key": "x"`: a atribuição é o que faz do valor um segredo.
 *  `(?<![A-Za-z])` em vez de `\b`: `_` é caractere de palavra e `DB_PASSWORD=` escaparia. */
const ASSIGNMENT =
  /(?<![A-Za-z])(pass(?:word|wd)?|senha|secret|segredo|token|api[_-]?key|apikey|chave[_-]?api|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token)(["'`]?\s*[:=]\s*["'`]?)[^\s"'`,;]{4,}/gi

/** Na ordem: do mais específico ao mais genérico. O que já virou `[segredo]` não casa de novo. */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, SECRET_MASK],
  // OpenAI / Anthropic.
  [/\bsk-[A-Za-z0-9_-]{20,}/g, SECRET_MASK],
  // TypeSafe.
  [/\bapikey_[A-Za-z0-9_-]{8,}/gi, SECRET_MASK],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, SECRET_MASK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, SECRET_MASK],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, SECRET_MASK],
  [/\bAIza[A-Za-z0-9_-]{35}/g, SECRET_MASK],
  // JWT, inteiro ou cortado (o resumo corta textos em 200 caracteres).
  [/\beyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)*/g, SECRET_MASK],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, `$1${SECRET_MASK}`],
  // postgres://usuario:SENHA@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/@]{3,}@/gi, `$1${SECRET_MASK}@`],
  [ASSIGNMENT, `$1$2${SECRET_MASK}`]
]

/** Corrida longa sem espaço, no alfabeto de chaves e base64. */
const LONG_RUN = /[A-Za-z0-9_\-+/=]{32,}/g

/**
 * A corrida é aleatória o bastante para ser segredo? Caminho, slug e UUID também
 * formam corridas longas, mas em pedaços curtos separados por `/`, `-` ou `_`:
 * segredo tem um pedaço de 20+ caracteres que mistura letra e dígito.
 */
function looksRandom(run: string): boolean {
  return run.split(/[/_-]+/).some((piece) => piece.length >= 20 && /\d/.test(piece) && /[A-Za-z]/.test(piece))
}

/** O texto com os segredos óbvios trocados por `[segredo]`. Não-texto vira ''. */
export function maskSecrets(text: string): string {
  if (typeof text !== 'string' || text === '') return ''
  let out = text
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  return out.replace(LONG_RUN, (run) => (looksRandom(run) ? SECRET_MASK : run))
}

/** Cópia com TODO texto aninhado mascarado (chaves de objeto e não-textos ficam como estão). */
export function maskDeep<T>(value: T): T {
  if (typeof value === 'string') return maskSecrets(value) as T
  if (Array.isArray(value)) return value.map((item) => maskDeep(item)) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = maskDeep(item)
    return out as T
  }
  return value
}
