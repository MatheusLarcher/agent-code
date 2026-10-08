import type { JsonValue } from './hashes'

const MARKER = '\u{E000}agent-code-pg-escape:'
// Um replace só, nunca concatenação caractere a caractere: no V8 cada `+=` vira
// um nó de corda (~32 bytes por caractere) e uma sessão com screenshots em
// base64 (~100 MB) passava de 3 GB e derrubava o processo principal.
const ENCODE_RE = new RegExp(`${MARKER}|\\u0000`, 'g')
const DECODE_RE = new RegExp(`${MARKER}([0e])`, 'g')

export function encodePostgresText(value: string): string {
  return value.replace(ENCODE_RE, (match) => (match === '\0' ? `${MARKER}0` : `${MARKER}e`))
}

export function decodePostgresText(value: string): string {
  return value.replace(DECODE_RE, (_match, code: string) => (code === '0' ? '\0' : MARKER))
}

export function encodePostgresJson(value: JsonValue): JsonValue {
  if (typeof value === 'string') return encodePostgresText(value)
  if (Array.isArray(value)) return value.map(encodePostgresJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [encodePostgresText(key), encodePostgresJson(item)])
    )
  }
  return value
}

/**
 * Encodes a value AND serializes it for a `jsonb` parameter.
 *
 * Never pass a JS array straight to a jsonb column: node-postgres renders an
 * array as a Postgres ARRAY literal, not as JSON. `[]` arrives as `{}` — a
 * silently wrong empty OBJECT — and `['a','b']` becomes `{"a","b"}`, which
 * fails with `invalid input syntax for type json`. Explicit text is
 * unambiguous for every shape, so this is the only safe way in.
 */
export function encodePostgresJsonParam(value: JsonValue): string {
  return JSON.stringify(encodePostgresJson(value))
}

export function decodePostgresJson(value: JsonValue): JsonValue {
  if (typeof value === 'string') return decodePostgresText(value)
  if (Array.isArray(value)) return value.map(decodePostgresJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [decodePostgresText(key), decodePostgresJson(item)])
    )
  }
  return value
}
