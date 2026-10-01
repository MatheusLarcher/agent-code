// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { concatSamples, encodeWavPcm16, isWav, mixToMono, noiseFloor, parseWav, resample, withNoiseFloor } from './pcm'
import { dominantHz, rms, sine } from './testSignals'

describe('WAV', () => {
  it('round-trips mono PCM16 at 24 kHz with a correct header', () => {
    const x = sine(440, 24000, 0.5)
    const wav = encodeWavPcm16(x, 24000)
    expect(wav.length).toBe(44 + x.length * 2)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt16LE(20)).toBe(1) // PCM
    expect(wav.readUInt16LE(22)).toBe(1) // mono
    expect(wav.readUInt32LE(24)).toBe(24000)
    expect(wav.readUInt16LE(34)).toBe(16)
    const back = parseWav(wav)
    expect(back.sampleRate).toBe(24000)
    expect(back.channels).toHaveLength(1)
    for (let i = 0; i < x.length; i += 97) expect(back.channels[0][i]).toBeCloseTo(x[i], 3)
  })

  it('clips out-of-range samples instead of wrapping', () => {
    const wav = encodeWavPcm16(Float32Array.from([2, -2]), 16000)
    expect(wav.readInt16LE(44)).toBe(32767)
    expect(wav.readInt16LE(46)).toBe(-32768)
  })

  it('parses float32 stereo and 24-bit files, skipping unknown chunks', () => {
    const frames = 4
    const mk = (tag: number, bits: number, ch: number, write: (b: Buffer, o: number, i: number, c: number) => void): Buffer => {
      const bytes = (bits / 8) * ch * frames
      const b = Buffer.alloc(12 + 8 + 4 + 24 + 8 + bytes)
      b.write('RIFF', 0, 'ascii')
      b.writeUInt32LE(b.length - 8, 4)
      b.write('WAVE', 8, 'ascii')
      b.write('LIST', 12, 'ascii')
      b.writeUInt32LE(4, 16)
      b.write('junk', 20, 'ascii')
      b.write('fmt ', 24, 'ascii')
      b.writeUInt32LE(16, 28)
      b.writeUInt16LE(tag, 32)
      b.writeUInt16LE(ch, 34)
      b.writeUInt32LE(8000, 36)
      b.writeUInt16LE(bits, 46)
      b.write('data', 48, 'ascii')
      b.writeUInt32LE(bytes, 52)
      let o = 56
      for (let i = 0; i < frames; i++)
        for (let c = 0; c < ch; c++) {
          write(b, o, i, c)
          o += bits / 8
        }
      return b
    }
    const f = parseWav(mk(3, 32, 2, (b, o, i, c) => b.writeFloatLE(c === 0 ? 0.25 : -0.25, o)))
    expect(f.channels).toHaveLength(2)
    expect(Array.from(f.channels[0])).toEqual([0.25, 0.25, 0.25, 0.25])
    expect(Array.from(mixToMono(f.channels))).toEqual([0, 0, 0, 0])
    const p24 = parseWav(mk(1, 24, 1, (b, o) => b.writeIntLE(-4194304, o, 3)))
    expect(p24.channels[0][0]).toBeCloseTo(-0.5, 6)
  })

  it('rejects what is not a WAV', () => {
    expect(isWav(new Uint8Array([1, 2, 3]))).toBe(false)
    expect(() => parseWav(new Uint8Array(20))).toThrow(/RIFF/)
  })
})

describe('resample', () => {
  it('48 kHz → 16 kHz keeps length ratio and pitch', () => {
    const y = resample(sine(440, 48000, 1), 48000, 16000)
    expect(y.length).toBe(16000)
    expect(dominantHz(y, 16000)).toBeCloseTo(440, -1)
    expect(rms(y)).toBeGreaterThan(0.3)
  })

  it('filters content above the new Nyquist instead of aliasing it', () => {
    const y = resample(sine(12000, 48000, 0.5), 48000, 16000) // 12 kHz > 8 kHz Nyquist
    expect(rms(y)).toBeLessThan(0.02)
  })

  it('24 kHz → 16 kHz and identity', () => {
    const x = sine(300, 24000, 0.5)
    expect(resample(x, 24000, 24000)).toBe(x)
    expect(resample(x, 24000, 16000).length).toBe(8000)
  })
})

describe('concatSamples', () => {
  it('joins with silence gaps between parts only', () => {
    const out = concatSamples([Float32Array.from([1, 1]), Float32Array.from([2])], 3)
    expect(Array.from(out)).toEqual([1, 1, 0, 0, 0, 2])
    expect(concatSamples([], 5).length).toBe(0)
  })
})

describe('noise floor', () => {
  // A PCM16 sample that encodes to exactly 0 is what makes the device go idle.
  const zeroAfterEncode = (x: Float32Array): number => {
    const wav = encodeWavPcm16(x, 24000)
    let zeros = 0
    for (let i = 0; i < x.length; i++) if (wav.readInt16LE(44 + i * 2) === 0) zeros++
    return zeros
  }

  it('noiseFloor has no digital-zero runs and stays inaudible (< -60 dBFS)', () => {
    const n = noiseFloor(24000)
    expect(n.length).toBe(24000)
    expect(rms(n)).toBeGreaterThan(0)
    expect(20 * Math.log10(rms(n))).toBeLessThan(-60)
    expect(zeroAfterEncode(n)).toBeLessThan(n.length * 0.05)
  })

  it('withNoiseFloor prepends a lead-in and fills silence without changing speech', () => {
    const speech = new Float32Array(1000)
    speech.fill(0.5, 500)
    const out = withNoiseFloor(speech, 300)
    expect(out.length).toBe(1300)
    expect(zeroAfterEncode(out.subarray(0, 800))).toBeLessThan(800 * 0.05)
    for (let i = 800; i < 1300; i += 50) expect(out[i]).toBeCloseTo(0.5, 2)
  })
})
