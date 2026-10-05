/**
 * Remembered "don't use the GPU" verdicts for the Parakeet encoder, kept in
 * `parakeet-gpu.json` in the model cache so a broken or slow GPU doesn't cost a
 * failed session + warm-up on every launch.
 *
 * A verdict stops counting when:
 *   - onnxruntime-node changed (new runtime, new execution providers); or
 *   - it was an ERROR (session/warm-up crashed) and is older than ERROR_TTL_MS —
 *     a driver update can fix those, so they get retried now and then.
 * Slowness is a property of the hardware and only expires with the runtime.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const VERDICT_FILE = 'parakeet-gpu.json'
/** How long a GPU error keeps the encoder on the CPU before trying the GPU again. */
export const ERROR_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type VerdictKind = 'slow' | 'error'

export interface Verdict {
  kind: VerdictKind
  reason: string
  /** onnxruntime-node version that produced it. */
  runtime: string
  /** Epoch ms. */
  at: number
}

type VerdictMap = Record<string, Verdict>

function isVerdict(v: unknown): v is Verdict {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (o.kind === 'slow' || o.kind === 'error') && typeof o.reason === 'string' && typeof o.runtime === 'string' && typeof o.at === 'number'
}

export function readVerdicts(dir: string): VerdictMap {
  const file = join(dir, VERDICT_FILE)
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    // Old plain-string entries (no runtime/date) are dropped: one more warm-up.
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => isVerdict(v))) as VerdictMap
  } catch {
    return {}
  }
}

/** Reason to skip the GPU `device`, or undefined when it should be tried. */
export function activeVerdict(dir: string, device: string, runtime: string, now = Date.now()): string | undefined {
  const v = readVerdicts(dir)[device]
  if (!v || v.runtime !== runtime) return undefined
  if (v.kind === 'error' && now - v.at > ERROR_TTL_MS) return undefined
  return v.reason
}

export function rememberVerdict(dir: string, device: string, kind: VerdictKind, reason: string, runtime: string, now = Date.now()): void {
  try {
    const next: VerdictMap = { ...readVerdicts(dir), [device]: { kind, reason, runtime, at: now } }
    writeFileSync(join(dir, VERDICT_FILE), JSON.stringify(next, null, 2))
  } catch {
    /* a read-only cache only costs the check again next launch */
  }
}

/** A GPU that worked: forget any old verdict so the file doesn't lie. */
export function clearVerdict(dir: string, device: string): void {
  const all = readVerdicts(dir)
  if (!(device in all)) return
  delete all[device]
  try {
    writeFileSync(join(dir, VERDICT_FILE), JSON.stringify(all, null, 2))
  } catch {
    /* harmless */
  }
}
