import type { Page } from 'playwright'

/**
 * browser_form_fields: one compact line per visible control of the active page.
 * Each control is tagged in the DOM with `data-ac-ref="eN"` (numbering continues
 * across reads, so refs stay stable) so browser_run_steps can target it later.
 * Limitations: only the main frame is read (no iframes) and shadow DOM is not
 * traversed.
 */

export interface FieldOption {
  label: string
  ref: string
}

export interface FieldInfo {
  ref: string
  /** input.type, textarea, select, select-multiple, combobox, radio, checkbox, button, submit, link. */
  type: string
  label: string
  required?: boolean
  /** Native select: option texts. Radio group: one entry (with its own ref) per option. */
  options?: Array<string | FieldOption>
  /** Current value; checkbox is on/off, password is masked, never the real value. */
  value?: string
  /** Multi-value custom select: the picked chips. */
  values?: string[]
}

export interface FieldsSnapshot {
  url: string
  title: string
  fields: FieldInfo[]
  /** Visible alert/dialog texts (short). */
  alerts: string[]
}

export interface CollectOptions {
  /** Max links listed (buttons are always listed). */
  linkLimit: number
  /** Also list links outside form/main/dialog (used to resolve {text} targets). */
  allLinks: boolean
}

export const ACTION_TYPES = new Set(['button', 'submit', 'link'])

/** Runs inside the page: must stay self-contained (no outer references). */
function collectInPage(opts: CollectOptions): FieldsSnapshot {
  const clean = (t: string | null | undefined, max = 80): string =>
    (t || '').replace(/\s+/g, ' ').replace(/"/g, "'").trim().slice(0, max)
  const shown = (el: Element): boolean => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0
  }
  // b comes after a in document order.
  const follows = (a: Node, b: Node): boolean => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
  const labelFor = (el: Element): HTMLLabelElement | null =>
    el.id ? document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`) : null
  const isToggle = (el: Element): boolean =>
    el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox')
  // Custom radios/checkboxes hide the input and show a styled label instead.
  const visibleControl = (el: Element): boolean => {
    if (shown(el)) return true
    if (!isToggle(el)) return false
    const l = labelFor(el) || el.closest('label')
    return !!l && shown(l)
  }
  // react-select style container: the nearest "-container" ancestor holding the
  // dropdown indicator (inner input-/value-containers don't count). Stops once
  // the ancestor holds other inputs too. Keep in sync with browserSteps comboInPage.
  const selectBox = (el: Element): HTMLElement | null => {
    for (let c = el.closest('[class*="-container"]'); c; c = c.parentElement?.closest('[class*="-container"]') ?? null) {
      if (c.querySelectorAll('input:not([type=hidden])').length > 1) return null
      if (c.querySelector('[class*="indicatorContainer"]')) return c as HTMLElement
    }
    return null
  }
  // Picked values of a custom select: chips (multi) or the single value.
  const boxValues = (box: Element): { multi: boolean; values: string[] } => {
    const top = (sel: string): Element[] => {
      const all = [...box.querySelectorAll(sel)]
      return all.filter((x) => !all.some((y) => y !== x && y.contains(x)))
    }
    const text = (xs: Element[]): string[] => xs.map((x) => clean((x as HTMLElement).innerText)).filter(Boolean)
    // Chip text without its remove button ("×").
    const chipText = (x: Element): string => {
      const l = x.querySelector<HTMLElement>('[class*="label" i]')
      if (l) return clean(l.innerText)
      let t = (x as HTMLElement).innerText || ''
      for (const b of x.querySelectorAll<HTMLElement>('[role=button]')) t = t.replace(b.innerText || '', '')
      return clean(t)
    }
    const chips = top('[class*="multiValue"], [class*="multi-value"]').map(chipText).filter(Boolean)
    if (chips.length) return { multi: true, values: chips }
    return { multi: false, values: text(top('[class*="singleValue"], [class*="single-value"]')) }
  }
  const controls = [
    ...document.querySelectorAll<HTMLElement>('input:not([type=hidden]), textarea, select, [role=combobox]')
  ]

  const rawLabel = (el: HTMLElement, group: boolean): string => {
    if (!group) {
      const l = labelFor(el)
      if (l && clean(l.textContent)) return clean(l.textContent)
    }
    const aria = clean(el.getAttribute('aria-label'))
    if (aria) return aria
    const by = el.getAttribute('aria-labelledby')
    if (by) {
      const t = clean(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' '))
      if (t) return t
    }
    if (!group) {
      const wrap = el.closest('label')
      if (wrap && clean(wrap.textContent)) return clean(wrap.textContent)
    }
    // Grid layouts: the label sits in another column. Take the LAST qualifying
    // label before the field, skipping labels that belong to another control.
    let row = el.parentElement
    for (let i = 0; i < 9 && row && row !== document.documentElement; i++, row = row.parentElement) {
      const l = [...row.querySelectorAll<HTMLLabelElement>('label, legend, .form-label')]
        .filter(
          (x) =>
            !x.contains(el) &&
            (!x.htmlFor || (!group && x.htmlFor === el.id)) &&
            clean(x.textContent) &&
            follows(x, el)
        )
        .pop()
      if (!l) continue
      // Another control between that label and this field owns the label.
      const name = (el as HTMLInputElement).name
      const owned = controls.some(
        (c) =>
          c !== el &&
          !(group && c instanceof HTMLInputElement && c.type === 'radio' && c.name === name) &&
          follows(l, c) &&
          follows(c, el)
      )
      return owned ? '' : clean(l.textContent)
    }
    return ''
  }
  const labelOf = (el: HTMLElement, group = false): string => {
    const base = rawLabel(el, group)
    // Custom selects show their placeholder in a <div>, not on the input.
    const ph =
      clean((el as HTMLInputElement).placeholder) ||
      clean(selectBox(el)?.querySelector('[class*="placeholder"]')?.textContent)
    const found = !base ? ph : ph && ph !== base && !base.includes(ph) ? `${base} (${ph})` : base
    // A placeholder-only label vanishes once a value is picked: keep the last
    // real label on the element instead of falling back to name/id.
    if (found) el.dataset.acLabel = found
    return found || el.dataset.acLabel || clean(el.getAttribute('name')) || clean(el.id)
  }

  let n = 0
  for (const e of document.querySelectorAll<HTMLElement>('[data-ac-ref]')) {
    n = Math.max(n, Number((e.dataset.acRef || '').slice(1)) || 0)
  }
  const ref = (el: HTMLElement): string => el.dataset.acRef || (el.dataset.acRef = 'e' + ++n)

  const fields: FieldInfo[] = []
  const seen = new Set<Element>()
  const radios = new Map<string, FieldInfo>()
  for (const el of controls) {
    if (seen.has(el)) continue
    seen.add(el)
    const input = el as HTMLInputElement
    if (el.tagName === 'INPUT' && /^(submit|button|reset|image)$/.test(input.type)) continue
    if (el.matches(':disabled') || !visibleControl(el)) continue
    if (el.tagName === 'INPUT' && input.type === 'radio') {
      const key = input.name || ref(el)
      let g = radios.get(key)
      if (!g) {
        g = { ref: ref(el), type: 'radio', label: labelOf(el, true), options: [] }
        radios.set(key, g)
        fields.push(g)
      }
      const opt =
        clean(labelFor(el)?.textContent) ||
        clean(el.closest('label')?.textContent) ||
        clean(el.getAttribute('aria-label')) ||
        clean(input.value)
      g.options!.push({ label: opt, ref: ref(el) })
      if (input.required) g.required = true
      if (input.checked) g.value = opt
      continue
    }
    const box = selectBox(el)
    const type =
      el.tagName === 'SELECT'
        ? (el as HTMLSelectElement).type
        : el.getAttribute('role') === 'combobox' || box
          ? 'combobox'
          : el.tagName === 'TEXTAREA'
            ? 'textarea'
            : input.type || 'text'
    const f: FieldInfo = { ref: ref(el), type, label: labelOf(el) }
    if (input.required || el.getAttribute('aria-required') === 'true') f.required = true
    if (el.tagName === 'SELECT') {
      const s = el as HTMLSelectElement
      f.options = [...s.options].slice(0, 30).map((o) => clean(o.textContent))
      if (s.options.length > 30) f.options.push(`… +${s.options.length - 30}`)
      const v = [...s.selectedOptions].map((o) => clean(o.textContent)).filter(Boolean).join(', ')
      if (v) f.value = v
    } else if (type === 'checkbox') {
      f.value = input.checked ? 'on' : 'off'
    } else if (type === 'password') {
      if (input.value) f.value = '••••' // never the real value
    } else if (type === 'combobox' && box) {
      const { multi, values } = boxValues(box)
      if (multi) f.values = values
      else if (values[0]) f.value = values[0]
    } else {
      const v = clean('value' in el ? input.value : el.textContent)
      if (v) f.value = v
    }
    fields.push(f)
  }

  const actionSel =
    'button, input[type=submit], input[type=button], input[type=reset], input[type=image], [role=button]'
  for (const b of document.querySelectorAll<HTMLElement>(actionSel)) {
    if (seen.has(b)) continue
    seen.add(b)
    if (b.matches(':disabled') || b.getAttribute('aria-disabled') === 'true' || !shown(b) || selectBox(b)) continue
    const label = clean(b.getAttribute('aria-label') || b.innerText || (b as HTMLInputElement).value || b.title)
    if (!label) continue
    const btn = b as HTMLInputElement
    const submit = (btn.type === 'submit' || btn.type === 'image') && !!btn.form
    fields.push({ ref: ref(b), type: submit ? 'submit' : 'button', label })
  }
  // Links: action-like ones first, never the whole site navigation by default.
  const links: Array<{ a: HTMLElement; label: string; prio: number }> = []
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (seen.has(a) || !shown(a)) continue
    const label = clean(a.getAttribute('aria-label') || a.innerText || a.title)
    if (!label) continue
    const href = a.getAttribute('href') || ''
    const prio = a.closest('form, dialog, [role=dialog]')
      ? 0
      : /^(#|javascript:)/i.test(href)
        ? 1
        : a.closest('main, [role=main]')
          ? 2
          : 3
    if (prio === 3 && !opts.allLinks) continue
    links.push({ a, label, prio })
  }
  links.sort((x, y) => x.prio - y.prio)
  for (const l of links.slice(0, opts.linkLimit)) fields.push({ ref: ref(l.a), type: 'link', label: l.label })

  const alerts: string[] = []
  const alertEls: Element[] = []
  const alertSel = '[role=alert], [role=alertdialog], [role=dialog], dialog[open], .modal, .alert, [aria-live=assertive]'
  for (const a of document.querySelectorAll<HTMLElement>(alertSel)) {
    if (alerts.length >= 5 || !shown(a) || alertEls.some((p) => p.contains(a))) continue
    const t = clean(a.innerText, 300)
    if (!t) continue
    alertEls.push(a)
    alerts.push(t)
  }
  return { url: location.href, title: document.title, fields, alerts }
}

export async function collectFields(
  page: Page,
  opts: CollectOptions = { linkLimit: 20, allLinks: false }
): Promise<FieldsSnapshot> {
  return page.evaluate(collectInPage, opts)
}

export function formatField(f: FieldInfo): string {
  const opts = f.options?.length
    ? ` [${f.options.map((o) => (typeof o === 'string' ? o : `${o.label}=${o.ref}`)).join(' | ')}]`
    : ''
  const val = f.values?.length
    ? ` = ${JSON.stringify(f.values)}`
    : !f.value
      ? ''
      : f.type === 'checkbox'
        ? ` = ${f.value}`
        : ` = "${f.value}"`
  return `${f.ref} ${f.type}${f.required ? '*' : ''} "${f.label}"${opts}${val}`
}

/** The browser_form_fields text: one line per control + `url: … | title: …`. */
export function formatFields(snap: Pick<FieldsSnapshot, 'url' | 'title' | 'fields'>): string {
  const lines = snap.fields.length ? snap.fields.map(formatField) : ['(nenhum controle visível)']
  return [...lines, `url: ${snap.url} | title: ${snap.title}`].join('\n')
}

/** Fields plus the visible alert/dialog texts (the run_steps `state`). */
export function formatState(snap: FieldsSnapshot): string {
  return [formatFields(snap), ...snap.alerts.map((a) => `alerta: ${a}`)].join('\n')
}
