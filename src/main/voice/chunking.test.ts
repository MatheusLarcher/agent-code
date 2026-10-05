// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { CHUNK_MAX_SEC, planChunks } from './chunking'

const RATE = 16000

/** "Speech" (a loud tone) with silent gaps at the given seconds. */
function speechWithPauses(totalSec: number, pausesAt: number[], pauseSec = 0.3): Float32Array {
  const pcm = Float32Array.from({ length: totalSec * RATE }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / RATE))
  for (const p of pausesAt) pcm.fill(0, Math.round(p * RATE), Math.round((p + pauseSec) * RATE))
  return pcm
}

describe('planChunks (áudio longo em janelas)', () => {
  it('até 20 s: uma janela só', () => {
    expect(planChunks(new Float32Array(CHUNK_MAX_SEC * RATE))).toEqual([[0, CHUNK_MAX_SEC * RATE]])
    expect(planChunks(new Float32Array(0))).toEqual([[0, 0]])
  })

  it('75 s: janelas contíguas de no máximo 20 s que cobrem tudo, cortadas nas pausas', () => {
    const pcm = speechWithPauses(75, [17.5, 35, 52.6, 70])
    const chunks = planChunks(pcm)
    expect(chunks[0][0]).toBe(0)
    expect(chunks.at(-1)![1]).toBe(pcm.length)
    for (let i = 1; i < chunks.length; i++) expect(chunks[i][0]).toBe(chunks[i - 1][1])
    for (const [a, b] of chunks) expect(b - a).toBeLessThanOrEqual(CHUNK_MAX_SEC * RATE)
    // Each cut sits inside a pause (silence), never in the middle of the tone.
    for (const [, b] of chunks.slice(0, -1)) expect(pcm[b]).toBe(0)
    expect(chunks.slice(0, -1).map(([, b]) => Math.floor(b / RATE))).toEqual([17, 35, 52, 70])
  })

  it('sem pausa nenhuma ainda corta (no fim da janela) e a última janela não fica minúscula', () => {
    const pcm = speechWithPauses(41, [])
    const chunks = planChunks(pcm)
    for (const [a, b] of chunks) expect(b - a).toBeLessThanOrEqual(CHUNK_MAX_SEC * RATE)
    const [a, b] = chunks.at(-1)!
    expect(b - a).toBeGreaterThanOrEqual(RATE)
  })
})
