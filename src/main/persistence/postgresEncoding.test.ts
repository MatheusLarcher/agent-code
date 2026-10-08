import { describe, expect, it } from 'vitest'
import { decodePostgresJson, decodePostgresText, encodePostgresJson, encodePostgresText } from './postgresEncoding'

const MARKER = '\u{E000}agent-code-pg-escape:'

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

  it('keeps the exact wire format and leaves an unknown escape untouched', () => {
    expect(encodePostgresText(`a\0b${MARKER}c`)).toBe(`a${MARKER}0b${MARKER}ec`)
    expect(decodePostgresText(`a${MARKER}0b${MARKER}ec`)).toBe(`a\0b${MARKER}c`)
    expect(decodePostgresText(`${MARKER}x${MARKER}`)).toBe(`${MARKER}x${MARKER}`)
    expect(encodePostgresText('')).toBe('')
    expect(decodePostgresText('')).toBe('')
  })

  // Uma sessão com screenshots em base64 tem ~100 MB de strings. Decodificar
  // concatenando caractere a caractere retinha ~32 bytes por caractere (GBs) e
  // derrubava o processo principal por falta de memória ao retomar a conversa.
  it('decodes a large string without retaining memory proportional to its length', () => {
    const big = 'A'.repeat(4_000_000)
    const before = process.memoryUsage().heapUsed
    const decoded = decodePostgresText(big)
    const retainedMb = (process.memoryUsage().heapUsed - before) / 1_048_576
    expect(decoded.length).toBe(big.length)
    expect(retainedMb).toBeLessThan(40)
  })
})
