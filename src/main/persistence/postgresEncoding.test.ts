import { describe, expect, it } from 'vitest'
import { decodePostgresJson, decodePostgresText, encodePostgresJson, encodePostgresText } from './postgresEncoding'

describe('PostgreSQL reversible encoding', () => {
  it('round-trips NUL and its own marker without changing the logical value', () => {
    const markerLike = '\u{E000}agent-code-pg-escape:0'
    const value = {
      [`key\0${markerLike}`]: `before\0after ${markerLike}`,
      nested: ['\0', markerLike, null, 1, true]
    }
    const encoded = encodePostgresJson(value)
    expect(JSON.stringify(encoded)).not.toContain('\\u0000')
    expect(decodePostgresJson(encoded)).toEqual(value)
    expect(decodePostgresText(encodePostgresText(`\0${markerLike}`))).toBe(`\0${markerLike}`)
  })
})
