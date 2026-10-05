/**
 * Long dictations are transcribed in windows. Parakeet's encoder uses full
 * self-attention: memory and time grow with the square of the length, so a
 * multi-minute clip in one pass can exhaust a laptop GPU (or RAM on the CPU),
 * and one pass gives no progress. 20 s windows keep each pass small and fast;
 * a dictation segment (cut by the Composer's VAD at pauses) rarely needs more
 * than one.
 *
 * Each cut lands on the quietest 20 ms of the window's last few seconds — a
 * pause between words — so no word is split in half and nothing has to be
 * stitched back (no overlap, no duplicated words).
 */

export const CHUNK_MAX_SEC = 20
/** How far back from a window's end the cut may move looking for a pause. */
export const CHUNK_SEARCH_SEC = 4
/** The last window is never shorter than this (a sliver gives the model nothing to hear). */
const MIN_TAIL_SEC = 1
const FRAME_SEC = 0.02

/** [start, end) sample ranges covering the whole clip, in order. */
export function planChunks(
  pcm: Float32Array,
  rate = 16000,
  maxSec = CHUNK_MAX_SEC,
  searchSec = CHUNK_SEARCH_SEC
): Array<[number, number]> {
  const max = Math.round(maxSec * rate)
  const search = Math.round(searchSec * rate)
  const frame = Math.max(1, Math.round(FRAME_SEC * rate))
  const minTail = Math.round(MIN_TAIL_SEC * rate)
  const out: Array<[number, number]> = []
  let start = 0
  while (pcm.length - start > max) {
    const hi = Math.min(start + max, pcm.length - minTail) // cut no later than this
    const lo = Math.max(start + 1, hi - search) // nor earlier than this
    out.push([start, (start = quietestPoint(pcm, lo, hi, frame))])
  }
  out.push([start, pcm.length])
  return out
}

/** Middle of the lowest-energy frame within [lo, hi]. */
function quietestPoint(pcm: Float32Array, lo: number, hi: number, frame: number): number {
  let best = hi
  let bestEnergy = Infinity
  for (let f = lo; f + frame <= hi; f += frame) {
    let e = 0
    for (let i = f; i < f + frame; i++) e += pcm[i] * pcm[i]
    if (e < bestEnergy) {
      bestEnergy = e
      best = f + (frame >> 1)
    }
  }
  return best
}
