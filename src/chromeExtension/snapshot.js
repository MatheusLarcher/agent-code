// Função injetada via CDP Runtime.evaluate. Precisa ser autocontida: o
// background serializa com Function.prototype.toString e chama com (maxChars).
// Marca elementos visíveis e interativos com data-agent-ref="eN" (inclui
// shadow DOM aberto) e devolve a lista compacta + texto visível truncado.
// eslint-disable-next-line no-unused-vars
function agentCodeSnapshot(maxChars) {
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role],[contenteditable=""],[contenteditable="true"],[tabindex],[onclick]'
  const ROLE_BY_TAG = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button' }
  const INPUT_ROLES = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', range: 'slider', search: 'searchbox' }
  const limit = Math.max(500, Number(maxChars) || 6000)

  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0
  }
  const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  const roleOf = (el) => {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    if (el.tagName === 'INPUT') return INPUT_ROLES[(el.type || 'text').toLowerCase()] || 'textbox'
    if (el.isContentEditable) return 'textbox'
    return ROLE_BY_TAG[el.tagName] || el.tagName.toLowerCase()
  }
  const nameOf = (el) => {
    const label = el.getAttribute('aria-label')
    if (label) return clean(label)
    const by = el.getAttribute('aria-labelledby')
    if (by) {
      const t = by.split(/\s+/).map((id) => el.getRootNode().getElementById?.(id)?.textContent || '').join(' ')
      if (clean(t)) return clean(t)
    }
    if (el.labels && el.labels[0]) return clean(el.labels[0].textContent)
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) return clean(el.value)
    return clean(el.placeholder || el.getAttribute('title') || el.getAttribute('alt') || el.textContent)
  }

  // Refs antigas saem: a numeração é refeita a cada snapshot.
  const roots = [document]
  const all = []
  while (roots.length) {
    const root = roots.shift()
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) roots.push(el.shadowRoot)
      if (el.hasAttribute('data-agent-ref')) el.removeAttribute('data-agent-ref')
      if (el.matches(INTERACTIVE)) all.push(el)
    }
  }

  const lines = []
  let n = 0
  for (const el of all) {
    if (el.disabled || !visible(el)) continue
    const ref = 'e' + ++n
    el.setAttribute('data-agent-ref', ref)
    let line = `[${ref}] ${roleOf(el)} "${nameOf(el)}"`
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      if (el.type === 'checkbox' || el.type === 'radio') line += el.checked ? ' checked' : ''
      else if (el.type !== 'password') line += ` value="${clean(el.value)}"`
    } else if (el.tagName === 'SELECT') {
      line += ` value="${clean(el.options[el.selectedIndex]?.text)}"`
    }
    lines.push(line)
  }

  const head = `${document.title}\n${location.href}\n\n`
  let out = head + lines.join('\n')
  if (out.length < limit) {
    const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim()
    out += '\n\n--- texto visível ---\n' + text
  }
  return out.length > limit ? out.slice(0, limit) + '\n…(truncado)' : out
}
