// Função injetada via CDP Runtime.evaluate (awaitPromise) pelo método
// `pickElement` do background. Precisa ser autocontida: o background serializa
// com Function.prototype.toString e chama com (timeoutMs).
// Liga o "Selecionar" na página: realce laranja no elemento sob o mouse e UM
// clique escolhe. A promessa resolve com { element } no clique, ou
// { canceled: 'esc' | 'timeout' | 'replaced' } — sempre desfazendo tudo o que pôs
// na página. O clique escolhido não chega à página (não navega, não envia form).
//
// O alvo vem de um teste de posição próprio, não do `ev.target`, porque o evento
// não alcança tudo o que o usuário vê:
// - `pointer-events: none` (o clique cai no pai) → o teste de posição ignora essa regra;
// - controle `disabled` (o Chrome não dispara `click` nele) e iframe (os eventos
//   ficam dentro do frame) → uma película transparente cobre a página só enquanto o
//   mouse está sobre eles, e o clique cai nela. Fora disso a película deixa passar,
//   para o :hover da página (menus que abrem ao passar o mouse) continuar funcionando;
// - iframe do mesmo site e shadow DOM aberto → entra neles. Iframe de outro site
//   (ex.: formulário de pagamento) não é acessível daqui: devolve o próprio iframe.
// eslint-disable-next-line no-unused-vars
function agentCodePickElement(timeoutMs) {
  const HL = '__agent_highlight__'
  const HINT = '__agent_pick_hint__'
  const SHIELD = '__agent_pick_shield__'
  const ACCENT = '#d97757'
  // Uma seleção por vez na página: a anterior é cancelada.
  if (typeof window.__agentCodePickCancel === 'function') window.__agentCodePickCancel('replaced')

  return new Promise((resolve) => {
    const root = document.documentElement || document.body
    const shield = document.createElement('div')
    shield.id = SHIELD
    Object.assign(shield.style, {
      position: 'fixed', zIndex: 2147483647, pointerEvents: 'none', inset: '0',
      background: 'transparent', cursor: 'crosshair'
    })
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
    root.appendChild(shield)
    root.appendChild(box)
    root.appendChild(hint)

    const ours = (el) => !el || el === box || el === hint || el === shield
    const isFrame = (el) => el.tagName === 'IFRAME' || el.tagName === 'FRAME'
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

    // Alvo sob (x, y) num documento. Primeiro o teste de posição normal; se ele
    // parar num contêiner sem conteúdo próprio (o filho tinha pointer-events: none,
    // ex.: botão desabilitado de tela de assinatura), repete com pointer-events
    // forçado e fica com o primeiro descendente pulado que tem conteúdo — texto,
    // controle ou mídia, não o fundo decorativo. Folha construída (não <style>):
    // a CSP da página não a barra. Camada invisível (opacity 0) não conta.
    const CONTENT = 'a,button,input,select,textarea,label,img,svg,video,canvas,iframe,frame,[role],[tabindex]'
    const visible = (e) => !ours(e) && getComputedStyle(e).opacity !== '0'
    const ownText = (e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
    const hasContent = (e) => e.matches(CONTENT) || !!(e.textContent || '').trim()
    function forcedStack(doc, x, y) {
      let sheet = null
      try {
        sheet = new doc.defaultView.CSSStyleSheet()
        sheet.replaceSync('*{pointer-events:auto!important}')
        doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]
      } catch {
        return []
      }
      try {
        return doc.elementsFromPoint(x, y)
      } finally {
        doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== sheet)
      }
    }
    function topAt(doc, x, y) {
      const normal = doc.elementsFromPoint(x, y).find(visible) || null
      if (normal && (normal.matches(CONTENT) || ownText(normal))) return normal
      for (const e of forcedStack(doc, x, y)) {
        if (e === normal) break // daqui para baixo está atrás do alvo normal
        if (!visible(e) || (normal && !normal.contains(e))) continue
        if (hasContent(e)) return e
      }
      return normal
    }
    function intoShadow(el, x, y) {
      for (let hop = 0; hop < 10 && el.shadowRoot; hop++) {
        const inner = el.shadowRoot.elementsFromPoint(x, y)[0]
        if (!inner || inner === el) break
        el = inner
      }
      return el
    }
    // Elemento sob (x, y) em coordenadas da janela, entrando em iframes do mesmo
    // site. `ox/oy` = deslocamento do documento do elemento; `frames` = seletores
    // dos iframes atravessados.
    function hitAt(x, y) {
      let doc = document
      let ox = 0
      let oy = 0
      let el = null
      const frames = []
      for (let hop = 0; hop < 6; hop++) {
        const found = topAt(doc, x - ox, y - oy)
        if (!found) break
        el = intoShadow(found, x - ox, y - oy)
        if (!isFrame(el)) break
        let inner = null
        try { inner = el.contentDocument } catch { inner = null }
        if (!inner || !inner.documentElement) break
        const r = el.getBoundingClientRect()
        frames.push(sel(el))
        ox += r.left + el.clientLeft
        oy += r.top + el.clientTop
        doc = inner
      }
      return el ? { el, ox, oy, frames } : null
    }
    // A película só cobre a página quando o evento não chegaria até nós.
    const needsShield = (hit) => !!hit && (isFrame(hit.el) || hit.frames.length > 0 || !!hit.el.closest(':disabled'))
    const setShield = (on) => { shield.style.pointerEvents = on ? 'auto' : 'none' }

    let lastX = -1
    let lastY = -1
    let raf = 0
    function paint() {
      raf = 0
      const hit = hitAt(lastX, lastY)
      setShield(needsShield(hit))
      if (!hit) {
        box.style.display = 'none'
        return
      }
      const r = hit.el.getBoundingClientRect()
      Object.assign(box.style, {
        display: 'block', left: r.left + hit.ox + 'px', top: r.top + hit.oy + 'px', width: r.width + 'px', height: r.height + 'px'
      })
    }
    function schedule(ev) {
      lastX = ev.clientX
      lastY = ev.clientY
      if (!raf) raf = requestAnimationFrame(paint)
    }

    let done = false
    const swallow = (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
    }
    function onMove(ev) {
      schedule(ev)
    }
    // Ao entrar num iframe a página só recebe o mouseover do <iframe>: a película
    // sobe na hora, senão os próximos movimentos ficariam dentro do frame.
    function onOver(ev) {
      if (ev.target && ev.target.nodeType === 1 && isFrame(ev.target)) setShield(true)
      schedule(ev)
    }
    function onClick(ev) {
      swallow(ev)
      // Clique de teclado (Enter num botão em foco) não tem posição.
      const keyboard = ev.detail === 0 && !ev.clientX && !ev.clientY
      const hit = keyboard ? null : hitAt(ev.clientX, ev.clientY)
      const el = hit ? hit.el : ev.target
      if (ours(el) || el.nodeType !== 1) return
      const own = sel(el)
      finish({
        element: {
          selector: hit && hit.frames.length ? hit.frames.join(' >>> ') + ' >>> ' + own : own,
          tagName: el.tagName.toLowerCase(), id: el.id || '', classes: cls(el),
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
    // pointer* também: o Chrome entrega eventos de ponteiro a controles disabled.
    const MOVES = ['mousemove', 'pointermove']
    const OVERS = ['mouseover', 'pointerover']
    const SWALLOWED = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'auxclick']
    const timer = setTimeout(() => finish({ canceled: 'timeout' }), Math.max(1000, Number(timeoutMs) || 110000))

    function finish(result) {
      if (done) return
      done = true
      clearTimeout(timer)
      if (raf) cancelAnimationFrame(raf)
      for (const type of MOVES) window.removeEventListener(type, onMove, true)
      for (const type of OVERS) window.removeEventListener(type, onOver, true)
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('keydown', onKey, true)
      for (const type of SWALLOWED) window.removeEventListener(type, swallow, true)
      shield.remove()
      box.remove()
      hint.remove()
      if (window.__agentCodePickCancel === cancel) delete window.__agentCodePickCancel
      resolve(result)
    }
    const cancel = (why) => finish({ canceled: why || 'replaced' })
    window.__agentCodePickCancel = cancel

    for (const type of MOVES) window.addEventListener(type, onMove, true)
    for (const type of OVERS) window.addEventListener(type, onOver, true)
    window.addEventListener('click', onClick, true)
    window.addEventListener('keydown', onKey, true)
    for (const type of SWALLOWED) window.addEventListener(type, swallow, true)
  })
}
