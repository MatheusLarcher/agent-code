/** Test-only signal helpers (not imported by the engine). */

export const sine = (freq: number, rate: number, seconds: number, amp = 0.5): Float32Array =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate))

/** Estimated frequency from zero crossings, ignoring the first/last 10%. */
export function dominantHz(x: Float32Array, rate: number): number {
  const a = Math.floor(x.length * 0.1)
  const b = Math.floor(x.length * 0.9)
  let crossings = 0
  for (let i = a + 1; i < b; i++) if (x[i - 1] < 0 !== x[i] < 0) crossings++
  return crossings / 2 / ((b - a) / rate)
}

export const rms = (x: Float32Array): number => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(1, x.length))
