import type { JsonValue } from './hashes'

const MARKER = '\u{E000}agent-code-pg-escape:'

export function encodePostgresText(value: string): string {
  let encoded = ''
  for (let index = 0; index < value.length;) {
    if (value.startsWith(MARKER, index)) {
      encoded += `${MARKER}e`
      index += MARKER.length
    } else if (value[index] === '\0') {
      encoded += `${MARKER}0`
      index += 1
    } else {
      encoded += value[index]
      index += 1
    }
  }
  return encoded
}

export function decodePostgresText(value: string): string {
  let decoded = ''
  for (let index = 0; index < value.length;) {
    if (value.startsWith(`${MARKER}0`, index)) {
      decoded += '\0'
      index += MARKER.length + 1
    } else if (value.startsWith(`${MARKER}e`, index)) {
      decoded += MARKER
      index += MARKER.length + 1
    } else {
      decoded += value[index]
      index += 1
    }
  }
  return decoded
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
