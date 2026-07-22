import { describe, expect, it } from 'vitest'
import { encodeWav } from './wav'

const bytes = async (b: Blob): Promise<DataView> => new DataView(await b.arrayBuffer())

describe('encodeWav', () => {
  it('builds a valid 16-bit mono PCM header', async () => {
    const blob = encodeWav([new Float32Array([0, 0.5, -0.5])], 48000)
    expect(blob.type).toBe('audio/wav')
    expect(blob.size).toBe(44 + 3 * 2)
    const v = await bytes(blob)
    const str = (off: number, len: number): string =>
      Array.from({ length: len }, (_, i) => String.fromCharCode(v.getUint8(off + i))).join('')
    expect(str(0, 4)).toBe('RIFF')
    expect(str(8, 4)).toBe('WAVE')
    expect(v.getUint16(20, true)).toBe(1) // PCM
    expect(v.getUint16(22, true)).toBe(1) // mono
    expect(v.getUint32(24, true)).toBe(48000)
    expect(v.getUint16(34, true)).toBe(16)
    expect(v.getUint32(40, true)).toBe(6) // data bytes
  })

  it('concatenates chunks and clamps samples to int16 range', async () => {
    const blob = encodeWav([new Float32Array([1]), new Float32Array([-1, 2, -2])], 16000)
    const v = await bytes(blob)
    expect(v.getInt16(44, true)).toBe(0x7fff)
    expect(v.getInt16(46, true)).toBe(-0x8000)
    expect(v.getInt16(48, true)).toBe(0x7fff) // clamped
    expect(v.getInt16(50, true)).toBe(-0x8000) // clamped
  })
})
