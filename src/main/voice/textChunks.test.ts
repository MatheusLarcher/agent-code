// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { MAX_PHONEMES, planKokoroChunks } from './textChunks'

const identity = (s: string): string => s

describe('planKokoroChunks', () => {
  it('splits ~1500 chars of text into sentence pieces, all under the token budget, losing nothing', async () => {
    const sentence = 'A voz local lê este parágrafo inteiro sem cortar nada no meio. '
    const text = sentence.repeat(24).trim() // ≈ 1500 chars
    expect(text.length).toBeGreaterThan(1400)
    const chunks = await planKokoroChunks(text, identity)
    expect(chunks.length).toBeGreaterThan(5)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_PHONEMES)
    expect(chunks.join(' ').split(/\s+/)).toEqual(text.split(/\s+/))
  })

  it('halves a piece whose phonemes blow past the budget (numbers expand in eSpeak)', async () => {
    const inflate = (s: string): string => s.replace(/\S/g, 'xxxx') // 4 phonemes per char
    const text = 'um dois três quatro cinco seis sete oito nove dez onze doze treze catorze quinze dezesseis dezessete'
    const chunks = await planKokoroChunks(text, inflate, 120)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(120)
    expect(chunks.join(' ').split(/\s+/)).toHaveLength(text.split(/\s+/).length)
  })

  it('cuts a single impossible word instead of recursing forever', async () => {
    const chunks = await planKokoroChunks('a'.repeat(50), (s) => s.repeat(20), 100)
    expect(chunks).toEqual(['a'.repeat(100)])
  })

  it('ignores empty text and pieces that phonemize to nothing', async () => {
    expect(await planKokoroChunks('   ', identity)).toEqual([])
    expect(await planKokoroChunks('Oi. Tudo bem?', () => '')).toEqual([])
  })
})
