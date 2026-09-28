// Camada CDP via chrome.debugger: attach sob demanda, detach após 30 s ocioso,
// tradução de erros para as mensagens do contrato. Script clássico
// (importScripts), expõe tudo em self.AgentCdp.
;(() => {
  const IDLE_DETACH_MS = 30_000
  const ERR = {
    ref: 'Ref expirada — faça um novo chrome_snapshot',
    canceled: 'Interrompido pelo usuário',
    paused: 'Controle pausado pelo usuário na extensão',
    forbidden: 'Página bloqueada pelo Chrome para extensões',
    otherDebugger: 'Outro depurador (DevTools) está aberto nesta aba; feche-o e tente de novo'
  }
  const attached = new Map() // tabId -> timer de detach
  const canceled = new Set() // abas cujo debugger o usuário cancelou

  const FORBIDDEN = [/^chrome:/i, /^chrome-extension:/i, /^edge:/i, /^brave:/i, /^devtools:/i, /^view-source:/i,
    /^https:\/\/chromewebstore\.google\.com/i, /^https:\/\/chrome\.google\.com\/webstore/i,
    /^https:\/\/microsoftedge\.microsoft\.com\/addons/i]
  const isForbidden = (url) => FORBIDDEN.some((re) => re.test(url || ''))

  chrome.debugger.onDetach.addListener((source, reason) => {
    const tabId = source.tabId
    clearTimeout(attached.get(tabId))
    attached.delete(tabId)
    if (reason === 'canceled_by_user') canceled.add(tabId)
  })

  function translate(err, tabId) {
    const msg = String(err?.message || err)
    if (canceled.has(tabId) || /detached|canceled/i.test(msg)) return new Error(ERR.canceled)
    if (/cannot access|cannot attach|chrome-extension:|chrome:\/\//i.test(msg)) return new Error(ERR.forbidden)
    return err instanceof Error ? err : new Error(msg)
  }

  function armDetach(tabId) {
    clearTimeout(attached.get(tabId))
    attached.set(tabId, setTimeout(() => {
      attached.delete(tabId)
      chrome.debugger.detach({ tabId }).catch(() => {})
    }, IDLE_DETACH_MS))
  }

  async function ensureAttached(tab) {
    if (isForbidden(tab.url)) throw new Error(ERR.forbidden)
    canceled.delete(tab.id)
    if (!attached.has(tab.id)) {
      try {
        await chrome.debugger.attach({ tabId: tab.id }, '1.3')
      } catch (err) {
        // Outro cliente (DevTools) tem a aba: sendCommand falharia depois, sem explicação.
        if (!/already attached/i.test(String(err?.message))) throw translate(err, tab.id)
        // Pode ser sessão nossa que sobreviveu a um reinício do service worker
        // (o Set `attached` zera): detach só funciona para quem anexou.
        try {
          await chrome.debugger.detach({ tabId: tab.id })
          await chrome.debugger.attach({ tabId: tab.id }, '1.3')
        } catch {
          throw new Error(ERR.otherDebugger)
        }
      }
    }
    armDetach(tab.id)
  }

  async function send(tabId, method, params) {
    if (canceled.has(tabId)) throw new Error(ERR.canceled)
    try {
      const res = await chrome.debugger.sendCommand({ tabId }, method, params || {})
      armDetach(tabId)
      return res
    } catch (err) {
      throw translate(err, tabId)
    }
  }

  /** Runtime.evaluate com returnByValue/awaitPromise; exceção da página vira erro. */
  async function evaluate(tabId, expression) {
    const res = await send(tabId, 'Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true
    })
    if (res.exceptionDetails) {
      const d = res.exceptionDetails
      throw new Error(d.exception?.description || d.text || 'Erro ao avaliar JavaScript')
    }
    return res.result?.value
  }

  // Busca o elemento marcado pelo snapshot, inclusive dentro de shadow DOM aberto.
  const FIND_REF = `function (ref) {
    const roots = [document]
    while (roots.length) {
      const root = roots.shift()
      const hit = root.querySelector('[data-agent-ref="' + ref + '"]')
      if (hit) return hit
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot)
    }
    return null
  }`

  /** Roda `body` (usa a variável `el`) sobre o elemento da ref; ref ausente → erro do contrato. */
  async function withRef(tabId, ref, body) {
    const expr = `(() => { const el = (${FIND_REF})(${JSON.stringify(String(ref))});
      if (!el || !el.isConnected) return { missing: true };
      ${body} })()`
    const value = await evaluate(tabId, expr)
    if (value && value.missing) throw new Error(ERR.ref)
    return value
  }

  /** scrollIntoView + centro do retângulo, em coordenadas do viewport. */
  async function refCenter(tabId, ref) {
    return withRef(tabId, ref, `el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`)
  }

  async function clickAt(tabId, x, y) {
    const base = { x, y, button: 'left', clickCount: 1 }
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 })
    await send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 })
  }

  const KEYS = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Tab: { code: 'Tab', keyCode: 9 },
    Escape: { code: 'Escape', keyCode: 27 }, Backspace: { code: 'Backspace', keyCode: 8 },
    Delete: { code: 'Delete', keyCode: 46 }, Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { code: 'ArrowRight', keyCode: 39 },
    Home: { code: 'Home', keyCode: 36 }, End: { code: 'End', keyCode: 35 },
    PageUp: { code: 'PageUp', keyCode: 33 }, PageDown: { code: 'PageDown', keyCode: 34 }
  }
  const MODIFIERS = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, shift: 8 }
  const EDIT_COMMANDS = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo', y: 'redo' }

  /** Tecla ou combinação ("Enter", "Control+a", "Shift+Tab") via Input.dispatchKeyEvent. */
  async function pressKey(tabId, combo) {
    const parts = String(combo || '').split('+').map((p) => p.trim()).filter(Boolean)
    const main = parts.pop()
    if (!main) throw new Error('Tecla vazia')
    let modifiers = 0
    for (const p of parts) {
      const bit = MODIFIERS[p.toLowerCase()]
      if (!bit) throw new Error(`Modificador desconhecido: ${p}`)
      modifiers |= bit
    }
    let def = KEYS[main]
    if (!def && main.length === 1) {
      const upper = main.toUpperCase()
      const isLetter = /[a-z]/i.test(main)
      def = {
        key: main, code: isLetter ? `Key${upper}` : /\d/.test(main) ? `Digit${main}` : '',
        keyCode: upper.charCodeAt(0), text: main
      }
    }
    if (!def) throw new Error(`Tecla desconhecida: ${main}`)
    const key = def.key || main
    const typing = def.text && !(modifiers & (1 | 2 | 4))
    const down = {
      type: typing ? 'keyDown' : 'rawKeyDown', modifiers, key, code: def.code,
      windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode
    }
    if (typing) Object.assign(down, { text: def.text, unmodifiedText: def.text })
    const cmd = modifiers & (2 | 4) ? EDIT_COMMANDS[main.toLowerCase()] : null
    if (cmd) down.commands = [cmd]
    await send(tabId, 'Input.dispatchKeyEvent', down)
    await send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', modifiers, key, code: def.code,
      windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode
    })
  }

  self.AgentCdp = { ERR, isForbidden, ensureAttached, send, evaluate, withRef, refCenter, clickAt, pressKey }
})()
