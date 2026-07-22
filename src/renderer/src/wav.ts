/** Encode raw mono PCM (Float32 [-1,1] chunks, as delivered by the Web Audio
 *  capture) into a 16-bit WAV blob. Used by dictation so the audio sent to the
 *  STT API is uncompressed — MediaRecorder can only produce lossy webm/opus. */
export function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const buf = new ArrayBuffer(44 + total * 2)
  const v = new DataView(buf)
  const writeStr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  v.setUint32(4, 36 + total * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  v.setUint32(16, 16, true) // fmt chunk size
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true) // byte rate
  v.setUint16(32, 2, true) // block align
  v.setUint16(34, 16, true) // bits per sample
  writeStr(36, 'data')
  v.setUint32(40, total * 2, true)
  let off = 44
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++, off += 2) {
      const s = Math.max(-1, Math.min(1, c[i]))
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    }
  }
  return new Blob([buf], { type: 'audio/wav' })
}
