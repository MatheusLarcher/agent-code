// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { demuxOggOpus, demuxWebm, isOgg, isWebm, parseOpusHead } from './containers'

// ------------------------------------------------------------ EBML builders
const idBytes = (id: number): number[] => {
  const out: number[] = []
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff)
  return out
}
const sizeBytes = (n: number): number[] => (n < 127 ? [0x80 | n] : [0x40 | (n >> 8), n & 0xff])
const el = (id: number, body: number[]): number[] => [...idBytes(id), ...sizeBytes(body.length), ...body]
const unknownSizeEl = (id: number, body: number[]): number[] => [...idBytes(id), 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...body]
const str = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))
const opusHead = (channels: number, preSkip: number): number[] => [...str('OpusHead'), 1, channels, preSkip & 0xff, preSkip >> 8, 0x80, 0xbb, 0, 0, 0, 0, 0]
const frame = (tag: number, len: number): number[] => Array.from({ length: len }, (_, i) => (i === 0 ? tag : 0xa3))
const block = (track: number, flags: number, payload: number[]): number[] => [0x80 | track, 0, 0, flags, ...payload]

describe('demuxWebm', () => {
  const tracks = el(0x1654ae6b, [
    ...el(0xae, [...el(0xd7, [2]), ...el(0x83, [1]), ...el(0x86, str('V_VP8'))]),
    ...el(0xae, [...el(0xd7, [1]), ...el(0x83, [2]), ...el(0x86, str('A_OPUS')), ...el(0x63a2, opusHead(1, 312))])
  ])
  const cluster1 = unknownSizeEl(0x1f43b675, [
    ...el(0xe7, [0]), // Timecode
    ...el(0xa3, block(1, 0x80, frame(1, 10))), // SimpleBlock, no lacing
    ...el(0xa3, block(2, 0x80, frame(99, 5))), // video track: ignored
    ...el(0xa0, el(0xa1, block(1, 0x02, [1, 3, ...frame(2, 3), ...frame(3, 4)]))), // Block, Xiph lacing 2 frames
    ...el(0xa3, block(1, 0x86, [2, 0x82, 0xc1,...frame(4, 2), ...frame(5, 4), ...frame(6, 1)])) // EBML lacing: 2, +2 → 4, rest 1
  ])
  const cluster2 = unknownSizeEl(0x1f43b675, [...el(0xa3, block(1, 0x84, [1, ...frame(7, 3), ...frame(8, 3)]))]) // fixed lacing
  const file = new Uint8Array([
    ...el(0x1a45dfa3, el(0x4282, str('webm'))),
    ...unknownSizeEl(0x18538067, [
      ...el(0x1549a966, [0xa3, 0x81, 0x00, 0xae]), // Info with bytes that look like elements: must be skipped whole
      ...tracks,
      ...cluster1,
      ...cluster2
    ])
  ])

  it('finds the audio track through unknown-size Segment/Cluster (live MediaRecorder files)', () => {
    expect(isWebm(file)).toBe(true)
    const d = demuxWebm(file)
    expect(d.codec).toBe('A_OPUS')
    expect(parseOpusHead(d.codecPrivate!)).toMatchObject({ channels: 1, preSkip: 312, mappingFamily: 0 })
    expect(d.packets.map((p) => [p[0], p.length])).toEqual([
      [1, 10],
      [2, 3],
      [3, 4],
      [4, 2],
      [5, 4],
      [6, 1],
      [7, 3],
      [8, 3]
    ])
  })

  it('stops cleanly on a truncated tail', () => {
    const d = demuxWebm(file.subarray(0, file.length - 4))
    expect(d.packets.length).toBe(6) // the cut fixed-laced block (frames 7 and 8) is dropped whole
  })

  it('refuses files without an audio track', () => {
    const noAudio = new Uint8Array([...el(0x1a45dfa3, []), ...unknownSizeEl(0x18538067, el(0x1654ae6b, el(0xae, [...el(0xd7, [1]), ...el(0x83, [1])])))])
    expect(() => demuxWebm(noAudio)).toThrow(/faixa de áudio/)
  })
})

// -------------------------------------------------------------- Ogg builder
const oggPage = (serial: number, laces: number[], data: number[], type = 0): number[] => {
  const h = new Uint8Array(27)
  h.set(str('OggS'), 0)
  h[5] = type
  new DataView(h.buffer).setUint32(14, serial, true)
  h[26] = laces.length
  return [...h, ...laces, ...data]
}

describe('demuxOggOpus', () => {
  const big = frame(9, 600) // spans two pages: 255 + 255 | 90
  const file = new Uint8Array([
    ...oggPage(7, [19], opusHead(2, 3840), 2),
    ...oggPage(8, [4], str('junk')), // another logical stream: ignored
    ...oggPage(7, [16], [...str('OpusTags'), 0, 0, 0, 0, 0, 0, 0, 0]),
    ...oggPage(7, [3, 255, 255], [...frame(1, 3), ...big.slice(0, 510)]),
    ...oggPage(7, [90, 5], [...big.slice(510), ...frame(2, 5)], 1)
  ])

  it('reassembles packets across pages, drops OpusTags and other streams', () => {
    expect(isOgg(file)).toBe(true)
    const d = demuxOggOpus(file)
    expect(parseOpusHead(d.codecPrivate!)).toMatchObject({ channels: 2, preSkip: 3840 })
    expect(d.packets.map((p) => [p[0], p.length])).toEqual([
      [1, 3],
      [9, 600],
      [2, 5]
    ])
  })

  it('refuses Ogg without Opus', () => {
    expect(() => demuxOggOpus(new Uint8Array(oggPage(1, [4], str('abcd'))))).toThrow(/Opus/)
  })
})
