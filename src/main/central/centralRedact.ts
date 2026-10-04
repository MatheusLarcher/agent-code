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

/** camelCase/PascalCase puro (`conversationWriteRecoveryHelper`): palavras coladas, sem dígito nem separador. */
const CAMEL_WORDS = /^[A-Za-z][a-z]*(?:[A-Z][a-z]+)+$/

/** Variedade mínima: entropia de Shannon (bits por caractere) de 80% do máximo para o tamanho da corrida. O máximo
 *  é log2 do tamanho, até 6 bits (os 64 símbolos do alfabeto): 4,0 bits aos 32 caracteres, 4,8 dos 64 em diante. */
const MIN_DIVERSITY = 0.8
/** Picotado mínimo: fração dos pares de letras/dígitos vizinhos que trocam de classe (maiúscula, minúscula, dígito). */
const MIN_CLASS_CHANGES = 0.25

function entropy(text: string): number {
  const counts = new Map<string, number>()
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) bits -= (count / text.length) * Math.log2(count / text.length)
  return bits
}

/** 1 = maiúscula, 2 = minúscula, 3 = dígito, 0 = separador ou outro. */
function charClass(char: string): number {
  if (char >= 'A' && char <= 'Z') return 1
  if (char >= 'a' && char <= 'z') return 2
  return char >= '0' && char <= '9' ? 3 : 0
}

function classChanges(text: string): number {
  let pairs = 0
  let changes = 0
  for (let i = 1; i < text.length; i++) {
    const before = charClass(text[i - 1])
    const now = charClass(text[i])
    if (!before || !now) continue
    pairs++
    if (before !== now) changes++
  }
  return pairs ? changes / pairs : 0
}

/**
 * A corrida é aleatória o bastante para ser segredo? Julga a corrida INTEIRA.
 * Chave com `/`, `-`, `_` ou `+` no meio (o segredo de exemplo da AWS, base64url)
 * não tem pedaço de 20+ caracteres, mas continua sendo uma sequência variada que
 * troca de classe a cada passo. Caminho, slug e UUID também formam corridas
 * longas, só que de palavras: poucos caracteres distintos para o tamanho e
 * minúsculas em sequência. Segredo é:
 * - um pedaço de 20+ caracteres que mistura letra e dígito (hex, base64 sem
 *   separador), ou
 * - a corrida inteira variada e picotada, exceto camelCase puro (palavras coladas
 *   trocam de caixa, mas só nas fronteiras).
 */
function looksRandom(run: string): boolean {
  if (CAMEL_WORDS.test(run)) return false
  if (run.split(/[/_-]+/).some((piece) => piece.length >= 20 && /\d/.test(piece) && /[A-Za-z]/.test(piece))) return true
  return entropy(run) >= MIN_DIVERSITY * Math.log2(Math.min(run.length, 64)) && classChanges(run) >= MIN_CLASS_CHANGES
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
