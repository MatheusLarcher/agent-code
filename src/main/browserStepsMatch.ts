import { ACTION_TYPES, type FieldInfo, type FieldOption } from './browserFields'

/** Pure half of browser_run_steps: types, validation, target matching, result. */

export const STEP_ACTIONS = ['fill', 'click', 'select', 'check', 'uncheck', 'press', 'wait_for', 'navigate'] as const
export type StepAction = (typeof STEP_ACTIONS)[number]

export interface StepTarget {
  ref?: string
  label?: string
  text?: string
}

export interface BrowserStep {
  action: StepAction
  target?: StepTarget
  value?: string | string[]
  timeoutMs?: number
}

export interface Candidate {
  ref: string
  type: string
  label: string
}

/** Same shape as the windows_run_steps failedStep (i is the 0-based step index). */
export interface FailedStep {
  i: number
  action: string
  target?: StepTarget
  error: string
  candidates?: Candidate[]
}

export type Outcome = 'expect' | 'navigated' | 'invalid' | 'timeout'

export interface RunStepsResult {
  ok: boolean
  done: number
  total: number
  failedStep?: FailedStep
  outcome: Outcome
  message?: string
  invalid?: string[]
  url: string
  state: string
}

export const MAX_STEPS = 500
export const MAX_EXPECT = 500
export const DEFAULT_STEP_TIMEOUT_MS = 5000
export const CALL_BUDGET_MS = 120_000
export const REF_RE = /^e\d+$/
const TARGETED = new Set<string>(['fill', 'click', 'select', 'check', 'uncheck'])
const VALUE_REQUIRED = new Set<string>(['fill', 'select', 'press', 'navigate'])
const ARRAY_OK = new Set<string>(['fill', 'select'])
const MAX_CANDIDATES = 10

/** Case/accent-insensitive key; also drops trailing ':' and '*' of labels. */
export function norm(s: string | null | undefined): string {
  return (s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s:*]+$/, '')
    .trim()
}

/** First problem of a step, or null. Shared by the zod schema and runSteps. */
export function stepProblem(step: unknown): string | null {
  if (!step || typeof step !== 'object') return 'step must be an object'
  const s = step as Record<string, unknown>
  const action = s.action as string
  if (!(STEP_ACTIONS as readonly string[]).includes(action)) return `unknown action "${String(action)}"`
  const t = s.target as StepTarget | undefined
  if (t !== undefined) {
    if (!t || typeof t !== 'object') return 'target must be an object'
    if (t.ref !== undefined && !REF_RE.test(String(t.ref))) return 'target.ref must look like e12'
    if (!t.ref && !t.label && !t.text) return 'target needs ref, label or text'
  }
  if (TARGETED.has(action) && !t) return `${action} needs target.ref, target.label or target.text`
  const v = s.value
  if (Array.isArray(v)) {
    if (!ARRAY_OK.has(action)) return `${action} value must be a string`
    if (!v.length || v.some((x) => typeof x !== 'string' || !x)) return 'value array needs non-empty strings'
  } else if (v !== undefined && typeof v !== 'string') return 'value must be a string or string[]'
  if (VALUE_REQUIRED.has(action) && (v === undefined || (action !== 'fill' && v === '')))
    return `${action} needs value`
  if (action === 'wait_for' && !t && !v) return 'wait_for needs target or value (text to appear)'
  const ms = s.timeoutMs
  if (ms !== undefined && (!Number.isInteger(ms) || (ms as number) < 100 || (ms as number) > 30_000))
    return 'timeoutMs must be an integer 100..30000'
  return null
}

export function validateSteps(steps: unknown, expect?: unknown): string | null {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_STEPS) return `steps needs 1..${MAX_STEPS} items`
  if (expect !== undefined && (typeof expect !== 'string' || expect.length > MAX_EXPECT))
    return `expect must be a string up to ${MAX_EXPECT} chars`
  for (let i = 0; i < steps.length; i++) {
    const p = stepProblem(steps[i])
    if (p) return `steps[${i}]: ${p}`
  }
  return null
}

/** Matching variants of a label: "Name (First Name)" also answers to each part. */
function variants(label: string): string[] {
  const m = /^(.*) \((.*)\)$/.exec(label)
  return m ? [label, m[1], m[2]] : [label]
}

/** Exact tier beats contains tier; returns the hits of the best non-empty tier. */
export function bestTier<T>(items: T[], keys: (t: T) => string[], query: string): T[] {
  const q = norm(query)
  if (!q) return []
  const exact = items.filter((it) => keys(it).some((k) => norm(k) === q))
  if (exact.length) return exact
  return items.filter((it) => keys(it).some((k) => norm(k).includes(q)))
}

export interface Hit extends Candidate {
  field: FieldInfo
  /** Set when the hit is one option of a radio group. */
  option?: FieldOption
}

export type TargetPick =
  | { kind: 'found'; hit: Hit }
  | { kind: 'ambiguous'; candidates: Candidate[] }
  | { kind: 'none' }

function decide(hits: Hit[]): TargetPick {
  const unique = hits.filter((h, i) => hits.findIndex((x) => x.ref === h.ref) === i)
  if (unique.length === 1) return { kind: 'found', hit: unique[0] }
  if (!unique.length) return { kind: 'none' }
  return {
    kind: 'ambiguous',
    candidates: unique.slice(0, MAX_CANDIDATES).map(({ ref, type, label }) => ({ ref, type, label }))
  }
}

/** {label}: field labels and radio option labels. */
export function pickByLabel(fields: FieldInfo[], label: string): TargetPick {
  const pool: Hit[] = []
  for (const f of fields) {
    if (ACTION_TYPES.has(f.type)) continue
    pool.push({ ref: f.ref, type: f.type, label: f.label, field: f })
    if (f.type !== 'radio') continue
    for (const o of f.options ?? []) {
      if (typeof o !== 'string') pool.push({ ref: o.ref, type: 'radio', label: o.label, field: f, option: o })
    }
  }
  return decide(bestTier(pool, (h) => variants(h.label), label))
}

/** {text}: buttons, submits and links by their visible text. */
export function pickByText(fields: FieldInfo[], text: string): TargetPick {
  const pool: Hit[] = fields
    .filter((f) => ACTION_TYPES.has(f.type))
    .map((f) => ({ ref: f.ref, type: f.type, label: f.label, field: f }))
  return decide(bestTier(pool, (h) => [h.label], text))
}

export type OptionPick = { kind: 'found'; index: number } | { kind: 'ambiguous'; indices: number[] } | { kind: 'none' }

/** Picks one option by text (exact > value > contains). */
export function pickOption(options: Array<{ label: string; value?: string }>, wanted: string): OptionPick {
  const idx = options.map((_, i) => i)
  let hits = bestTier(idx, (i) => [options[i].label], wanted)
  const q = norm(wanted)
  const exactLabel = hits.some((i) => norm(options[i].label) === q)
  if (!exactLabel) {
    const byValue = idx.filter((i) => options[i].value !== undefined && norm(options[i].value) === q)
    if (byValue.length) hits = byValue
  }
  if (hits.length === 1) return { kind: 'found', index: hits[0] }
  if (!hits.length) return { kind: 'none' }
  return { kind: 'ambiguous', indices: hits.slice(0, MAX_CANDIDATES) }
}

/** ok only when every step ran and was verified, nothing is invalid and, if
 *  an expect text was given, it was seen. */
export function buildResult(r: Omit<RunStepsResult, 'ok'>, expect?: string): RunStepsResult {
  const ok = !r.failedStep && r.done === r.total && r.outcome !== 'invalid' && (!expect || r.outcome === 'expect')
  return {
    ok,
    done: r.done,
    total: r.total,
    ...(r.failedStep ? { failedStep: r.failedStep } : {}),
    outcome: r.outcome,
    ...(r.message ? { message: r.message } : {}),
    ...(r.invalid?.length ? { invalid: r.invalid } : {}),
    url: r.url,
    state: r.state
  }
}

/** Tool text: compact JSON (without state) + blank line + state. */
export function resultText(r: RunStepsResult): string {
  const { state, ...rest } = r
  return `${JSON.stringify(rest)}\n\n${state}`
}
