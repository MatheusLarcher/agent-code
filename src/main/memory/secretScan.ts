/**
 * Heuristic secret detection for memory bodies. It exists to keep an obvious
 * credential out of the Markdown/index and out of the proposal queue, NOT as a
 * complete secret detector: a value with no recognizable shape (a short
 * password, a plain word used as a token) passes through, and a random-looking
 * identifier can match. Callers must treat a clean result as "nothing obvious
 * found", never as proof that the text carries no secret.
 */

/** `{{secret:<name>}}` — what replaces the value in the stored Markdown. */
export const SECRET_PLACEHOLDER_PREFIX = '{{secret:'
export const SECRET_PLACEHOLDER_SUFFIX = '}}'
/** Names are also vault keys: same charset the vault accepts. */
export const SECRET_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

export interface SecretMatch {
  /** The literal text to move into the vault. */
  value: string
  /** Which rule matched — shown to the user/model, never the value. */
  kind: string
}

export function secretPlaceholder(name: string): string {
  return `${SECRET_PLACEHOLDER_PREFIX}${name}${SECRET_PLACEHOLDER_SUFFIX}`
}

export function isSecretName(value: unknown): value is string {
  return typeof value === 'string' && SECRET_NAME_PATTERN.test(value)
}

interface Rule {
  kind: string
  pattern: RegExp
  /** Which capture group holds the value; 0 = whole match. */
  group?: number
}

// Ordered from most specific to most generic: the first rule that claims a span
// wins, so `password=sk-...` is reported once, as the provider key.
const RULES: readonly Rule[] = [
  { kind: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'openai-key', pattern: /\bsk-(?:proj-|ant-|or-v1-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g },
  { kind: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'google-key', pattern: /\bAIza[A-Za-z0-9_-]{35}/g },
  { kind: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: 'bearer-token', pattern: /\b[Bb]earer\s+([A-Za-z0-9._~+/-]{20,}=*)/g, group: 1 },
  // Connection strings: postgres://user:PASSWORD@host
  { kind: 'url-password', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s/@]{4,})@/g, group: 1 },
  // key=value / "key": "value" — the assignment is what makes it a secret, so a
  // sentence merely containing the word "senha" is not enough.
  // `(?<![A-Za-z])` instead of `\b`: `_` is a word char, so `\b` would miss the
  // very common `DB_PASSWORD=` / `CLIENT_SECRET=` shape.
  {
    kind: 'assigned-secret',
    pattern:
      /(?<![A-Za-z])(?:pass(?:word|wd)?|senha|secret|segredo|token|api[_-]?key|apikey|chave[_-]?api|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token)(?![A-Za-z])\s*[:=]\s*["'`]?([^\s"'`,;)]{6,})["'`]?/gi,
    group: 1
  }
]

/** Values that match a rule's shape but carry no secret. */
const PLACEHOLDERS =
  /^(?:x{3,}|\*{3,}|\.{3,}|<[^>]*>|\{\{[^}]*\}\}|\$\{[^}]*\}|null|none|undefined|empty|vazio|todo|changeme|your[_-]?\w+|seu[_-]?\w+|preencha\w*|redacted|omitido|example|exemplo|placeholder|secret|senha|password|token|apikey|api[_-]?key)$/i

function isPlaceholder(value: string): boolean {
  if (PLACEHOLDERS.test(value)) return true
  // `password=<preencha aqui>`: the value stops at the space, so the closing
  // `>` never arrives — an opening bracket alone is enough to treat as a hole.
  if (value.startsWith('<') || value.startsWith('[') || value.startsWith('{')) return true
  // Already vaulted, or an env/template reference — nothing to move.
  return value.startsWith(SECRET_PLACEHOLDER_PREFIX) || value.startsWith('${') || value.startsWith('$env')
}

interface Span {
  start: number
  end: number
  match: SecretMatch
}

function collectSpans(text: string): Span[] {
  const spans: Span[] = []
  for (const rule of RULES) {
    // Fresh regex per call: /g state must not leak between invocations.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags)
    for (const found of text.matchAll(pattern)) {
      const group = rule.group ?? 0
      const value = found[group]
      if (typeof value !== 'string' || !value.trim() || isPlaceholder(value.trim())) continue
      const offset = group === 0 ? 0 : found[0].indexOf(value)
      if (offset < 0) continue
      const start = found.index + offset
      const end = start + value.length
      if (spans.some((span) => start < span.end && end > span.start)) continue
      spans.push({ start, end, match: { value, kind: rule.kind } })
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}

/**
 * Distinct secret-looking values, in the order they appear. Deduplicated by
 * value: the same key repeated twice is one vault entry replaced in both spots.
 */
export function scanSecrets(text: string): SecretMatch[] {
  if (typeof text !== 'string' || !text) return []
  const seen = new Set<string>()
  const matches: SecretMatch[] = []
  for (const span of collectSpans(text)) {
    if (seen.has(span.match.value)) continue
    seen.add(span.match.value)
    matches.push(span.match)
  }
  return matches
}

/**
 * Replaces every occurrence of each value with its placeholder. Longest value
 * first, so a value contained inside another is not partially replaced.
 */
export function redactSecrets(text: string, assignments: ReadonlyMap<string, string>): string {
  let output = text
  const byLength = [...assignments].sort((a, b) => b[0].length - a[0].length)
  for (const [value, name] of byLength) {
    if (!value) continue
    output = output.split(value).join(secretPlaceholder(name))
  }
  return output
}

/** `<memory-slug>.1`, `.2`… — stable, readable, and a valid vault name. */
export function derivedSecretName(relPath: string, index: number): string {
  const base = relPath
    .replace(/\.md$/i, '')
    .replace(/[\\/]+/g, '.')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[^a-zA-Z0-9]+/, '')
    .slice(0, 100)
  return `${base || 'memoria'}.${index}`
}
