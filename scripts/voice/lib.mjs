// Shared helpers for the voice scripts (e2e + benchmark). They drive the BUILT
// engine (out/main/voice.js + voiceWorker.js), so run `npx electron-vite build`
// (or `npm run build`) first.
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export async function loadEngine() {
  const bundle = join(repo, 'out', 'main', 'voice.js')
  if (!existsSync(bundle)) throw new Error(`${bundle} não existe — rode "npx electron-vite build" antes`)
  return import(pathToFileURL(bundle).href)
}

export function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

export function dirArg(name, fallback) {
  const dir = resolve(arg(name, fallback))
  mkdirSync(dir, { recursive: true })
  return dir
}

export const defaultCache = join(tmpdir(), 'agent-code-voice-models')

/** Lower-case, strip accents and punctuation, collapse spaces. */
export function normalizeWords(s) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** Word error rate (Levenshtein over words) of `hyp` against `ref`. */
export function wer(ref, hyp) {
  const r = normalizeWords(ref)
  const h = normalizeWords(hyp)
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)])
  for (let j = 1; j <= h.length; j++) d[0][j] = j
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1))
  return r.length ? d[r.length][h.length] / r.length : 0
}

/** Measure the host event loop while `fn` runs: max and p99 timer lateness. */
export async function withLoopProbe(fn) {
  const lags = []
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    lags.push(now - last - 10)
    last = now
  }, 10)
  try {
    const result = await fn()
    return { result, ticks: lags.length, maxLagMs: Math.max(0, ...lags), p99LagMs: pct(lags, 0.99) }
  } finally {
    clearInterval(timer)
  }
}

export function pct(xs, q) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}

export const fmt = (n, d = 2) => Number(n).toFixed(d)
