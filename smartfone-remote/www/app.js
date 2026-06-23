/*
 * Agent Remote — phone client for the desktop "agent-code" app.
 *
 * Talks to the PC LAN bridge (src/main/remote/remoteServer.ts):
 *   GET  /api/state            list conversations
 *   GET  /api/history?conv=ID  full message history of a conversation
 *   GET  /api/events  (SSE)    live agent events {convId, event}
 *   POST /api/send             send a command into a conversation
 *
 * It mirrors the desktop chat (history + what's being built) but is limited to
 * sending commands — permissions are approved on the PC.
 */
'use strict'

var CONFIG_KEY = 'agent-remote-config'
var LAST_CONV_KEY = 'agent-remote-last-conv'

var state = {
  base: '',
  token: '',
  conversations: [],
  convId: null,
  messages: [],
  es: null,
  poll: null,
  images: [],        // staged image attachments {mediaType, data}
  reconnect: null,   // pending SSE reconnect timer
  retry: 0,          // backoff step
  wakeLock: null,    // screen wake lock (keeps the app awake/connected)
  online: false,
  openTools: {}      // tool-use ids the user expanded (persist across re-renders)
}

var $ = function (id) { return document.getElementById(id) }

// ---- config / pairing -----------------------------------------------------

function parseConfig(addr, token) {
  addr = (addr || '').trim()
  token = (token || '').trim()
  var base = ''
  if (/^https?:\/\//i.test(addr)) {
    try {
      var u = new URL(addr)
      base = u.protocol + '//' + u.host
      if (!token && u.searchParams.get('token')) token = u.searchParams.get('token')
    } catch (e) { /* invalid url */ }
  } else if (addr) {
    base = 'http://' + addr.replace(/\/+$/, '')
  }
  return { base: base, token: token }
}

function loadConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null') } catch (e) { return null }
}
function saveConfig(cfg) { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)) }

function api(path) {
  var sep = path.indexOf('?') >= 0 ? '&' : '?'
  return state.base + path + sep + 'token=' + encodeURIComponent(state.token)
}

// ---- message reducer (mirrors renderer reduceMessages) --------------------

function reduce(list, e) {
  if (e.kind === 'assistant-text') {
    for (var i = 0; i < list.length; i++) {
      if (list[i].kind === 'assistant-text' && list[i].id === e.id) {
        list[i] = Object.assign({}, e)
        return list
      }
    }
  }
  if (e.kind === 'tool-result') {
    for (var j = 0; j < list.length; j++) {
      if (list[j].kind === 'tool-use' && list[j].id === e.toolUseId) {
        list[j] = Object.assign({}, list[j], { result: { isError: e.isError, text: e.text } })
        return list
      }
    }
    return list
  }
  if (e.kind === 'result') {
    for (var k = list.length - 1; k >= 0; k--) {
      if (list[k].kind === 'assistant-text') { list[k] = Object.assign({}, list[k], { answer: true }); break }
    }
    return list
  }
  list.push(e)
  return list
}

// ---- rendering ------------------------------------------------------------

function el(cls, text) {
  var d = document.createElement('div')
  d.className = cls
  if (text != null) d.textContent = text
  return d
}

function summarizeInput(input) {
  try {
    var s = typeof input === 'string' ? input : JSON.stringify(input)
    return s.length > 220 ? s.slice(0, 220) + '…' : s
  } catch (e) { return '' }
}

// Deliverable file types a user would ask to create and download (APK, zip, PDF,
// image…). Code/config the agent edits while working is intentionally excluded.
var DOWNLOADABLE_EXTS = {
  zip: 1, tar: 1, gz: 1, tgz: 1, bz2: 1, xz: 1, rar: 1, '7z': 1,
  apk: 1, aab: 1, ipa: 1, exe: 1, msi: 1, dmg: 1, pkg: 1, deb: 1, rpm: 1, appimage: 1, iso: 1, jar: 1, bin: 1,
  pdf: 1, doc: 1, docx: 1, xls: 1, xlsx: 1, ppt: 1, pptx: 1, odt: 1, ods: 1, odp: 1, rtf: 1, epub: 1, csv: 1,
  png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, bmp: 1, svg: 1, ico: 1, mp4: 1, mov: 1, webm: 1, avi: 1, mkv: 1,
  mp3: 1, wav: 1, ogg: 1, flac: 1,
  ttf: 1, otf: 1, woff: 1, woff2: 1
}
function isDownloadableFile(p) {
  var m = /\.([a-z0-9]+)$/i.exec(p || '')
  return !!(m && DOWNLOADABLE_EXTS[m[1].toLowerCase()])
}
// Only files CREATED via Write (not edits) and of a deliverable type are offered.
function writtenPath(name, input) {
  if (name !== 'Write' || !input || typeof input !== 'object') return ''
  var p = input.file_path
  return typeof p === 'string' && isDownloadableFile(p) ? p : ''
}

function lineCount(s) {
  return typeof s === 'string' && s.length ? s.split('\n').length : 0
}

// Compact, Claude-Code-style label for a tool call (mirrors the PC describeTool):
// a verb, a detail (file/skill), and +/- line stats for file edits.
function describeTool(name, input) {
  var inp = (input && typeof input === 'object') ? input : {}
  switch (name) {
    case 'Skill':
      return { verb: 'Skill', detail: String(inp.skill || 'skill'), isSkill: true, stats: null }
    case 'Write':
      return { verb: 'Write', detail: basename(inp.file_path), isSkill: false, stats: { added: lineCount(inp.content), removed: 0 } }
    case 'Edit':
      return { verb: 'Edit', detail: basename(inp.file_path), isSkill: false, stats: { added: lineCount(inp.new_string), removed: lineCount(inp.old_string) } }
    case 'MultiEdit': {
      var added = 0, removed = 0
      if (Array.isArray(inp.edits)) {
        inp.edits.forEach(function (e) { added += lineCount(e && e.new_string); removed += lineCount(e && e.old_string) })
      }
      return { verb: 'Edit', detail: basename(inp.file_path), isSkill: false, stats: { added: added, removed: removed } }
    }
    case 'NotebookEdit':
      return { verb: 'Edit', detail: basename(inp.notebook_path), isSkill: false, stats: { added: lineCount(inp.new_source), removed: 0 } }
    case 'Read':
      return { verb: 'Read', detail: basename(inp.file_path), isSkill: false, stats: null }
    default:
      return { verb: String(name || 'tool').replace(/^mcp__browser__/, '🌐 ').replace(/^mcp__[^_]+__/, ''), detail: '', isSkill: false, stats: null }
  }
}

// Ask the PC bridge to stream the file; the WebView's download listener saves it
// to the phone's Downloads folder (works even on Android, in the installed app).
function triggerDownload(path) {
  var url = api('/api/file?path=' + encodeURIComponent(path))
  var a = document.createElement('a')
  a.href = url
  a.setAttribute('download', basename(path))
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(function () { document.body.removeChild(a) }, 0)
}

// A collapsed, expandable tool card (mirrors the PC ToolCard): compact header
// with verb/file/±stats/badge; tap to reveal input + result. Expanded state is
// kept in state.openTools so it survives the frequent full re-renders.
function renderTool(m) {
  var info = describeTool(m.name, m.input)
  var hasDiff = info.stats && (info.stats.added > 0 || info.stats.removed > 0)
  var open = !!state.openTools[m.id]

  var card = el('tool-card' + (info.isSkill ? ' tool-skill' : '') + (m.result && m.result.isError ? ' tool-error' : ''))

  var head = el('tool-head')
  head.appendChild(el('tool-caret', open ? '▾' : '▸'))
  head.appendChild(el('tool-verb', info.verb))
  if (info.detail) head.appendChild(el('tool-detail', info.detail))
  if (hasDiff) {
    var diff = el('tool-diff')
    if (info.stats.added > 0) diff.appendChild(el('diff-add', '+' + info.stats.added))
    if (info.stats.removed > 0) diff.appendChild(el('diff-del', '−' + info.stats.removed))
    head.appendChild(diff)
  }
  // A created deliverable (Write) that finished OK is downloadable.
  var fp = m.result && !m.result.isError ? writtenPath(m.name, m.input) : ''
  if (fp) {
    var dl = document.createElement('button')
    dl.className = 'tool-dl'
    dl.textContent = '⬇️ Baixar'
    dl.addEventListener('click', function (e) { e.stopPropagation(); triggerDownload(fp) })
    head.appendChild(dl)
  }
  var badge = m.result
    ? el('tool-badge ' + (m.result.isError ? 'err' : 'ok'), m.result.isError ? 'error' : 'done')
    : el('tool-badge run', 'running…')
  head.appendChild(badge)

  var body = el('tool-body')
  body.hidden = !open
  body.appendChild(el('tool-section-label', 'input'))
  var pre = el('tool-pre')
  pre.textContent = (function () {
    try { return JSON.stringify(m.input, null, 2).slice(0, 1500) } catch (e) { return summarizeInput(m.input) }
  })()
  body.appendChild(pre)
  if (m.result) {
    body.appendChild(el('tool-section-label', 'result'))
    var rpre = el('tool-pre' + (m.result.isError ? ' err' : ''))
    rpre.textContent = (m.result.text || '').slice(0, 2500)
    body.appendChild(rpre)
  }

  head.addEventListener('click', function () {
    var nowOpen = !state.openTools[m.id]
    if (nowOpen) state.openTools[m.id] = true
    else delete state.openTools[m.id]
    body.hidden = !nowOpen
    head.firstChild.textContent = nowOpen ? '▾' : '▸'
  })

  card.appendChild(head)
  card.appendChild(body)
  return card
}

function renderMessages() {
  var box = $('messages')
  var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80
  box.innerHTML = ''
  state.messages.forEach(function (m) {
    if (m.kind === 'user') {
      var u = el('msg user')
      if (m.images && m.images.length) {
        var gal = el('msg-imgs')
        m.images.forEach(function (src) {
          var im = document.createElement('img')
          im.src = src
          gal.appendChild(im)
        })
        u.appendChild(gal)
      }
      if (m.text) u.appendChild(document.createTextNode(m.text))
      box.appendChild(u)
    } else if (m.kind === 'assistant-text') {
      box.appendChild(el('msg assistant', m.text))
    } else if (m.kind === 'thinking') {
      box.appendChild(el('msg thinking', m.text))
    } else if (m.kind === 'system') {
      box.appendChild(el('msg system', 'sessão pronta' + (m.model ? ' · ' + m.model : '')))
    } else if (m.kind === 'error') {
      box.appendChild(el('msg error', m.text))
    } else if (m.kind === 'status') {
      box.appendChild(el('msg system', m.text))
    } else if (m.kind === 'tool-use') {
      box.appendChild(renderTool(m))
    }
  })
  if (nearBottom) box.scrollTop = box.scrollHeight
}

// ---- networking -----------------------------------------------------------

function setStatus(on) {
  state.online = on
  var s = $('status')
  s.className = 'status ' + (on ? 'on' : 'off')
  var label = s.querySelector('.status-text')
  if (label) label.textContent = on ? 'online' : 'offline'
  // Hide the reconnect banner once we're back online.
  if (on) $('reconnect').hidden = true
}

function fetchState() {
  return fetch(api('/api/state'))
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
    .then(function (data) {
      state.conversations = data.conversations || []
      if (!$('history').hidden) renderHistory()
      updateConvTitle()
      var cur = current()
      $('busy').hidden = !(cur && cur.busy)
      return data
    })
}

function current() {
  for (var i = 0; i < state.conversations.length; i++)
    if (state.conversations[i].id === state.convId) return state.conversations[i]
  return null
}

function basename(p) {
  var parts = (p || '').split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] || p || '—'
}

function updateConvTitle() {
  var cur = current()
  $('conv-title-text').textContent = (cur && cur.title) || 'Conversa'
}

// History drawer, grouped by project (cwd) like the PC sidebar.
function renderHistory() {
  var list = $('history-list')
  list.innerHTML = ''
  var convs = state.conversations.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt })
  var groups = {}
  var order = []
  convs.forEach(function (c) {
    var k = c.cwd || ''
    if (!groups[k]) { groups[k] = []; order.push(k) }
    groups[k].push(c)
  })
  order.forEach(function (k) {
    var g = el('hist-group')
    g.appendChild(el('hist-project', '📁 ' + basename(k)))
    groups[k].forEach(function (c) {
      var row = el('hist-row' + (c.id === state.convId ? ' active' : ''))
      row.appendChild(el('hist-title', c.title || 'Conversa'))
      if (c.busy) row.appendChild(el('hist-busy', '⏳'))
      row.addEventListener('click', function () { selectConv(c.id); closeDrawer() })
      g.appendChild(row)
    })
    list.appendChild(g)
  })
  updateConvTitle()
}

// ---- drawer / connection menu --------------------------------------------

function openDrawer() {
  renderHistory()
  $('history').hidden = false
  $('scrim').hidden = false
}
function closeDrawer() {
  $('history').hidden = true
  if ($('status-menu').hidden) $('scrim').hidden = true
}
function toggleStatusMenu() {
  var m = $('status-menu')
  var show = m.hidden
  $('status-info').textContent = state.base ? state.base.replace(/^https?:\/\//, '') : 'conectado'
  m.hidden = !show
  if (show) $('scrim').hidden = false
  else if ($('history').hidden) $('scrim').hidden = true
}
function closeMenus() {
  $('history').hidden = true
  $('status-menu').hidden = true
  $('scrim').hidden = true
}

function loadHistory(convId) {
  return fetch(api('/api/history?conv=' + encodeURIComponent(convId)))
    .then(function (r) { return r.json() })
    .then(function (data) {
      state.messages = (data.messages || []).slice()
      renderMessages()
    })
}

function scheduleReconnect() {
  if (state.reconnect) return
  // Only auto-reconnect while we're meant to be in the chat (paired).
  if ($('chat').hidden) return
  $('reconnect').hidden = false
  // Exponential backoff capped at 8s — keeps trying as long as the app is open.
  var delay = Math.min(8000, 800 * Math.pow(2, state.retry))
  state.retry++
  state.reconnect = setTimeout(function () {
    state.reconnect = null
    openEvents()
    // Refresh state too, so the conversation list/history catch up after a drop.
    fetchState().catch(function () {})
  }, delay)
}

function openEvents() {
  if (state.reconnect) { clearTimeout(state.reconnect); state.reconnect = null }
  if (state.es) state.es.close()
  var es = new EventSource(api('/api/events'))
  state.es = es
  es.onopen = function () { state.retry = 0; setStatus(true) }
  es.onerror = function () {
    setStatus(false)
    // EventSource auto-retries, but a closed stream (PC bridge restarted) needs a
    // fresh connection — drive our own reconnect so we always come back.
    try { es.close() } catch (e) {}
    if (state.es === es) state.es = null
    scheduleReconnect()
  }
  es.onmessage = function (ev) {
    var msg
    try { msg = JSON.parse(ev.data) } catch (e) { return }
    if (!msg || msg.convId !== state.convId) {
      // Event for another conversation — refresh the list (busy flags/titles).
      fetchState()
      return
    }
    reduce(state.messages, msg.event)
    renderMessages()
    if (msg.event.kind === 'result' || msg.event.kind === 'error') {
      $('busy').hidden = true
      fetchState()
    } else {
      $('busy').hidden = false
    }
  }
}

function selectConv(convId) {
  state.convId = convId
  localStorage.setItem(LAST_CONV_KEY, convId)
  updateConvTitle()
  var cur = current()
  $('busy').hidden = !(cur && cur.busy)
  loadHistory(convId)
}

function send() {
  var input = $('input')
  var text = input.value.trim()
  var imgs = state.images.slice()
  if ((!text && !imgs.length) || !state.convId) return
  var thumbs = imgs.map(function (im) { return 'data:' + im.mediaType + ';base64,' + im.data })
  // Optimistic echo (the PC adds the user message locally; SSE only carries
  // agent events, so there's no duplicate).
  reduce(state.messages, { kind: 'user', id: 'u' + Date.now(), text: text, images: thumbs })
  renderMessages()
  input.value = ''
  state.images = []
  renderPreview()
  autoGrow()
  $('busy').hidden = false
  // Token goes in the query string (like the GET/SSE routes); body is the command.
  fetch(api('/api/send'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ convId: state.convId, text: text, images: imgs })
  }).catch(function () { setStatus(false) })
}

// ---- image attachments ----------------------------------------------------

// Read an image File into a base64 attachment (strips the data-URL prefix),
// downscaling large photos so the LAN payload stays small.
function fileToAttachment(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader()
    reader.onload = function () {
      var img = new Image()
      img.onload = function () {
        var MAX = 1600
        var w = img.width, h = img.height
        if (w > MAX || h > MAX) {
          var scale = MAX / Math.max(w, h)
          w = Math.round(w * scale); h = Math.round(h * scale)
        }
        var canvas = document.createElement('canvas')
        canvas.width = w; canvas.height = h
        canvas.getContext('2d').drawImage(img, 0, 0, w, h)
        var dataUrl = canvas.toDataURL('image/jpeg', 0.85)
        var m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl)
        if (m) resolve({ mediaType: m[1], data: m[2] })
        else reject(new Error('imagem inválida'))
      }
      img.onerror = function () { reject(new Error('imagem inválida')) }
      img.src = String(reader.result)
    }
    reader.onerror = function () { reject(new Error('falha ao ler imagem')) }
    reader.readAsDataURL(file)
  })
}

function addFiles(files) {
  var list = [].slice.call(files).filter(function (f) { return f.type.indexOf('image/') === 0 })
  if (!list.length) return
  Promise.all(list.map(fileToAttachment)).then(function (atts) {
    state.images = state.images.concat(atts).slice(0, 8)
    renderPreview()
  }).catch(function () {})
}

function renderPreview() {
  var tray = $('preview')
  tray.innerHTML = ''
  if (!state.images.length) { tray.hidden = true; return }
  tray.hidden = false
  state.images.forEach(function (im, i) {
    var item = el('preview-item')
    var pic = document.createElement('img')
    pic.src = 'data:' + im.mediaType + ';base64,' + im.data
    item.appendChild(pic)
    var rm = document.createElement('button')
    rm.className = 'rm'
    rm.textContent = '✕'
    rm.addEventListener('click', function () {
      state.images.splice(i, 1)
      renderPreview()
    })
    item.appendChild(rm)
    tray.appendChild(item)
  })
}

// ---- screens --------------------------------------------------------------

function showChat() {
  $('pair').hidden = true
  $('chat').hidden = false
  state.retry = 0
  requestWakeLock()
  fetchState()
    .then(function () {
      if (!state.conversations.length) {
        alert('Nenhuma conversa no PC ainda. Crie uma conversa no app do PC primeiro.')
        return
      }
      var last = localStorage.getItem(LAST_CONV_KEY)
      var pick = state.conversations.some(function (c) { return c.id === last }) ? last : state.conversations[0].id
      selectConv(pick)
      openEvents()
      if (state.poll) clearInterval(state.poll)
      state.poll = setInterval(fetchState, 4000)
    })
    .catch(function (e) {
      showPair('Não foi possível conectar: ' + e.message + '. Confira endereço/token e a rede.')
    })
}

function showPair(error) {
  if (state.es) { state.es.close(); state.es = null }
  if (state.poll) { clearInterval(state.poll); state.poll = null }
  if (state.reconnect) { clearTimeout(state.reconnect); state.reconnect = null }
  $('reconnect').hidden = true
  releaseWakeLock()
  if (typeof stopScan === 'function') stopScan()
  $('chat').hidden = true
  $('pair').hidden = false
  // Reset to the QR-first layout (manual entry collapsed behind the link).
  $('manual').hidden = true
  $('toggle-manual').hidden = false
  var err = $('pair-error')
  if (error) { err.textContent = error; err.hidden = false } else { err.hidden = true }
}

function autoGrow() {
  var t = $('input')
  t.style.height = 'auto'
  t.style.height = Math.min(t.scrollHeight, 140) + 'px'
}

// ---- QR scanner (camera + jsQR) ------------------------------------------

var scan = { stream: null, timer: 0 }

function showManual(error) {
  $('manual').hidden = false
  $('toggle-manual').hidden = true
  if (error) { var e = $('pair-error'); e.textContent = error; e.hidden = false }
}

function applyConfig(cfg) {
  state.base = cfg.base
  state.token = cfg.token
  saveConfig(cfg)
  $('addr').value = cfg.base
  $('token').value = cfg.token
  showChat()
}

function startScan() {
  $('pair-error').hidden = true
  var hasCam = navigator.mediaDevices && navigator.mediaDevices.getUserMedia
  if (!hasCam || typeof jsQR === 'undefined') {
    // getUserMedia needs a secure context. The installed APK runs from
    // http://localhost (secure → camera OK); the web client over http://IP is
    // an insecure origin, so the camera is blocked here — fall back to manual.
    var insecure = !window.isSecureContext
    showManual(
      insecure
        ? 'A câmera só funciona no app instalado. Aqui no navegador, insira o endereço manualmente.'
        : 'Câmera indisponível neste dispositivo. Insira os dados manualmente.'
    )
    return
  }
  $('scanner').hidden = false
  navigator.mediaDevices
    .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
    .then(function (stream) {
      scan.stream = stream
      var v = $('video')
      // muted + autoplay + playsinline → the WebView plays the live MediaStream
      // without a user gesture (otherwise it stays paused, showing a play poster).
      v.srcObject = stream
      v.muted = true
      v.autoplay = true
      v.playsInline = true
      v.setAttribute('playsinline', 'true')
      var tryPlay = function () {
        var p = v.play()
        if (p && p.catch) p.catch(function () {})
      }
      v.onloadedmetadata = tryPlay
      tryPlay()
      scan.timer = setTimeout(tick, 300)
    })
    .catch(function (e) {
      stopScan()
      showManual('Não foi possível abrir a câmera (' + (e && e.name ? e.name : 'erro') + '). Insira manualmente.')
    })
}

function tick() {
  var v = $('video')
  if (!scan.stream) return
  if (v.readyState >= 2 && v.videoWidth) {
    // Draw the current frame to the visible canvas (the feed the user sees) and
    // decode straight from it — no on-screen <video>, so taps reach the controls.
    var c = $('scan-view')
    var ctx = c.getContext('2d', { willReadFrequently: true })
    if (c.width !== v.videoWidth) c.width = v.videoWidth
    if (c.height !== v.videoHeight) c.height = v.videoHeight
    ctx.drawImage(v, 0, 0, c.width, c.height)
    var img = ctx.getImageData(0, 0, c.width, c.height)
    var code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })
    if (code && code.data) {
      var cfg = parseConfig(code.data, '')
      if (cfg.base && cfg.token) {
        stopScan()
        applyConfig(cfg)
        return
      }
    }
  }
  // Throttled (~8fps): decoding every animation frame saturates the main thread
  // and the UI stops responding to taps (e.g. Cancelar). This is plenty for QR.
  scan.timer = setTimeout(tick, 120)
}

function stopScan() {
  if (scan.timer) { clearTimeout(scan.timer); scan.timer = 0 }
  if (scan.stream) {
    scan.stream.getTracks().forEach(function (t) { t.stop() })
    scan.stream = null
  }
  var v = $('video')
  if (v) v.srcObject = null
  $('scanner').hidden = true
}

// ---- keep-alive (wake lock + reconnect on resume) -------------------------

function requestWakeLock() {
  if (!('wakeLock' in navigator) || state.wakeLock) return
  navigator.wakeLock.request('screen').then(function (lock) {
    state.wakeLock = lock
    lock.addEventListener('release', function () { state.wakeLock = null })
  }).catch(function () { /* denied / unsupported */ })
}

function releaseWakeLock() {
  if (state.wakeLock) {
    try { state.wakeLock.release() } catch (e) {}
    state.wakeLock = null
  }
}

// When the app returns to the foreground, re-acquire the wake lock and make sure
// the live stream is up (Android may have torn it down while backgrounded).
function onResume() {
  if (document.visibilityState !== 'visible') return
  if ($('chat').hidden) return
  requestWakeLock()
  if (!state.es && !state.reconnect) { openEvents(); fetchState().catch(function () {}) }
}

// ---- boot -----------------------------------------------------------------

function init() {
  var cfg = loadConfig()
  if (cfg) {
    $('addr').value = cfg.base || ''
    $('token').value = cfg.token || ''
  }

  $('scan').addEventListener('click', startScan)
  $('scan-cancel').addEventListener('click', stopScan)
  // Tap anywhere on the scanner overlay also cancels (robust + intuitive).
  $('scanner').addEventListener('click', function (e) {
    if (e.target.id !== 'scan-cancel') stopScan()
  })
  $('toggle-manual').addEventListener('click', function () { showManual() })

  $('connect').addEventListener('click', function () {
    var cfg2 = parseConfig($('addr').value, $('token').value)
    if (!cfg2.base || !cfg2.token) {
      showPair('Informe o endereço (ex: 192.168.0.10:8765) e o token.')
      showManual()
      return
    }
    applyConfig(cfg2)
  })

  // Open the conversation history (drawer) from the menu button or the title.
  $('menu').addEventListener('click', openDrawer)
  $('conv-title').addEventListener('click', openDrawer)
  // The online indicator reveals the connection menu; "Sair" asks to confirm.
  $('status').addEventListener('click', toggleStatusMenu)
  $('scrim').addEventListener('click', closeMenus)
  $('exit').addEventListener('click', function () {
    closeMenus()
    if (confirm('Sair desta conexão? Você precisará parear de novo (QR ou endereço) para voltar.')) {
      showPair()
    }
  })
  $('send').addEventListener('click', send)
  $('input').addEventListener('input', autoGrow)
  $('input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  })

  // Image attachments: pick from gallery/camera, paste, or drag-drop.
  $('attach').addEventListener('click', function () { $('file').click() })
  $('file').addEventListener('change', function (e) {
    if (e.target.files) addFiles(e.target.files)
    e.target.value = ''
  })
  $('input').addEventListener('paste', function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || []
    var files = []
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && items[i].type.indexOf('image/') === 0) {
        var f = items[i].getAsFile()
        if (f) files.push(f)
      }
    }
    if (files.length) { e.preventDefault(); addFiles(files) }
  })

  // Stay connected: re-check the stream and re-acquire the wake lock on resume.
  document.addEventListener('visibilitychange', onResume)
  window.addEventListener('focus', onResume)
  window.addEventListener('online', onResume)

  // Auto-connect if we already have a saved config.
  if (cfg && cfg.base && cfg.token) {
    state.base = cfg.base
    state.token = cfg.token
    showChat()
  }
}

document.addEventListener('DOMContentLoaded', init)
