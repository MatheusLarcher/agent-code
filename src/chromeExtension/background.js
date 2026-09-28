// Service worker da extensão local do Agent Code. Fala só com 127.0.0.1.
// Protocolo: docs/superpowers/plans/2026-09-28-chrome-extension.md.
// config.js é gerado pelo Agent Code na pasta instalada; sem ele a extensão
// fica ociosa em vez de derrubar o service worker.
try { importScripts('config.js') } catch { /* não instalada pelo Agent Code */ }
importScripts('snapshot.js', 'cdp.js')

const CONFIG = self.AGENT_CODE_CONFIG || { ports: [], token: '' }
const VERSION = chrome.runtime.getManifest().version
const { ERR } = self.AgentCdp
const PING_MS = 20_000
const HELLO_TIMEOUT_MS = 3_000
const RECONNECT_ALARM = 'agent-code-reconnect'
const GROUP_TITLE = 'Agent Code'
const WAIT_MAX_MS = 25_000
const EVAL_MAX_CHARS = 8000

let ws = null
let connected = false
let connecting = false
let pingTimer = null
let paused = false

chrome.storage.local.get('paused').then((v) => { paused = v.paused === true })

// ---------- conexão ----------

function tryPort(port) {
  return new Promise((resolve) => {
    let sock
    try { sock = new WebSocket(`ws://127.0.0.1:${port}`) } catch { return resolve(null) }
    const fail = () => { clearTimeout(timer); try { sock.close() } catch {} ; resolve(null) }
    const timer = setTimeout(fail, HELLO_TIMEOUT_MS + 1000)
    sock.onerror = fail
    sock.onclose = fail
    sock.onopen = () => sock.send(JSON.stringify({ type: 'hello', token: CONFIG.token, version: VERSION, userAgent: navigator.userAgent }))
    sock.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return fail() }
      if (msg.type !== 'welcome') return fail()
      clearTimeout(timer)
      sock.onerror = sock.onclose = sock.onmessage = null
      resolve({ sock, welcome: msg })
    }
  })
}

async function connect() {
  if (connected || connecting || !CONFIG.token) return
  connecting = true
  try {
    for (const port of CONFIG.ports || []) {
      const hit = await tryPort(port)
      if (!hit) continue
      if (await maybeReload(hit.welcome.version)) return
      attach(hit.sock)
      return
    }
  } finally {
    connecting = false
  }
}

/** Versão do servidor diferente da do manifest ⇒ recarrega do disco, uma vez por versão. */
async function maybeReload(expected) {
  if (!expected || expected === VERSION) return false
  const key = `reloadedFor:${expected}`
  const seen = await chrome.storage.session.get(key)
  if (seen[key]) return false
  await chrome.storage.session.set({ [key]: true })
  chrome.runtime.reload()
  return true
}

function attach(sock) {
  ws = sock
  connected = true
  clearInterval(pingTimer)
  pingTimer = setInterval(() => sendFrame({ type: 'ping' }), PING_MS)
  sock.onmessage = (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (msg.type === 'req' && typeof msg.id !== 'undefined') handleRequest(msg)
  }
  sock.onclose = () => {
    if (ws !== sock) return
    ws = null
    connected = false
    clearInterval(pingTimer)
  }
}

function sendFrame(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
}

chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((a) => { if (a.name === RECONNECT_ALARM) connect() })
chrome.runtime.onStartup.addListener(connect)
chrome.runtime.onInstalled.addListener(connect)
connect()

// ---------- popup ----------

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'getStatus') reply({ connected, paused, version: VERSION })
  else if (msg?.type === 'setPaused') {
    paused = msg.paused === true
    chrome.storage.local.set({ paused }).then(() => reply({ connected, paused, version: VERSION }))
    return true
  }
})

// ---------- fila por aba ----------

const ACTIVE_TAB_METHODS = new Set(['snapshot', 'screenshot', 'scroll', 'wait', 'navigate', 'click', 'type',
  'pressKey', 'selectOption', 'evaluate'])
const queues = new Map()
function enqueue(key, fn) {
  const prev = queues.get(key) || Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  const tail = run.catch(() => {})
  queues.set(key, tail)
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
  return run
}

async function handleRequest({ id, method, params }) {
  const p = params && typeof params === 'object' ? params : {}
  try {
    const fn = METHODS[method]
    if (!fn) throw new Error(`Método desconhecido: ${method}`)
    if (paused && method !== 'status') throw new Error(ERR.paused)
    // Sem tabId, a aba ativa é resolvida ANTES de enfileirar: senão a mesma aba
    // teria duas filas ('default' e 'tab:N') e comandos correriam em paralelo.
    if (p.tabId == null && ACTIVE_TAB_METHODS.has(method)) p.tabId = (await getTab()).id
    const key = p.tabId != null ? `tab:${p.tabId}` : 'default'
    const result = await enqueue(key, () => fn(p))
    sendFrame({ type: 'res', id, ok: true, result })
  } catch (err) {
    sendFrame({ type: 'res', id, ok: false, error: String(err?.message || err) })
  }
}

// ---------- abas ----------

async function getTab(tabId) {
  if (tabId != null) {
    try { return await chrome.tabs.get(Number(tabId)) } catch { throw new Error(`Aba ${tabId} não existe`) }
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab) throw new Error('Nenhuma aba ativa')
  return tab
}

async function info(tabId) {
  const t = await chrome.tabs.get(tabId)
  return { tabId: t.id, url: t.url || t.pendingUrl || '', title: t.title || '' }
}

function waitLoad(tabId, timeout = 15_000) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve() }
    const listener = (id, change) => { if (id === tabId && change.status === 'complete') done() }
    const timer = setTimeout(done, timeout)
    chrome.tabs.onUpdated.addListener(listener)
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') done() }).catch(done)
  })
}

async function addToGroup(tab) {
  const [group] = await chrome.tabGroups.query({ title: GROUP_TITLE, windowId: tab.windowId })
  const groupId = await chrome.tabs.group(group ? { groupId: group.id, tabIds: [tab.id] } : { tabIds: [tab.id] })
  if (!group) await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'purple' })
}

/** Aba com debugger acoplado; devolve o id. */
async function cdpTab(p) {
  const tab = await getTab(p.tabId)
  await self.AgentCdp.ensureAttached(tab)
  return tab.id
}

const cdp = self.AgentCdp
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- métodos ----------

const METHODS = {
  async status() {
    return { paused, userAgent: navigator.userAgent }
  },

  async listTabs() {
    const [tabs, groups] = await Promise.all([chrome.tabs.query({}), chrome.tabGroups.query({})])
    const names = new Map(groups.map((g) => [g.id, g.title || '']))
    return {
      tabs: tabs.map((t) => {
        const out = { tabId: t.id, windowId: t.windowId, active: t.active, url: t.url || '', title: t.title || '' }
        if (t.groupId >= 0) out.group = names.get(t.groupId) || ''
        return out
      })
    }
  },

  async snapshot(p) {
    const tabId = await cdpTab(p)
    const maxChars = Number.isFinite(Number(p.maxChars)) ? Number(p.maxChars) : 6000
    const text = await cdp.evaluate(tabId, `(${agentCodeSnapshot.toString()})(${maxChars})`)
    return { text: String(text ?? ''), ...(await info(tabId)) }
  },

  async screenshot(p) {
    const tabId = await cdpTab(p)
    const { data } = await cdp.send(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 70 })
    return { data, ...(await info(tabId)) }
  },

  async scroll(p) {
    const tabId = await cdpTab(p)
    if (p.ref) {
      await cdp.withRef(tabId, p.ref, `el.scrollIntoView({ block: 'center' }); return true;`)
    } else {
      const sign = p.direction === 'up' ? -1 : 1
      const amount = Number(p.amount) > 0 ? Number(p.amount) : null
      await cdp.evaluate(tabId, `window.scrollBy(0, ${sign} * (${amount ?? 'Math.round(window.innerHeight * 0.8)'})); true`)
    }
    return info(tabId)
  },

  async wait(p) {
    const tab = await getTab(p.tabId)
    const deadline = Date.now() + Math.min(Math.max(Number(p.ms) || (p.text ? WAIT_MAX_MS : 1000), 0), WAIT_MAX_MS)
    if (!p.text) {
      await sleep(deadline - Date.now())
      return info(tab.id)
    }
    await cdp.ensureAttached(tab)
    const probe = `(document.body?.innerText || '').includes(${JSON.stringify(String(p.text))})`
    let found = false
    while (!(found = await cdp.evaluate(tab.id, probe).catch(() => false)) && Date.now() < deadline) await sleep(250)
    return { found, ...(await info(tab.id)) }
  },

  async openTab(p) {
    if (!p.url) throw new Error('url obrigatória')
    const tab = await chrome.tabs.create({ url: String(p.url), active: true })
    await addToGroup(tab).catch(() => {})
    await waitLoad(tab.id)
    return info(tab.id)
  },

  async selectTab(p) {
    const tab = await getTab(p.tabId ?? -1)
    await chrome.tabs.update(tab.id, { active: true })
    await chrome.windows.update(tab.windowId, { focused: true })
    return info(tab.id)
  },

  async closeTab(p) {
    const tab = await getTab(p.tabId ?? -1)
    const out = { tabId: tab.id, url: tab.url || '', title: tab.title || '' }
    await chrome.tabs.remove(tab.id)
    return out
  },

  async navigate(p) {
    const tab = await getTab(p.tabId)
    if (p.url) {
      if (cdp.isForbidden(String(p.url))) throw new Error(ERR.forbidden)
      await chrome.tabs.update(tab.id, { url: String(p.url) })
    } else if (p.action === 'back') await chrome.tabs.goBack(tab.id)
    else if (p.action === 'forward') await chrome.tabs.goForward(tab.id)
    else if (p.action === 'reload') await chrome.tabs.reload(tab.id)
    else throw new Error('Informe url ou action (back, forward, reload)')
    await sleep(100)
    await waitLoad(tab.id)
    return info(tab.id)
  },

  async click(p) {
    const tabId = await cdpTab(p)
    let pt
    if (p.ref) pt = await cdp.refCenter(tabId, p.ref)
    else if (Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))) pt = { x: Number(p.x), y: Number(p.y) }
    else throw new Error('Informe ref ou x,y')
    await cdp.clickAt(tabId, pt.x, pt.y)
    await sleep(150)
    return info(tabId)
  },

  async type(p) {
    const tabId = await cdpTab(p)
    if (p.ref) {
      await cdp.withRef(tabId, p.ref, `el.scrollIntoView({ block: 'center' }); el.focus(); return true;`)
    }
    if (p.clear) {
      await cdp.evaluate(tabId, `(() => { const el = document.activeElement; if (!el) return false;
        if (typeof el.select === 'function') el.select();
        else if (el.isContentEditable) document.getSelection().selectAllChildren(el);
        return true })()`)
    }
    await cdp.send(tabId, 'Input.insertText', { text: String(p.text ?? '') })
    if (p.submit) await cdp.pressKey(tabId, 'Enter')
    return info(tabId)
  },

  async pressKey(p) {
    const tabId = await cdpTab(p)
    await cdp.pressKey(tabId, p.key)
    return info(tabId)
  },

  async selectOption(p) {
    const tabId = await cdpTab(p)
    const value = JSON.stringify(String(p.value ?? ''))
    const ok = await cdp.withRef(tabId, p.ref, `if (el.tagName !== 'SELECT') return { error: 'Elemento não é um select' };
      const v = ${value};
      const opt = [...el.options].find((o) => o.value === v) || [...el.options].find((o) => o.text.trim() === v);
      if (!opt) return { error: 'Opção não encontrada: ' + v };
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };`)
    if (ok?.error) throw new Error(ok.error)
    return info(tabId)
  },

  async evaluate(p) {
    const tabId = await cdpTab(p)
    const raw = await cdp.evaluate(tabId, String(p.expression ?? ''))
    let value = raw === undefined ? 'undefined' : JSON.stringify(raw)
    if (value.length > EVAL_MAX_CHARS) value = value.slice(0, EVAL_MAX_CHARS) + '…(truncado)'
    return { value, ...(await info(tabId)) }
  }
}
