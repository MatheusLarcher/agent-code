/**
 * PCM helpers for the local voice engine: WAV encode/parse, channel mixdown,
 * resampling and concatenation. Pure functions — no I/O, no native code — so
 * they run the same in the worker, in the host and under vitest.
 */

export interface DecodedPcm {
  channels: Float32Array[]
  sampleRate: number
}

/** Encode mono float samples as a 16-bit PCM WAV (RIFF, little-endian). */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16) // fmt chunk size
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28) // byte rate
  buf.writeUInt16LE(2, 32) // block align
  buf.writeUInt16LE(16, 34) // bits per sample
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2)
  }
  return buf
}

/** True when the bytes start with a RIFF/WAVE header. */
export function isWav(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE'
}

/**
 * Parse a WAV file: integer PCM 8/16/24/32-bit, IEEE float 32/64-bit and
 * WAVE_FORMAT_EXTENSIBLE wrapping either. Throws on anything else.
 */
export function parseWav(bytes: Uint8Array): DecodedPcm {
  if (!isWav(bytes)) throw new Error('WAV inválido: cabeçalho RIFF/WAVE ausente')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let fmt: { tag: number; channels: number; rate: number; bits: number } | null = null
  let data: { start: number; size: number } | null = null
  let o = 12
  while (o + 8 <= bytes.length) {
    const id = ascii(bytes, o, 4)
    const size = view.getUint32(o + 4, true)
    const body = o + 8
    if (id === 'fmt ' && size >= 16) {
      let tag = view.getUint16(body, true)
      if (tag === 0xfffe && size >= 26) tag = view.getUint16(body + 24, true) // extensible → subformat
      fmt = { tag, channels: view.getUint16(body + 2, true), rate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) }
    } else if (id === 'data') {
      // Streams written live (MediaRecorder → WAV writers) may leave the size 0 or oversized.
      const avail = bytes.length - body
      data = { start: body, size: size === 0 || size > avail ? avail : size }
      break
    }
    o = body + size + (size & 1)
  }
  if (!fmt) throw new Error('WAV inválido: sem bloco fmt')
  if (!data) throw new Error('WAV inválido: sem bloco data')
  if (fmt.channels < 1 || fmt.rate < 1) throw new Error('WAV inválido: canais/taxa')
  const bytesPer = fmt.bits / 8
  const isFloat = fmt.tag === 3
  if (!(fmt.tag === 1 || isFloat) || (isFloat && fmt.bits !== 32 && fmt.bits !== 64) || (!isFloat && ![8, 16, 24, 32].includes(fmt.bits))) {
    throw new Error(`WAV não suportado (formato ${fmt.tag}, ${fmt.bits} bits)`)
  }
  const frames = Math.floor(data.size / (bytesPer * fmt.channels))
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames))
  let p = data.start
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      let v: number
      if (isFloat) v = fmt.bits === 32 ? view.getFloat32(p, true) : view.getFloat64(p, true)
      else if (fmt.bits === 8) v = (view.getUint8(p) - 128) / 128
      else if (fmt.bits === 16) v = view.getInt16(p, true) / 32768
      else if (fmt.bits === 24) v = (((view.getUint8(p + 2) << 24) | (view.getUint8(p + 1) << 16) | (view.getUint8(p) << 8)) >> 8) / 8388608
      else v = view.getInt32(p, true) / 2147483648
      channels[c][i] = v
      p += bytesPer
    }
  }
  return { channels, sampleRate: fmt.rate }
}

/** Average all channels into one. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0]
  const n = Math.min(...channels.map((c) => c.length))
  const out = new Float32Array(n)
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i]
  for (let i = 0; i < n; i++) out[i] /= channels.length
  return out
}

/**
 * Band-limited resampling (windowed-sinc, Blackman window). When
 * downsampling the cutoff drops to the target Nyquist so 48 kHz → 16 kHz
 * does not alias speech sibilants into the band the speech recognizer listens to.
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input
  const ratio = toRate / fromRate
  const outLen = Math.max(1, Math.round(input.length * ratio))
  const out = new Float32Array(outLen)
  const cutoff = Math.min(1, ratio) * 0.95 // fraction of the input Nyquist
  const half = 16 // taps on each side, in output-rate units when downsampling
  const radius = Math.ceil(half / Math.min(1, ratio))
  for (let i = 0; i < outLen; i++) {
    const center = i / ratio
    const lo = Math.max(0, Math.ceil(center - radius))
    const hi = Math.min(input.length - 1, Math.floor(center + radius))
    let acc = 0
    let norm = 0
    for (let k = lo; k <= hi; k++) {
      const x = k - center
      const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / radius) + 0.08 * Math.cos((2 * Math.PI * x) / radius)
      const s = x === 0 ? cutoff : Math.sin(Math.PI * cutoff * x) / (Math.PI * x)
      const h = s * w
      acc += input[k] * h
      norm += h
    }
    out[i] = norm !== 0 ? acc / norm : 0
  }
  return out
}

/** Join sample blocks, inserting `gapSamples` of silence between them. */
export function concatSamples(parts: Float32Array[], gapSamples = 0): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0) + Math.max(0, parts.length - 1) * gapSamples
  const out = new Float32Array(total)
  let o = 0
  parts.forEach((p, i) => {
    if (i > 0) o += gapSamples
    out.set(p, o)
    o += p.length
  })
  return out
}

/**
 * Peak of the noise floor: ±16 PCM16 steps, ≈ -71 dBFS RMS — inaudible, but
 * never encodes to digital zero. Many Windows outputs (Realtek power saving,
 * Bluetooth, HDMI) go idle on pure digital silence and swallow the first
 * 100–300 ms once sound starts; Kokoro opens every clip with ~180 ms of zeros,
 * so the idle device woke up only at the first syllable and cut it.
 */
const NOISE_PEAK = 16 / 32768

/** `length` samples of the noise floor (deterministic xorshift, uniform). */
export function noiseFloor(length: number): Float32Array {
  const out = new Float32Array(Math.max(0, length))
  let s = 0x9e3779b9
  const next = (): number => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 0x100000000
  }
  for (let i = 0; i < out.length; i++) out[i] = (next() * 2 - 1) * NOISE_PEAK
  return out
}

/** `leadSamples` of noise floor, then `samples` with the floor mixed in. */
export function withNoiseFloor(samples: Float32Array, leadSamples = 0): Float32Array {
  const lead = Math.max(0, leadSamples)
  const out = noiseFloor(lead + samples.length)
  for (let i = 0; i < samples.length; i++) out[lead + i] += samples[i]
  return out
}

function ascii(bytes: Uint8Array, start: number, len: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + len))
}
