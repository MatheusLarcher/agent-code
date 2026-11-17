// Função injetada via CDP Runtime.evaluate (awaitPromise) pelo método
// `pickElement` do background. Precisa ser autocontida: o background serializa
// com Function.prototype.toString e chama com (timeoutMs).
// Liga o "Selecionar" na página: realce laranja no elemento sob o mouse e UM
// clique escolhe. A promessa resolve com { element } no clique, ou
// { canceled: 'esc' | 'timeout' | 'replaced' } — sempre desfazendo tudo o que pôs
// na página. O clique escolhido não chega à página (não navega, não envia form).
// eslint-disable-next-line no-unused-vars
function agentCodePickElement(timeoutMs) {
  const HL = '__agent_highlight__'
  const HINT = '__agent_pick_hint__'
  const ACCENT = '#d97757'
  // Uma seleção por vez na página: a anterior é cancelada.
  if (typeof window.__agentCodePickCancel === 'function') window.__agentCodePickCancel('replaced')

  return new Promise((resolve) => {
    const root = document.documentElement || document.body
    const box = document.createElement('div')
    box.id = HL
    Object.assign(box.style, {
      position: 'fixed', zIndex: 2147483647, pointerEvents: 'none', display: 'none',
      border: '2px solid ' + ACCENT, background: 'rgba(217,119,87,0.14)', borderRadius: '3px'
    })
    const hint = document.createElement('div')
    hint.id = HINT
    hint.textContent = 'Agent Code: clique no elemento que quer mostrar ao agente · Esc cancela'
    Object.assign(hint.style, {
      position: 'fixed', zIndex: 2147483647, pointerEvents: 'none', top: '10px', left: '50%',
      transform: 'translateX(-50%)', padding: '7px 14px', borderRadius: '8px', background: '#1f1e1d',
      color: '#f0ede8', border: '1px solid ' + ACCENT, font: '13px/1.3 system-ui, "Segoe UI", sans-serif',
      boxShadow: '0 6px 20px rgba(0,0,0,0.35)', whiteSpace: 'nowrap'
    })
    root.appendChild(box)
    root.appendChild(hint)

    const ours = (el) => !el || el === box || el === hint
    function sel(el) {
      if (el.id) return '#' + CSS.escape(el.id)
      const parts = []
      let e = el
      while (e && e.nodeType === 1 && parts.length < 5) {
        let s = e.tagName.toLowerCase()
        if (e.classList && e.classList.length) s += '.' + [...e.classList].slice(0, 2).map((c) => CSS.escape(c)).join('.')
        const sib = e.parentElement ? [...e.parentElement.children].filter((x) => x.tagName === e.tagName) : []
        if (sib.length > 1) s += ':nth-of-type(' + (sib.indexOf(e) + 1) + ')'
        parts.unshift(s)
        e = e.parentElement
      }
      return parts.join(' > ')
    }
    const cls = (el) => {
      const c = el.className
      return (c && c.baseVal !== undefined ? c.baseVal : c) || ''
    }

    let done = false
    const swallow = (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
    }
    function onMove(ev) {
      const el = ev.target
      if (ours(el) || !el.getBoundingClientRect) return
      const r = el.getBoundingClientRect()
      Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' })
    }
    function onClick(ev) {
      swallow(ev)
      const el = ev.target
      if (ours(el) || el.nodeType !== 1) return
      finish({
        element: {
          selector: sel(el), tagName: el.tagName.toLowerCase(), id: el.id || '', classes: cls(el),
          text: (el.innerText || el.textContent || '').trim().slice(0, 2000),
          html: el.outerHTML.slice(0, 4000), url: location.href
        }
      })
    }
    function onKey(ev) {
      if (ev.key !== 'Escape') return
      swallow(ev)
      finish({ canceled: 'esc' })
    }
    const SWALLOWED = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu']
    const timer = setTimeout(() => finish({ canceled: 'timeout' }), Math.max(1000, Number(timeoutMs) || 110000))

    function finish(result) {
      if (done) return
      done = true
      clearTimeout(timer)
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('keydown', onKey, true)
      for (const type of SWALLOWED) window.removeEventListener(type, swallow, true)
      box.remove()
      hint.remove()
      if (window.__agentCodePickCancel === cancel) delete window.__agentCodePickCancel
      resolve(result)
    }
    const cancel = (why) => finish({ canceled: why || 'replaced' })
    window.__agentCodePickCancel = cancel

    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('click', onClick, true)
    window.addEventListener('keydown', onKey, true)
    for (const type of SWALLOWED) window.addEventListener(type, swallow, true)
  })
}
