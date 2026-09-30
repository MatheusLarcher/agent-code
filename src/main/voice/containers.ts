/**
 * Minimal demuxers for the containers a phone's MediaRecorder produces:
 * WebM/Matroska (Chrome/Android WebView: `audio/webm;codecs=opus`) and Ogg
 * (`audio/ogg;codecs=opus`). They only pull out the audio packets and the codec
 * header — decoding is done by libopus (opus-decoder, WASM) in audioDecode.ts.
 *
 * Why hand-rolled: the npm umbrella decoders (@audio/decode-webm etc.) pull the
 * GPL-2.0 FAAD2 AAC decoder as a hard dependency even for Opus-only use, and
 * ffmpeg.wasm is ~25 MB with poor Node support. Both containers are simple
 * enough to walk in a few dozen lines.
 */

export interface DemuxedAudio {
  /** Matroska CodecID (e.g. `A_OPUS`) or `A_OPUS` for Ogg Opus. */
  codec: string
  /** Codec header (OpusHead for Opus). */
  codecPrivate: Uint8Array | null
  packets: Uint8Array[]
}

export interface OpusHead {
  channels: number
  preSkip: number
  inputSampleRate: number
  mappingFamily: number
}

export function isWebm(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
}

export function isOgg(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53
}

/** Parse an `OpusHead` identification header (RFC 7845 §5.1). */
export function parseOpusHead(b: Uint8Array): OpusHead {
  if (b.length < 19 || String.fromCharCode(...b.subarray(0, 8)) !== 'OpusHead') throw new Error('cabeçalho OpusHead inválido')
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return { channels: b[9], preSkip: v.getUint16(10, true), inputSampleRate: v.getUint32(12, true), mappingFamily: b[18] }
}

// ---------------------------------------------------------------- WebM / EBML

// Master elements we step INTO; every other element is skipped whole.
const EBML_MASTERS = new Set([
  0x18538067, // Segment
  0x1f43b675, // Cluster
  0x1654ae6b, // Tracks
  0xae, // TrackEntry
  0xa0, // BlockGroup
  0xe1 // Audio
])

interface Vint {
  value: number
  len: number
  unknown: boolean
}

function readVint(b: Uint8Array, o: number, keepMarker: boolean): Vint {
  const first = b[o]
  if (first === undefined || first === 0) throw new Error('EBML: inteiro de tamanho variável inválido')
  let len = 1
  let mask = 0x80
  while (!(first & mask)) {
    mask >>= 1
    len++
  }
  let value = keepMarker ? first : first & (mask - 1)
  let allOnes = (first & (mask - 1)) === mask - 1
  for (let i = 1; i < len; i++) {
    const byte = b[o + i] ?? 0
    value = value * 256 + byte
    if (byte !== 0xff) allOnes = false
  }
  return { value, len, unknown: !keepMarker && allOnes }
}

function readUint(b: Uint8Array): number {
  let v = 0
  for (const byte of b) v = v * 256 + byte
  return v
}

/**
 * Walk a WebM/Matroska file flat: masters are entered (so live-recorded files
 * with unknown-size Segment/Cluster work), leaves are read or skipped. Returns
 * the packets of the first audio track.
 */
export function demuxWebm(b: Uint8Array): DemuxedAudio {
  interface Track { number: number; type: number; codec: string; priv: Uint8Array | null }
  const tracks: Track[] = []
  const blocks: { track: number; frames: Uint8Array[] }[] = []
  let o = 0
  while (o < b.length) {
    let id: Vint
    let size: Vint
    try {
      id = readVint(b, o, true)
      size = readVint(b, o + id.len, false)
    } catch {
      break // truncated tail (recording cut mid-element)
    }
    const body = o + id.len + size.len
    if (EBML_MASTERS.has(id.value)) {
      if (id.value === 0xae) tracks.push({ number: 0, type: 0, codec: '', priv: null })
      o = body
      continue
    }
    if (size.unknown) break
    const end = Math.min(b.length, body + size.value)
    const data = b.subarray(body, end)
    const track = tracks[tracks.length - 1]
    switch (id.value) {
      case 0xd7: if (track) track.number = readUint(data); break // TrackNumber
      case 0x83: if (track) track.type = readUint(data); break // TrackType
      case 0x86: if (track) track.codec = String.fromCharCode(...data); break // CodecID
      case 0x63a2: if (track) track.priv = data.slice(); break // CodecPrivate
      case 0xa3: // SimpleBlock
      case 0xa1: // Block
        if (end - body === size.value) blocks.push(parseBlock(data))
        break
    }
    o = body + size.value
  }
  const audio = tracks.find((t) => t.type === 2) ?? tracks.find((t) => t.codec.startsWith('A_'))
  if (!audio) throw new Error('WebM sem faixa de áudio')
  const packets: Uint8Array[] = []
  for (const blk of blocks) if (blk.track === audio.number) packets.push(...blk.frames)
  return { codec: audio.codec, codecPrivate: audio.priv, packets }
}

function parseBlock(d: Uint8Array): { track: number; frames: Uint8Array[] } {
  const tn = readVint(d, 0, false)
  let p = tn.len + 2 // track number + int16 timecode
  const flags = d[p++]
  const lacing = (flags >> 1) & 3
  if (lacing === 0) return { track: tn.value, frames: [d.slice(p)] }
  const count = d[p++] + 1
  const sizes: number[] = []
  if (lacing === 1) {
    // Xiph lacing: each size is a run of 255s plus a final byte.
    for (let i = 0; i < count - 1; i++) {
      let s = 0
      let byte: number
      do {
        byte = d[p++]
        s += byte
      } while (byte === 255)
      sizes.push(s)
    }
  } else if (lacing === 3) {
    // EBML lacing: first size as a vint, the rest as signed differences.
    const first = readVint(d, p, false)
    p += first.len
    sizes.push(first.value)
    for (let i = 1; i < count - 1; i++) {
      const diff = readVint(d, p, false)
      p += diff.len
      sizes.push(sizes[i - 1] + diff.value - (2 ** (7 * diff.len - 1) - 1))
    }
  } else {
    const each = Math.floor((d.length - p) / count)
    for (let i = 0; i < count - 1; i++) sizes.push(each)
  }
  sizes.push(d.length - p - sizes.reduce((a, s) => a + s, 0))
  const frames: Uint8Array[] = []
  for (const s of sizes) {
    frames.push(d.slice(p, p + s))
    p += s
  }
  return { track: tn.value, frames }
}

// ---------------------------------------------------------------------- Ogg

/**
 * Reassemble the packets of the first Opus logical stream in an Ogg file.
 * The OpusHead packet becomes `codecPrivate`; OpusTags is dropped.
 */
export function demuxOggOpus(b: Uint8Array): DemuxedAudio {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let serial: number | null = null
  let head: Uint8Array | null = null
  const packets: Uint8Array[] = []
  let partial: Uint8Array[] = []
  let o = 0
  while (o + 27 <= b.length && isOgg(b.subarray(o))) {
    const pageSerial = view.getUint32(o + 14, true)
    const nsegs = b[o + 26]
    const table = b.subarray(o + 27, o + 27 + nsegs)
    let p = o + 27 + nsegs
    const mine = serial === null || serial === pageSerial
    for (const seg of table) {
      if (mine) partial.push(b.subarray(p, Math.min(b.length, p + seg)))
      p += seg
      if (seg < 255 && mine) {
        const pkt = joinBytes(partial)
        partial = []
        if (serial === null) {
          if (pkt.length >= 8 && String.fromCharCode(...pkt.subarray(0, 8)) === 'OpusHead') {
            serial = pageSerial
            head = pkt
          }
        } else if (!(pkt.length >= 8 && String.fromCharCode(...pkt.subarray(0, 8)) === 'OpusTags')) {
          packets.push(pkt)
        }
      }
    }
    o = p
  }
  if (!head) throw new Error('Ogg sem fluxo Opus')
  return { codec: 'A_OPUS', codecPrivate: head, packets }
}

function joinBytes(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0].slice()
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0))
  let o = 0
  for (const x of parts) {
    out.set(x, o)
    o += x.length
  }
  return out
}
