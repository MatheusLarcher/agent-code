import type { Locator, Page } from 'playwright'
import { collectFields, formatState, type FieldOption, type FieldsSnapshot } from './browserFields'
import { gotoUrl } from './pageActions'
import {
  CALL_BUDGET_MS,
  DEFAULT_STEP_TIMEOUT_MS,
  buildResult,
  norm,
  pickByLabel,
  pickByText,
  pickOption,
  validateSteps,
  type BrowserStep,
  type Candidate,
  type FailedStep,
  type Outcome,
  type RunStepsResult,
  type StepTarget
} from './browserStepsMatch'
import { POLL_MS, arm, lineWith, sleep, waitOutcome } from './browserStepsOutcome'

/**
 * browser_run_steps: runs a whole plan of steps on the page in one call. Each
 * target is resolved right before its step (so dependent fields that appear
 * later still resolve), every action is verified, and the run stops at the
 * first failure or ambiguity.
 */

const CLICK_SETTLE_MS = 1500
const FINAL_EXPECT_MS = 5000
const FINAL_PLAIN_MS = 1000
const ACTION_MAX_MS = 5000
const CLICK_MS = 2500
const TOGGLE_MS = 1500
const EVAL_MS = 2000
const DATE_LIKE = /^(date|time|datetime-local|month|week|color|range)$/

class StepError extends Error {
  constructor(
    message: string,
    readonly candidates?: Candidate[]
  ) {
    super(message)
  }
}

const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 300)
const refLocator = (page: Page, ref: string): Locator => page.locator(`[data-ac-ref="${ref}"]`).first()

interface Resolved {
  loc: Locator
  ref: string
  /** The target was a radio option (by its own label). */
  option?: FieldOption
}

/** Polls until the target exists, is ambiguous (stops at once) or `until` passes. */
async function resolveTarget(page: Page, target: StepTarget, until: number): Promise<Resolved> {
  for (;;) {
    if (target.ref) {
      const loc = refLocator(page, target.ref)
      if ((await loc.count().catch(() => 0)) > 0) return { loc, ref: target.ref }
    } else {
      const snap = await collectFields(page, { linkLimit: 500, allLinks: true }).catch(() => null)
      if (snap) {
        const pick = target.label ? pickByLabel(snap.fields, target.label) : pickByText(snap.fields, target.text ?? '')
        if (pick.kind === 'ambiguous') throw new StepError('alvo ambíguo', pick.candidates)
        if (pick.kind === 'found') {
          return { loc: refLocator(page, pick.hit.ref), ref: pick.hit.ref, option: pick.hit.option }
        }
      }
    }
    if (Date.now() + POLL_MS > until) throw new StepError('alvo não encontrado')
    await sleep(POLL_MS)
  }
}

interface ElInfo {
  tag: string
  type: string
  role: string
  combo: boolean
  multiple: boolean
  actionable: boolean
  inDialog: boolean
}

/**
 * In-page: the react-select-like container of a control and its picked values
 * (chips or single value). Keep in sync with browserFields selectBox/boxValues.
 */
function comboInPage(el: Element): { box: boolean; values: string[]; input: string } {
  let box: Element | null = null
  for (let c = el.closest('[class*="-container"]'); c; c = c.parentElement?.closest('[class*="-container"]') ?? null) {
    if (c.querySelectorAll('input:not([type=hidden])').length > 1) break
    if (c.querySelector('[class*="indicatorContainer"]')) {
      box = c
      break
    }
  }
  const input = (el as HTMLInputElement).value ?? el.textContent ?? ''
  if (!box) return { box: false, values: [], input }
  const b = box
  const top = (sel: string): Element[] => {
    const all = [...b.querySelectorAll(sel)]
    return all.filter((x) => !all.some((y) => y !== x && y.contains(x)))
  }
  const clean = (s: string): string => s.replace(/\s+/g, ' ').trim()
  const text = (xs: Element[]): string[] => xs.map((x) => clean((x as HTMLElement).innerText || '')).filter(Boolean)
  // Chip text without its remove button ("×").
  const chipText = (x: Element): string => {
    const l = x.querySelector<HTMLElement>('[class*="label" i]')
    if (l) return clean(l.innerText || '')
    let t = (x as HTMLElement).innerText || ''
    for (const r of x.querySelectorAll<HTMLElement>('[role=button]')) t = t.replace(r.innerText || '', '')
    return clean(t)
  }
  const chips = top('[class*="multiValue"], [class*="multi-value"]').map(chipText).filter(Boolean)
  return { box: true, values: chips.length ? chips : text(top('[class*="singleValue"], [class*="single-value"]')), input }
}

async function describe(loc: Locator): Promise<ElInfo> {
  const base = await loc.evaluate(
    (el) => {
      const tag = el.tagName
      const type = tag === 'INPUT' ? (el as HTMLInputElement).type : ''
      return {
        tag,
        type,
        role: el.getAttribute('role') || '',
        multiple: tag === 'SELECT' && (el as HTMLSelectElement).multiple,
        actionable:
          tag === 'BUTTON' || tag === 'A' || /^(submit|button|image|reset)$/.test(type) || el.getAttribute('role') === 'button',
        inDialog: !!el.closest('dialog, [role=dialog], .modal')
      }
    },
    undefined,
    { timeout: EVAL_MS }
  )
  const combo =
    base.tag !== 'SELECT' &&
    (base.role === 'combobox' || (await loc.evaluate(comboInPage, undefined, { timeout: EVAL_MS })).box)
  return { ...base, combo }
}

/** Field value check done in the page, so values (passwords) never leave it. */
function holds(loc: Locator, expected: string): Promise<boolean> {
  return loc
    .evaluate(
      (el, e) => {
        const v = ('value' in el ? (el as HTMLInputElement).value : el.textContent) || ''
        if (e === '') return v === ''
        if (v.includes(e)) return true
        // Masks reformat the text: compare letters/digits only.
        const an = (s: string): string => s.normalize('NFD').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
        return an(e) !== '' && an(v).includes(an(e))
      },
      expected,
      { timeout: EVAL_MS }
    )
    .catch(() => false)
}

async function fillText(page: Page, loc: Locator, value: string, info: ElInfo, ms: number): Promise<void> {
  // focus() instead of click(): nothing covering the field can get in the way;
  // select-all + typing works with masks/datepickers that ignore fill().
  await loc.focus({ timeout: ms })
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Backspace')
  if (value) await loc.pressSequentially(value, { timeout: ms + value.length * 20 })
  // Closes datepicker/autocomplete popups; not inside dialogs (it would close them).
  if (!info.inDialog) await page.keyboard.press('Escape').catch(() => undefined)
  if (await holds(loc, value)) return
  if (DATE_LIKE.test(info.type)) {
    await loc.fill(value, { timeout: ms })
    if (await holds(loc, value)) return
  }
  throw new StepError('o campo não ficou com o valor pedido (máscara ou validação da página?)')
}

async function selectNative(loc: Locator, values: string[], multiple: boolean, ms: number): Promise<void> {
  if (values.length > 1 && !multiple) throw new StepError('este select aceita uma única opção')
  const opts = await loc.evaluate(
    (el) =>
      [...(el as HTMLSelectElement).options].map((o) => ({
        label: (o.textContent || '').replace(/\s+/g, ' ').trim(),
        value: o.value
      })),
    undefined,
    { timeout: EVAL_MS }
  )
  const indices = values.map((v) => {
    const p = pickOption(opts, v)
    if (p.kind === 'found') return p.index
    if (p.kind === 'ambiguous') throw new StepError(`opção ambígua "${v}": ${p.indices.map((i) => opts[i].label).join(' | ')}`)
    throw new StepError(`opção "${v}" não existe; opções: ${opts.slice(0, 30).map((o) => o.label).join(' | ')}`)
  })
  await loc.selectOption(
    indices.map((index) => ({ index })),
    { timeout: ms }
  )
  const selected = await loc.evaluate(
    (el, idx) => idx.every((i) => (el as HTMLSelectElement).options[i]?.selected),
    indices,
    { timeout: EVAL_MS }
  )
  if (!selected) throw new StepError('a opção não ficou selecionada')
}

/** Custom (react-select-like) combobox: type, pick with Enter, confirm it shows. */
async function fillCombo(page: Page, loc: Locator, values: string[], ms: number): Promise<void> {
  for (const v of values) {
    await loc.focus({ timeout: ms })
    await loc.pressSequentially(v, { timeout: ms })
    await pollTrue(
      () =>
        page
          .evaluate(() => !!document.querySelector('[role=option], [class*="-option"], [class*="__option"]'))
          .catch(() => false),
      Math.min(1500, ms)
    )
    await page.keyboard.press('Enter')
    // Picked = shown as a chip/single value in the container (react-select);
    // without such a container, the control's own value must contain it.
    const want = norm(v)
    const shows = async (): Promise<boolean> => {
      const c = await loc.evaluate(comboInPage, undefined, { timeout: EVAL_MS }).catch(() => null)
      if (!c) return false
      return c.box ? c.values.some((x) => norm(x).includes(want)) : norm(c.input).includes(want)
    }
    if (!(await pollTrue(shows, 1000))) throw new StepError(`a lista não aceitou "${v}"`)
  }
}

async function setChecked(loc: Locator, want: boolean): Promise<void> {
  try {
    if (want) await loc.check({ force: true, timeout: TOGGLE_MS })
    else await loc.uncheck({ force: true, timeout: TOGGLE_MS })
  } catch {
    // Custom controls hide the input or cover it: click the input through the DOM.
    await loc
      .evaluate(
        (el, w) => {
          const i = el as HTMLInputElement
          if (i.checked !== w) i.click()
        },
        want,
        { timeout: EVAL_MS }
      )
      .catch(() => undefined)
  }
  const now = await loc.evaluate((el) => (el as HTMLInputElement).checked, undefined, { timeout: EVAL_MS }).catch(() => !want)
  if (now !== want) throw new StepError(want ? 'não ficou marcado' : 'não ficou desmarcado')
}

async function clickEl(loc: Locator, ms: number): Promise<void> {
  try {
    await loc.click({ timeout: Math.min(ms, CLICK_MS) })
  } catch (e) {
    // Something covers it (overlay, ad): fire the click on the element itself.
    const fired = await loc
      .evaluate(
        (el) => {
          ;(el as HTMLElement).click()
          return true
        },
        undefined,
        { timeout: EVAL_MS }
      )
      .catch(() => false)
    if (!fired) throw new StepError(firstLine(e))
  }
}

/** Radio group target + value: the option whose label matches the value. */
async function radioOption(page: Page, r: Resolved, value: string): Promise<Locator> {
  const snap = await collectFields(page)
  const opts = (
    snap.fields.find(
      (f) => f.type === 'radio' && (f.ref === r.ref || f.options?.some((o) => typeof o !== 'string' && o.ref === r.ref))
    )?.options ?? []
  ).filter((o): o is FieldOption => typeof o !== 'string')
  const p = pickOption(opts, value)
  if (p.kind === 'found') return refLocator(page, opts[p.index].ref)
  if (p.kind === 'ambiguous') {
    throw new StepError(
      'opção ambígua',
      p.indices.map((i) => ({ ref: opts[i].ref, type: 'radio', label: opts[i].label }))
    )
  }
  throw new StepError(`opção "${value}" não existe; opções: ${opts.map((o) => o.label).join(' | ')}`)
}

async function pollTrue(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  for (;;) {
    if (await check()) return true
    if (Date.now() + POLL_MS > end) return false
    await sleep(POLL_MS)
  }
}

function hasText(page: Page, text: string): Promise<boolean> {
  return page
    .evaluate((t) => {
      const n = (s: string): string =>
        s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
      return n(document.body?.innerText || '').includes(n(t))
    }, text)
    .catch(() => false)
}

/** Executes one step; `settle` asks the caller to wait for the click's result. */
async function execStep(page: Page, step: BrowserStep, until: number, ms: number): Promise<{ settle: boolean }> {
  const v = step.value
  const one = (): string => {
    if (Array.isArray(v)) throw new StepError('este alvo aceita um único valor')
    return v ?? ''
  }
  const none = { settle: false }
  switch (step.action) {
    case 'navigate':
      await gotoUrl(page, one())
      return none
    case 'press':
      if (step.target) await (await resolveTarget(page, step.target, until)).loc.focus({ timeout: ms })
      await page.keyboard.press(one())
      return none
    case 'wait_for':
      if (step.target) await resolveTarget(page, step.target, until)
      else if (!(await pollTrue(() => hasText(page, one()), Math.max(0, until - Date.now()))))
        throw new StepError('o texto não apareceu')
      return none
    case 'click': {
      const r = await resolveTarget(page, step.target!, until)
      const info = await describe(r.loc)
      await clickEl(r.loc, ms)
      return { settle: info.actionable }
    }
  }
  // fill / select / check / uncheck
  const r = await resolveTarget(page, step.target!, until)
  const info = await describe(r.loc)
  const values = Array.isArray(v) ? v : v === undefined ? [] : [v]
  if (info.type === 'radio') {
    if (step.action === 'uncheck') throw new StepError('rádio não se desmarca; marque outra opção')
    const loc = !r.option && values.length ? await radioOption(page, r, one()) : r.loc
    await setChecked(loc, true)
  } else if (info.type === 'checkbox') {
    if (step.action !== 'check' && step.action !== 'uncheck') throw new StepError('caixa de seleção: use check/uncheck')
    await setChecked(r.loc, step.action === 'check')
  } else if (step.action === 'check' || step.action === 'uncheck') {
    throw new StepError('o alvo não é checkbox nem rádio')
  } else if (info.tag === 'SELECT') {
    await selectNative(r.loc, values, info.multiple, ms)
  } else if (info.combo) {
    await fillCombo(page, r.loc, values, ms)
  } else {
    await fillText(page, r.loc, one(), info, ms)
  }
  return none
}

async function safeCollect(page: Page): Promise<FieldsSnapshot | null> {
  try {
    return await collectFields(page)
  } catch {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined)
    return collectFields(page).catch(() => null)
  }
}

export async function runSteps(
  page: Page,
  steps: BrowserStep[],
  expect?: string,
  budgetMs: number = CALL_BUDGET_MS
): Promise<RunStepsResult> {
  const problem = validateSteps(steps, expect)
  if (problem) throw new Error(problem)
  const callEnd = Date.now() + budgetMs
  const total = steps.length
  let done = 0
  let failedStep: FailedStep | undefined
  let outcome: Outcome | undefined
  let invalid: string[] = []
  let armedUrl = await arm(page)

  for (let i = 0; i < total; i++) {
    const step = steps[i]
    const fail = (error: string, candidates?: Candidate[]): void => {
      failedStep = {
        i,
        action: step.action,
        ...(step.target ? { target: step.target } : {}),
        error,
        ...(candidates?.length ? { candidates } : {})
      }
    }
    const now = Date.now()
    if (now >= callEnd) {
      fail(`tempo total da chamada esgotado (${Math.round(budgetMs / 1000)} s)`)
      break
    }
    const until = Math.min(now + (step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS), callEnd)
    const ms = Math.max(500, Math.min(ACTION_MAX_MS, callEnd - now))
    try {
      if (step.action === 'click') armedUrl = await arm(page)
      const { settle } = await execStep(page, step, until, ms)
      // Intermediate clicks: short wait so a refused submit stops the run here.
      if (settle && i < total - 1) {
        const o = await waitOutcome(page, armedUrl, undefined, CLICK_SETTLE_MS, callEnd)
        if (o.outcome === 'invalid') {
          outcome = 'invalid'
          invalid = o.invalid
          fail('a página recusou o envio: campos inválidos')
          break
        }
      }
      done++
    } catch (e) {
      if (e instanceof StepError) fail(e.message, e.candidates)
      else fail(firstLine(e))
      break
    }
  }

  if (!outcome) {
    const ms = failedStep ? 0 : expect ? FINAL_EXPECT_MS : FINAL_PLAIN_MS
    const o = await waitOutcome(page, armedUrl, expect, ms, failedStep ? Infinity : callEnd)
    outcome = o.outcome
    invalid = o.invalid
  }
  const snap = await safeCollect(page)
  const labels = new Map<string, string>()
  for (const f of snap?.fields ?? []) {
    labels.set(f.ref, f.label)
    for (const o of f.options ?? []) if (typeof o !== 'string') labels.set(o.ref, f.label)
  }
  const message = outcome === 'expect' && expect ? await lineWith(page, expect) : snap?.alerts[0]?.slice(0, 200)
  return buildResult(
    {
      done,
      total,
      failedStep,
      outcome,
      message,
      invalid: invalid.map((r) => (labels.has(r) ? `${r} "${labels.get(r)}"` : r)),
      url: page.url(),
      state: snap ? formatState(snap) : '(estado indisponível: a página está carregando)'
    },
    expect
  )
}
