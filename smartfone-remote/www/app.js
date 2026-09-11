/*
 * Agent Remote — phone client for the desktop "agent-code" app.
 *
 * Talks to the PC LAN bridge (src/main/remote/remoteServer.ts):
 *   GET  /api/state            list conversations
 *   GET  /api/history?conv=ID  full message history of a conversation
 *   GET  /api/events  (SSE)    live agent events {convId, event}
 *   POST /api/send             send a command into a conversation
 *
 * It mirrors the desktop chat (history + what's being built), including answering
 * pending permission/AskUserQuestion requests via POST /api/permission-respond.
 */
'use strict'

var CONFIG_KEY = 'agent-remote-config'
var LAST_CONV_KEY = 'agent-remote-last-conv'
var DEVICE_KEY = 'agent-remote-device'
/** Timeout das chamadas HTTP normais: um endereço de LAN morto (celular saiu da
 *  rede) não pode segurar a tela por minutos até o TCP desistir. */
var FETCH_TIMEOUT_MS = 12000

var state = {
  usage: {},         // account usage windows (Claude/GPT), mirrored from the PC
  pairedDevice: null, // phone paired on the PC (id/name) — is it us?
  blocked: false,    // another phone is paired with this PC (409)
  files: [],         // staged non-image attachments {name, mediaType, data, size}
  failures: 0,       // consecutive /api/state failures (re-pick LAN vs VPS after 2)
  recoveryTimer: null,
  stallTimer: null,
  todoOpen: true,
  convMenu: null,    // conversation id with the row menu open (drawer)
  base: '',          // currently active endpoint — may be publicBase or lanBase
  publicBase: '',    // VPS/public origin from pairing (fixed, the "resting" fallback)
  lanBase: '',       // raw 'ip:port' of the PC on the LAN from the paired QR, if any
  token: '',
  conversations: [],
  convId: null,
  messages: [],
  es: null,
  poll: null,
  images: [],        // staged image attachments {mediaType, data}
  reconnect: null,   // pending SSE reconnect timer
  pairingRetry: null, // pending initial-pairing reconnect timer
  pairingAttempt: 0,  // backoff step while the initial connection is unavailable
  retry: 0,          // backoff step
  wakeLock: null,    // screen wake lock (keeps the app awake/connected)
  online: false,
  openTools: {},     // tool-use ids the user expanded (persist across re-renders)
  voiceReady: false, // PC has an OpenAI key → show mic/listen buttons
  recording: false,  // mic is capturing right now
  speakingId: null,  // id of the assistant message being read aloud (or null)
  audio: null,       // <Audio> currently playing the TTS
  scrollToMsg: null, // message id to scroll to after a search-result navigation
  skipPerms: false,  // global "Permitir tudo" state (mirrored from the PC)
  models: [],        // model catalog from the PC ({id,label}[])
  modelEffort: {},   // effort levels supported per model id
  effortLabels: {},  // pt-BR label per effort level
  historyLoading: false, // true enquanto /api/history está em voo (abrindo um chat)
  questionOpen: null,
  permReqId: null,       // id of the permission/question request currently rendered
  permCountdownTimer: null
}

// Conta as chamadas de loadHistory: só a resposta da chamada MAIS RECENTE pode
// atualizar a tela — evita que trocar de chat rápido deixe o spinner "grudado"
// (ou pior, uma resposta antiga sobrescrevendo o chat que o usuário abriu depois).
var historyReq = 0

var $ = function (id) { return document.getElementById(id) }

// ---- config / pairing -----------------------------------------------------

function parseConfig(addr, token) {
  addr = (addr || '').trim()
  token = (token || '').trim()
  var base = ''
  var lan = ''
  if (/^https?:\/\//i.test(addr)) {
    try {
      var u = new URL(addr)
      base = u.protocol + '//' + u.host
      if (!token && u.searchParams.get('token')) token = u.searchParams.get('token')
      // The QR's public URL carries the PC's LAN address too (?lan=ip:port) so a
      // phone on the same Wi‑Fi can skip the VPS relay — see pickBestBase().
      lan = u.searchParams.get('lan') || ''
    } catch (e) { /* invalid url */ }
  } else if (addr) {
    base = 'http://' + addr.replace(/\/+$/, '')
  }
  return { base: base, token: token, lan: lan }
}

/** Quick reachability probe with a hard timeout (no AbortSignal.timeout — keep
 *  this portable across older Android WebViews). Resolves true/false, never rejects. */
function probeReachable(url, timeoutMs) {
  return new Promise(function (resolve) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    var done = false
    var timer = setTimeout(function () {
      if (done) return
      done = true
      if (ctrl) ctrl.abort()
      resolve(false)
    }, timeoutMs)
    fetch(url, { signal: ctrl ? ctrl.signal : undefined }).then(function (res) {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(res.ok)
    }).catch(function () {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(false)
    })
  })
}

/** Prefer the PC's LAN address over the public/VPS one when both are known and
 *  the LAN one actually answers right now (same Wi‑Fi) — avoids routing every
 *  request (including file downloads) through the VPS relay unnecessarily.
 *  Resolves to `publicBase` on any failure/timeout, or if there's no LAN
 *  address on record. Never rejects. */
function pickBestBase(publicBase, lan, token) {
  if (!lan) return Promise.resolve(publicBase)
  var lanBase = 'http://' + lan.replace(/\/+$/, '')
  if (lanBase === publicBase) return Promise.resolve(publicBase)
  return probeReachable(lanBase + '/api/state?token=' + encodeURIComponent(token), 1200)
    .then(function (ok) { return ok ? lanBase : publicBase })
}

function loadConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null') } catch (e) { return null }
}
function saveConfig(cfg) { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)) }
function clearConfig() { localStorage.removeItem(CONFIG_KEY) }

/** Identidade estável deste celular (1 celular por PC — o PC compara este id). */
function deviceId() {
  var id = localStorage.getItem(DEVICE_KEY)
  if (!id) {
    id = 'ph-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
    localStorage.setItem(DEVICE_KEY, id)
  }
  return id
}
function deviceName() {
  var ua = navigator.userAgent || ''
  var m = /Android [\d.]+; ([^;)]+)/.exec(ua)
  if (m && m[1] && !/^[a-z]{2}-[a-z]{2}$/i.test(m[1].trim())) return m[1].trim().slice(0, 40)
  if (/iPhone/.test(ua)) return 'iPhone'
  return 'celular'
}

function api(path) {
  var sep = path.indexOf('?') >= 0 ? '&' : '?'
  return state.base + path + sep + 'token=' + encodeURIComponent(state.token) +
    '&dev=' + encodeURIComponent(deviceId()) + '&devname=' + encodeURIComponent(deviceName())
}

/** `fetch` com timeout duro. Rejeita com Error cuja `.status` é o HTTP (se houve
 *  resposta) ou 0 (rede/timeout) — quem chama decide a mensagem pelo status. */
function fetchApi(path, opts) {
  opts = opts || {}
  var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  var timer = setTimeout(function () { if (ctrl) ctrl.abort() }, opts.timeout || FETCH_TIMEOUT_MS)
  var init = { method: opts.method || 'GET', signal: ctrl ? ctrl.signal : undefined }
  if (opts.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(opts.body)
  }
  return fetch(api(path), init).then(function (res) {
    clearTimeout(timer)
    if (res.status === 409) { onAnotherDevice(res); throw httpError(409) }
    if (!res.ok) throw httpError(res.status)
    return res.json()
  }, function (err) {
    clearTimeout(timer)
    throw httpError(0, err)
  })
}
function httpError(status, cause) {
  var e = new Error(status ? 'HTTP ' + status : 'network')
  e.status = status
  e.cause = cause
  return e
}
/** Texto humano para o que deu errado — 503/504 vêm do broker (o PC não está lá),
 *  401 do PC (token), 0 é a rede do celular. */
function errorText(err) {
  var s = err && err.status
  if (s === 401) return 'O PC não aceitou o token salvo. Escaneie o QR de novo se a ponte foi reconfigurada.'
  if (s === 409) return 'Outro celular está pareado com este PC.'
  if (s === 503) return 'O PC não está conectado ao servidor remoto (ponte desligada, PC desligado ou sem internet).'
  if (s === 504 || s === 502) return 'O PC não respondeu a tempo. Ele pode ter acabado de dormir ou perder a rede.'
  if (s === 413) return 'Anexo grande demais para enviar pelo celular.'
  if (s) return 'Erro HTTP ' + s + ' ao falar com o PC.'
  return 'Sem conexão. Verifique a internet do celular.'
}

// ---- message reducer (mirrors renderer reduceMessages) --------------------

// Eventos que são ESTADO, não conteúdo: uso da conta e "o turno emudeceu".
// Sem isto eles caem no push do fim e engordam a lista a cada ocorrência —
// invisíveis (a renderização é whitelist), mas acumulando mesmo assim.
var STATE_ONLY = { 'rate-limit': 1, 'stall-status': 1, 'task-list': 1, 'background-tasks': 1 }
// Chamadas que o PC desvia do feed: o plano de tarefas vira o card fixo
// (renderTodoPlan), não uma ferramenta na lista.
var PLAN_TOOLS = { TodoWrite: 1, TaskCreate: 1, TaskUpdate: 1 }

/** Trabalho de subagente nunca entra no feed — no PC ele vai pro painel de
 *  agentes; aqui só poluiria a conversa principal. */
function isSubagentEvent(e) {
  return (e.kind === 'tool-use' || e.kind === 'tool-result') && e.parentToolUseId != null
}
function isHiddenMessage(m) {
  if (!m) return true
  if (STATE_ONLY[m.kind]) return true
  if (isSubagentEvent(m)) return true
  if (m.kind === 'tool-use' && PLAN_TOOLS[m.name]) return true
  return false
}

function reduce(list, e) {
  if (STATE_ONLY[e.kind] || isSubagentEvent(e)) return list
  if (e.kind === 'tool-use' && PLAN_TOOLS[e.name]) return list
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

// Modern line-icon set (stroke = currentColor), matching the desktop app. The
// strings are trusted constants, so building them via innerHTML is safe — text
// that comes from the agent (filenames, etc.) is always appended as a textNode.
var ICONS = {
  download: '<path d="M12 4v10"/><polyline points="7 11 12 16 17 11"/><line x1="5" y1="20" x2="19" y2="20"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>',
  speaker: '<path d="M4 9v6h3.5L13 19V5L7.5 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8 8 0 0 1 0 12"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>'
}
function icon(name, size) {
  var s = size || 16
  var span = document.createElement('span')
  span.className = 'ico'
  span.innerHTML =
    '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s +
    '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    ICONS[name] + '</svg>'
  return span.firstChild
}

function summarizeInput(input) {
  try {
    var s = typeof input === 'string' ? input : JSON.stringify(input)
    return s.length > 220 ? s.slice(0, 220) + '…' : s
  } catch (e) { return '' }
}

// ---- markdown (mirrors the PC's react-markdown + GFM, kept dependency-free) --
// Safe by construction: all user text is HTML-escaped before any tag we emit, and
// link hrefs are restricted to http(s). Covers headings, bold/italic, inline and
// fenced code, lists, blockquotes, links, autolinks and rules.

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function mdInline(text) {
  // Protect inline code spans from the other transforms.
  var codes = []
  text = String(text).replace(/`([^`]+)`/g, function (_, c) {
    codes.push(c); return '~C~' + (codes.length - 1) + '~C~'
  })
  text = escapeHtml(text)
  // [label](url) — only http(s) links become anchors; otherwise just the label.
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, label, url) {
    return /^https?:\/\//i.test(url)
      ? '<a href="' + url.replace(/"/g, '&quot;') + '" target="_blank" rel="noreferrer">' + label + '</a>'
      : label
  })
  // Bare URLs.
  text = text.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, function (_, pre, url) {
    return pre + '<a href="' + url.replace(/"/g, '&quot;') + '" target="_blank" rel="noreferrer">' + url + '</a>'
  })
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>')
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>').replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>')
  return text.replace(/~C~(\d+)~C~/g, function (_, i) { return '<code>' + escapeHtml(codes[+i]) + '</code>' })
}

function mdToHtml(src) {
  src = String(src == null ? '' : src).replace(/\r\n/g, '\n')
  // Pull fenced code blocks out first so their contents are never reformatted.
  var blocks = []
  src = src.replace(/```[ \t]*[\w-]*\n?([\s\S]*?)```/g, function (_, code) {
    blocks.push('<pre class="md-code"><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre>')
    return '~B~' + (blocks.length - 1) + '~B~'
  })
  var lines = src.split('\n')
  var html = ''
  var para = []
  var i = 0
  function flushPara() {
    if (para.length) { html += '<p>' + mdInline(para.join('\n')).replace(/\n/g, '<br>') + '</p>'; para = [] }
  }
  while (i < lines.length) {
    var line = lines[i]
    var fence = line.match(/^~B~(\d+)~B~$/)
    if (fence) { flushPara(); html += blocks[+fence[1]]; i++; continue }
    if (/^\s*$/.test(line)) { flushPara(); i++; continue }
    var h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) { flushPara(); html += '<h' + h[1].length + '>' + mdInline(h[2]) + '</h' + h[1].length + '>'; i++; continue }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); html += '<hr>'; i++; continue }
    if (/^>\s?/.test(line)) {
      flushPara()
      var q = []
      while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++ }
      html += '<blockquote>' + mdInline(q.join('\n')).replace(/\n/g, '<br>') + '</blockquote>'
      continue
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara()
      var ul = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { ul.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++ }
      html += '<ul>' + ul.map(function (it) { return '<li>' + mdInline(it) + '</li>' }).join('') + '</ul>'
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara()
      var ol = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { ol.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++ }
      html += '<ol>' + ol.map(function (it) { return '<li>' + mdInline(it) + '</li>' }).join('') + '</ol>'
      continue
    }
    para.push(line); i++
  }
  flushPara()
  // Restore any code blocks that ended up inline within a paragraph.
  return html.replace(/~B~(\d+)~B~/g, function (_, n) { return blocks[+n] })
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

// Pull `[[download:PATH]]` markers out of assistant text → {clean, paths}. The
// agent emits these so a "Baixar" button shows up in the chat (e.g. a built APK).
function parseDownloads(text) {
  var paths = []
  var clean = String(text || '').replace(/\[\[download:\s*([^\]\n]+?)\s*\]\]/g, function (_, p) {
    var path = p.trim()
    if (path) paths.push(path)
    return ''
  }).replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '')
  return { clean: clean, paths: paths }
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
    case 'AskUserQuestion': {
      var qs = Array.isArray(inp.questions) ? inp.questions : []
      var first = qs[0] || {}
      return { verb: 'Pergunta', detail: typeof first.header === 'string' ? first.header : '', isSkill: false, stats: null }
    }
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
  // AskUserQuestion devolve a resposta como 'deny' (is_error=true), mas isso NAO
  // e falha — tratar como respondido, sem pintar de vermelho.
  var isQuestion = m.name === 'AskUserQuestion'
  var noAnswer = isQuestion && m.result && /não respondeu|tempo|esgotado/i.test(m.result.text || '')

  var card = el('tool-card' + (info.isSkill ? ' tool-skill' : '') + ((m.result && m.result.isError && !isQuestion) ? ' tool-error' : ''))

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
    dl.appendChild(icon('download', 15))
    dl.appendChild(document.createTextNode(' Baixar'))
    dl.addEventListener('click', function (e) { e.stopPropagation(); triggerDownload(fp) })
    head.appendChild(dl)
  }
  var badge = m.result
    ? (isQuestion
        ? el('tool-badge ok', noAnswer ? 'sem resposta' : 'respondido')
        : el('tool-badge ' + (m.result.isError ? 'err' : 'ok'), m.result.isError ? 'error' : 'done'))
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

// Coalesce bursts of streaming events into one render per animation frame, so a
// fast token stream doesn't rebuild the list dozens of times per second.
var renderQueued = false
function scheduleRender() {
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(function () { renderQueued = false; renderMessages() })
}

function renderMessages() {
  var box = $('messages')
  // Abrindo um chat (loadHistory em voo): mostra o loading no lugar da lista —
  // nem tenta desenhar mensagens de um chat que ainda pode nem ser o certo.
  if (state.historyLoading) {
    box.innerHTML = '<div class="messages-loading"><span class="spinner"></span><span>Carregando mensagens…</span></div>'
    updateJumpBtn()
    return
  }
  // Remember position BEFORE clearing: clearing resets scrollTop to 0, which would
  // otherwise yank the view to the top on every streaming event.
  var prevTop = box.scrollTop
  var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80
  box.innerHTML = ''
  var scrollTarget = null
  state.messages.forEach(function (m) {
    if (isHiddenMessage(m)) return
    if (m.kind === 'user') {
      var wrap = el('msg-row user')
      var u = el('msg user')
      if (m.id) u.setAttribute('data-mid', m.id)
      if (state.scrollToMsg && m.id === state.scrollToMsg) scrollTarget = u
      if (m.images && m.images.length) {
        var gal = el('msg-imgs')
        m.images.forEach(function (src) {
          var im = document.createElement('img')
          im.src = src
          gal.appendChild(im)
        })
        u.appendChild(gal)
      }
      if (m.files && m.files.length) {
        var fl = el('msg-files')
        m.files.forEach(function (f) { fl.appendChild(el('file-chip', '📎 ' + (f.name || 'arquivo') + (f.size ? ' · ' + fmtBytes(f.size) : ''))) })
        u.appendChild(fl)
      }
      if (m.text) u.appendChild(document.createTextNode(m.text))
      wrap.appendChild(u)
      if (m.queued) wrap.appendChild(el('msg-queued', 'Na fila'))
      // Note when this message was manually canceled.
      if (m.canceled) wrap.appendChild(el('msg-canceled', '⊘ Mensagem cancelada'))
      // Sent date/time, small, under my own message.
      if (m.ts) wrap.appendChild(el('msg-time', fmtMsgTime(m.ts)))
      box.appendChild(wrap)
    } else if (m.kind === 'assistant-text') {
      var a = el('msg assistant')
      var parsed = parseDownloads(m.text)
      if (parsed.clean) {
        var md = el('md')
        md.innerHTML = mdToHtml(parsed.clean)
        a.appendChild(md)
      }
      parsed.paths.forEach(function (path) {
        var dl = document.createElement('button')
        dl.className = 'msg-dl'
        dl.appendChild(icon('download', 15))
        dl.appendChild(document.createTextNode(' Baixar ' + basename(path)))
        dl.addEventListener('click', function () { triggerDownload(path) })
        a.appendChild(dl)
      })
      // "Ouvir" — only on the final answer, and only when the PC can synthesize
      // (has an OpenAI key). Reading aloud is processed on the PC.
      if (m.answer && state.voiceReady && parsed.clean) {
        var speaking = state.speakingId === m.id
        var sp = document.createElement('button')
        sp.className = 'msg-speak' + (speaking ? ' active' : '')
        sp.appendChild(icon(speaking ? 'stop' : 'speaker', 15))
        sp.appendChild(document.createTextNode(speaking ? ' Parar' : ' Ouvir'))
        ;(function (id, txt) {
          sp.addEventListener('click', function () { toggleSpeak(id, txt) })
        })(m.id, parsed.clean)
        a.appendChild(sp)
      }
      box.appendChild(a)
    } else if (m.kind === 'thinking') {
      // Recolhido por padrão (como no PC): o raciocínio é longo e raramente é o
      // que se quer ler no celular — toque para abrir.
      var th = el('msg thinking' + (state.openTools[m.id] ? ' open' : ''))
      var thHead = el('thinking-head', state.openTools[m.id] ? '▾ Pensando…' : '▸ Pensando…')
      var thBody = el('thinking-body', m.text)
      thBody.hidden = !state.openTools[m.id]
      thHead.addEventListener('click', function () {
        if (state.openTools[m.id]) delete state.openTools[m.id]
        else state.openTools[m.id] = true
        renderMessages()
      })
      th.appendChild(thHead)
      th.appendChild(thBody)
      box.appendChild(th)
    } else if (m.kind === 'system') {
      box.appendChild(el('msg system', 'sessão pronta' + (m.model ? ' · ' + m.model : '')))
    } else if (m.kind === 'error') {
      box.appendChild(el('msg error', m.text))
    } else if (m.kind === 'status' || m.kind === 'provider-switch') {
      box.appendChild(el('msg system', m.text))
    } else if (m.kind === 'tool-use') {
      box.appendChild(renderTool(m))
    }
  })
  // Pinned to the bottom → follow new content; otherwise keep the user exactly
  // where they were reading (content above the growing message is stable).
  box.scrollTop = nearBottom ? box.scrollHeight : prevTop
  // Coming from a search hit: center the found prompt and flash it once.
  if (scrollTarget) {
    scrollTarget.scrollIntoView({ block: 'center' })
    scrollTarget.classList.add('msg-highlight')
    setTimeout(function () { scrollTarget.classList.remove('msg-highlight') }, 2200)
    state.scrollToMsg = null
  }
  updateJumpBtn()
  renderQuestionMap()
}

function questionPreview(text) {
  var clean = (text || '').trim().replace(/\s+/g, ' ')
  return clean.length > 130 ? clean.slice(0, 130) + '...' : (clean || '(imagem/anexo)')
}

function renderQuestionMap() {
  var map = $('question-map')
  if (!map) return
  var cur = current()
  var questions = (cur && cur.questions) || []
  map.innerHTML = ''
  map.hidden = !questions.length
  if (!questions.length) return
  var max = Math.max(1, questions.reduce(function (n, q) { return Math.max(n, q.position || 0) }, 0))
  questions.forEach(function (q) {
    var wrap = el('question-point-wrap')
    wrap.style.top = ((q.position || 0) / max * 100) + '%'
    var point = document.createElement('button')
    point.className = 'question-point' + (q.queued ? ' queued' : '')
    point.setAttribute('aria-label', questionPreview(q.text))
    point.addEventListener('click', function (e) {
      e.stopPropagation()
      state.questionOpen = state.questionOpen === q.id ? null : q.id
      renderQuestionMap()
    })
    wrap.appendChild(point)
    if (state.questionOpen === q.id) {
      var card = document.createElement('button')
      card.className = 'question-card'
      card.appendChild(el('question-card-text', questionPreview(q.text)))
      card.appendChild(el('question-card-meta', q.queued ? 'Na fila' : (q.ts ? fmtMsgTime(q.ts) : 'Ir para a pergunta')))
      card.addEventListener('click', function (e) { e.stopPropagation(); goToQuestion(q) })
      wrap.appendChild(card)
    }
    map.appendChild(wrap)
  })
}

function goToQuestion(q) {
  state.questionOpen = null
  var queued = q.queued && state.messages.find(function (m) { return m.kind === 'user' && m.queued && m.text === q.text })
  state.scrollToMsg = queued ? queued.id : q.id
  var loaded = state.messages.some(function (m) { return m.id === state.scrollToMsg })
  if (loaded) { renderMessages(); return }
  fetch(api('/api/history-window?conv=' + encodeURIComponent(state.convId) + '&message=' + encodeURIComponent(q.id)))
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
    .then(function (data) { state.messages = (data.messages || []).slice(); renderMessages() })
    .catch(function () { state.scrollToMsg = null; renderQuestionMap() })
}

// Compact "data e horário" for a sent message: "Hoje às 14:32" or "30/06/2026 às 14:32".
function fmtMsgTime(ts) {
  var d = new Date(ts)
  var time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  var n = new Date()
  var sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  return sameDay ? ('Hoje às ' + time) : (d.toLocaleDateString('pt-BR') + ' às ' + time)
}

// Floating "scroll to bottom": visible only when the user scrolled up from the end.
function updateJumpBtn() {
  var box = $('messages')
  var btn = $('jump-bottom')
  if (!box || !btn) return
  var far = box.scrollHeight - box.scrollTop - box.clientHeight > 220
  btn.hidden = !far
}
function scrollMessagesToBottom() {
  var box = $('messages')
  box.scrollTop = box.scrollHeight
  updateJumpBtn()
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
  return fetchApi('/api/state')
    .then(function (data) {
      state.failures = 0
      state.conversations = data.conversations || []
      state.projects = data.projects || []
      state.usage = data.usage || {}
      state.pairedDevice = data.pairedDevice || null
      var wasReady = state.voiceReady
      state.voiceReady = !!data.voiceReady
      var mic = $('mic')
      if (mic) mic.hidden = !state.voiceReady
      // Mirror the PC's "Permitir tudo" state; keep the settings toggle in sync.
      state.skipPerms = !!data.skipPerms
      syncSkipToggle()
      // Model/effort catalog + current values (for the selectors above the input).
      state.models = data.models || []
      state.modelEffort = data.modelEffort || {}
      state.effortLabels = data.effortLabels || {}
      renderModelBar()
      // Don't clobber active search results when the conversation list refreshes.
      var sb = $('hist-search-input')
      if (!$('history').hidden && !(sb && sb.value.trim())) renderHistory()
      updateConvTitle()
      renderBusy()
      syncQueuedMessages()
      renderTurnRecovery()
      renderTodoPlan()
      renderUsage()
      renderQuestionMap()
      renderPermission()
      // If voice availability flipped, refresh so the "Ouvir" buttons appear/hide.
      if (wasReady !== state.voiceReady) scheduleRender()
      return data
    }, function (err) {
      // Duas falhas seguidas no chat: o endereço em uso pode ter morrido (saímos da
      // Wi‑Fi do PC) — reavalia LAN × VPS antes da próxima tentativa.
      state.failures++
      if (state.failures >= 2 && !$('chat').hidden) repickBase()
      throw err
    })
}

var repicking = false
/** Reescolhe entre a LAN e a VPS. Nunca rejeita; troca `state.base` se mudou e
 *  religa o SSE nele. É o que faz sair da rede do PC funcionar sem reabrir o app. */
function repickBase() {
  if (repicking || !state.publicBase) return Promise.resolve(state.base)
  repicking = true
  return pickBestBase(state.publicBase, state.lanBase, state.token).then(function (base) {
    repicking = false
    if (base !== state.base) {
      state.base = base
      state.failures = 0
      if (!$('chat').hidden) openEvents()
    }
    return base
  })
}

/** Faixa "trabalhando…" + botão Parar; vira "sem resposta há Xs" quando o PC
 *  diz que o turno emudeceu (stall watchdog) — mesma leitura do desktop. */
function renderBusy() {
  var cur = current()
  var bar = $('busy')
  var busy = !!(cur && cur.busy)
  bar.hidden = !busy
  if (state.stallTimer) { clearInterval(state.stallTimer); state.stallTimer = null }
  var text = $('busy-text')
  if (!busy) return
  var since = cur.stalledSince
  bar.classList.toggle('stalled', !!since)
  if (!since) { text.textContent = 'trabalhando…'; return }
  var tick = function () {
    var s = Math.max(0, Math.round((Date.now() - since) / 1000))
    text.textContent = 'Sem resposta há ' + (s >= 60 ? Math.floor(s / 60) + 'min ' + (s % 60) + 's' : s + 's')
  }
  tick()
  state.stallTimer = setInterval(tick, 1000)
}

function interruptTurn() {
  if (!state.convId) return
  fetchApi('/api/interrupt', { method: 'POST', body: { convId: state.convId } })
    .then(fetchState).catch(function () {})
}

// ---- task plan card (TodoWrite / TaskCreate), fixed above the composer -------

function renderTodoPlan() {
  var box = $('todo-plan')
  var cur = current()
  var plan = cur && cur.todoPlan
  if (!plan || !plan.items || !plan.items.length) { box.hidden = true; return }
  box.hidden = false
  box.innerHTML = ''
  var done = plan.items.filter(function (t) { return t.status === 'completed' }).length
  var head = el('todo-head')
  var running = plan.items.find(function (t) { return t.status === 'in_progress' })
  head.appendChild(el('todo-title', (plan.active ? '◔ ' : '✓ ') + done + '/' + plan.items.length + (running && !state.todoOpen ? ' · ' + (running.activeForm || running.content) : ' etapas')))
  head.appendChild(el('todo-caret', state.todoOpen ? '▾' : '▸'))
  head.addEventListener('click', function () { state.todoOpen = !state.todoOpen; renderTodoPlan() })
  box.appendChild(head)
  if (!state.todoOpen) return
  var list = el('todo-list')
  plan.items.forEach(function (t) {
    var row = el('todo-item ' + t.status)
    row.appendChild(el('todo-mark', t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○'))
    row.appendChild(el('todo-text', t.status === 'in_progress' ? (t.activeForm || t.content) : t.content))
    list.appendChild(row)
  })
  box.appendChild(list)
}

// ---- account usage (5h / week) + context, in Settings --------------------------

var USAGE_LABELS = {
  five_hour: 'Claude · sessão 5h', seven_day: 'Claude · semana', seven_day_opus: 'Claude · semana Opus',
  seven_day_sonnet: 'Claude · semana Sonnet', seven_day_overage_included: 'Claude · excedente incluído',
  overage: 'Claude · excedente', gpt_primary: 'GPT · janela curta', gpt_secondary: 'GPT · janela longa'
}
function fmtReset(ts) {
  if (!ts) return ''
  var ms = ts * (ts < 1e12 ? 1000 : 1) - Date.now()
  if (ms <= 0) return 'já resetou'
  var m = Math.round(ms / 60000)
  if (m < 60) return 'reseta em ' + m + ' min'
  var h = Math.round(m / 60)
  if (h < 48) return 'reseta em ' + h + ' h'
  return 'reseta em ' + Math.round(h / 24) + ' dias'
}
function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1e3) return Math.round(n / 1e3) + 'k'
  return String(n || 0)
}
function renderUsage() {
  var box = $('cfg-usage')
  if (!box) return
  box.innerHTML = ''
  var keys = Object.keys(state.usage || {})
  var cur = current()
  if (cur && cur.tokens) {
    var t = cur.tokens
    var pct = t.contextLimit ? Math.min(100, Math.round(t.context / t.contextLimit * 100)) : 0
    box.appendChild(usageRow('Contexto desta conversa', pct, fmtTokens(t.context) + ' / ' + fmtTokens(t.contextLimit) + ' · ↑ ' + fmtTokens(t.output) + ' saída' + (t.cost ? ' · ~$' + t.cost.toFixed(2) : '')))
  }
  keys.forEach(function (k) {
    var u = state.usage[k]
    var pct = Math.round((u.utilization || 0) * 100)
    box.appendChild(usageRow(USAGE_LABELS[k] || k, pct, pct + '% usado' + (u.resetsAt ? ' · ' + fmtReset(u.resetsAt) : '')))
  })
  if (!box.children.length) box.appendChild(el('cfg-desc', 'Sem dados de uso ainda.'))
}
function usageRow(label, pct, detail) {
  var row = el('usage-row')
  row.appendChild(el('usage-label', label))
  var track = el('usage-track')
  var fill = el('usage-fill' + (pct >= 95 ? ' crit' : pct >= 80 ? ' warn' : ''))
  fill.style.width = pct + '%'
  track.appendChild(fill)
  row.appendChild(track)
  row.appendChild(el('usage-detail', detail))
  return row
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

// ---- model + effort selectors (above the input, mirroring the PC pickers) ---

function fillSelect(sel, options, value) {
  sel.innerHTML = ''
  options.forEach(function (o) {
    var opt = document.createElement('option')
    opt.value = o.value
    opt.textContent = o.label
    sel.appendChild(opt)
  })
  sel.value = value
}

function renderModelBar() {
  var bar = $('model-bar')
  var cur = current()
  if (!bar) return
  if (!cur || !state.models.length) { bar.hidden = true; return }
  bar.hidden = false
  var busy = !!cur.busy
  var mSel = $('model-select')
  // Don't rebuild while the user is inside a (native) dropdown — the periodic
  // /api/state refresh would close it mid-choice.
  if (document.activeElement === mSel || document.activeElement === $('effort-select')) return
  fillSelect(
    mSel,
    state.models.map(function (m) { return { value: m.id, label: m.label } }),
    cur.model || (state.models[0] && state.models[0].id) || ''
  )
  mSel.disabled = busy
  // Effort: only for models that support it (Ollama models don't → hide).
  var eSel = $('effort-select')
  var levels = state.modelEffort[cur.model] || []
  eSel.hidden = !levels.length
  if (levels.length) {
    fillSelect(
      eSel,
      levels.map(function (l) { return { value: l, label: state.effortLabels[l] || l } }),
      cur.effort || 'high'
    )
    eSel.disabled = busy
  }
  // Per-conversation modes (same three toggles as the desktop composer).
  var eco = $('mode-economy'), loop = $('mode-loop'), fast = $('mode-fast')
  eco.classList.toggle('on', !!cur.economyMode)
  loop.classList.toggle('on', !!cur.loopEnabled)
  fast.classList.toggle('on', !!cur.fastMode)
  fast.hidden = !cur.fastModeAvailable
}

/** Alterna econômico / loop / rápido da conversa atual (otimista; o PC confirma). */
function setMode(mode) {
  var cur = current()
  if (!cur) return
  var key = mode === 'economy' ? 'economyMode' : mode === 'loop' ? 'loopEnabled' : 'fastMode'
  var on = !cur[key]
  if (mode === 'loop' && on && cur.economyMode) { alert('Desative o modo econômico para ligar o loop.'); return }
  cur[key] = on
  if (on && mode === 'economy') cur.loopEnabled = false
  if (on && mode === 'loop') cur.economyMode = false
  renderModelBar()
  fetchApi('/api/set-mode', { method: 'POST', body: { convId: state.convId, mode: mode, on: on } })
    .then(function () { fetchState() }).catch(function () { fetchState().catch(function () {}) })
}

// Push a model/effort change to the PC. Optimistic on the local snapshot; the
// next /api/state (or its own echo) reconciles. Locked while the conv is busy.
function setModel(patch) {
  var cur = current()
  if (!cur || cur.busy) { renderModelBar(); return }
  if (patch.model) { cur.model = patch.model; delete cur.effort }
  if (patch.effort) cur.effort = patch.effort
  renderModelBar()
  fetch(api('/api/set-model'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ convId: state.convId, model: patch.model, effort: patch.effort })
  }).then(function () { fetchState() }).catch(function () { /* next poll reconciles */ })
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
  // Projects the PC knows but that have no loaded conversation still get a "+".
  ;(state.projects || []).forEach(function (p) { if (p && !groups[p]) { groups[p] = []; order.push(p) } })
  order.forEach(function (k) {
    var g = el('hist-group')
    var proj = el('hist-project')
    proj.appendChild(icon('folder', 14))
    proj.appendChild(document.createTextNode(' ' + basename(k)))
    var plus = document.createElement('button')
    plus.className = 'hist-plus'
    plus.title = 'Nova conversa neste projeto'
    plus.textContent = '+'
    plus.addEventListener('click', function (e) { e.stopPropagation(); createConversation(k) })
    proj.appendChild(plus)
    g.appendChild(proj)
    groups[k].forEach(function (c) {
      var row = el('hist-row' + (c.id === state.convId ? ' active' : ''))
      row.appendChild(el('hist-title', c.title || 'Conversa'))
      if (c.busy) { var hb = el('hist-busy'); hb.appendChild(icon('clock', 13)); row.appendChild(hb) }
      var more = document.createElement('button')
      more.className = 'hist-more'
      more.setAttribute('aria-label', 'Opções da conversa')
      more.textContent = '⋯'
      more.addEventListener('click', function (e) {
        e.stopPropagation()
        state.convMenu = state.convMenu === c.id ? null : c.id
        renderHistory()
      })
      row.appendChild(more)
      row.addEventListener('click', function () { selectConv(c.id); closeDrawer() })
      g.appendChild(row)
      if (state.convMenu === c.id) {
        var menu = el('hist-menu')
        var ren = document.createElement('button')
        ren.textContent = 'Renomear'
        ren.addEventListener('click', function () {
          var title = prompt('Novo nome da conversa', c.title || '')
          state.convMenu = null
          if (title && title.trim()) conversationAction({ type: 'rename', convId: c.id, title: title.trim() })
          else renderHistory()
        })
        var del = document.createElement('button')
        del.className = 'danger'
        del.textContent = 'Excluir'
        del.addEventListener('click', function () {
          state.convMenu = null
          if (confirm('Excluir a conversa "' + (c.title || 'Conversa') + '"? Isso apaga no PC também.')) {
            conversationAction({ type: 'delete', convId: c.id })
          } else renderHistory()
        })
        menu.appendChild(ren)
        menu.appendChild(del)
        g.appendChild(menu)
      }
    })
    list.appendChild(g)
  })
  updateConvTitle()
}

function conversationAction(body) {
  return fetchApi('/api/conversation', { method: 'POST', body: body }).then(function (r) {
    if (body.type === 'rename') { var c = state.conversations.find(function (x) { return x.id === body.convId }); if (c) c.title = body.title }
    if (body.type === 'delete') {
      state.conversations = state.conversations.filter(function (x) { return x.id !== body.convId })
      if (state.convId === body.convId) {
        var next = state.conversations[0]
        if (next) selectConv(next.id)
        else { state.convId = null; state.messages = []; renderMessages(); updateConvTitle() }
      }
    }
    renderHistory()
    // The PC applies it asynchronously; a refresh a moment later confirms.
    setTimeout(function () { fetchState().catch(function () {}) }, 600)
    return r
  }).catch(function (err) { alert(errorText(err)) })
}

function createConversation(cwd) {
  conversationAction({ type: 'create', cwd: cwd }).then(function (r) {
    if (!r || !r.convId) return
    // Optimistic row until the PC's snapshot arrives.
    state.conversations.unshift({ id: r.convId, title: 'Nova conversa', cwd: cwd, busy: false, connected: false, updatedAt: Date.now(), queued: [] })
    selectConv(r.convId)
    closeDrawer()
  })
}

// Search across the user's own prompts (server-side, every conversation).
var searchTimer = null
function onSearchInput() {
  var q = $('hist-search-input').value.trim()
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null }
  if (!q) { renderHistory(); return }
  searchTimer = setTimeout(function () { runSearch(q) }, 220)
}
function runSearch(q) {
  fetch(api('/api/search?q=' + encodeURIComponent(q)))
    .then(function (r) { return r.json() })
    .then(function (data) {
      // Drop a stale response if the box changed while it was in flight.
      if ($('hist-search-input').value.trim() !== q) return
      renderSearchResults(data.results || [], q)
    })
    .catch(function () { /* keep the current list on a network blip */ })
}
function renderSearchResults(results, q) {
  var list = $('history-list')
  list.innerHTML = ''
  if (!results.length) {
    list.appendChild(el('hist-empty', 'Nenhum prompt encontrado para “' + q + '”.'))
    return
  }
  results.forEach(function (c) {
    var row = el('hist-row hist-result' + (c.id === state.convId ? ' active' : ''))
    row.appendChild(el('hist-title', c.title || 'Conversa'))
    if (c.snippet) row.appendChild(el('hist-snippet', c.snippet))
    row.addEventListener('click', function () {
      // Land on the exact prompt that matched (when the hit was a message, not
      // just the title); loadHistory's render scrolls to it.
      state.scrollToMsg = c.messageId || null
      selectConv(c.id)
      closeDrawer()
    })
    list.appendChild(row)
  })
}

// ---- drawer / connection menu --------------------------------------------

function openDrawer() {
  var box = $('hist-search-input')
  if (box) box.value = '' // start each open with a clean search
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

// ---- settings -------------------------------------------------------------

function openSettings() {
  closeMenus()
  $('cfg-addr').textContent = state.base ? state.base.replace(/^https?:\/\//, '') : '—'
  $('cfg-token').textContent = state.token || '—'
  syncSkipToggle()
  renderUsage()
  $('settings').hidden = false
}
function closeSettings() {
  $('settings').hidden = true
}
// Reflect state.skipPerms on the toggle + its card (without firing onchange).
function syncSkipToggle() {
  var input = $('cfg-skip')
  if (input) input.checked = !!state.skipPerms
  var card = $('cfg-skip-card')
  if (card) card.classList.toggle('on', !!state.skipPerms)
}
// Push a new "Permitir tudo" value to the PC (optimistic; state echoes back).
function setSkipPerms(on) {
  state.skipPerms = on
  syncSkipToggle()
  fetch(api('/api/skip-perms'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: on })
  }).catch(function () { /* next /api/state poll will reconcile */ })
}
function confirmExit() {
  if (confirm('Sair desta conexão? Você precisará parear de novo (QR ou endereço) para voltar.')) {
    closeSettings()
    cancelPairingReconnect()
  }
}

// `silent`: true para um RESYNC de fundo (pull-to-refresh, reconexão) — essas
// ações já têm sua própria barra de progresso e devem manter as mensagens já
// carregadas visíveis, sem apagar a tela pro spinner cheio. `silent` false (o
// padrão) é para ABRIR um chat — aí sim mostra o loading, como pedido.
function loadHistory(convId, silent) {
  var reqId = ++historyReq
  if (!silent) {
    state.historyLoading = true
    renderMessages()
  }
  return fetch(api('/api/history?conv=' + encodeURIComponent(convId)))
    .then(function (r) { return r.json() })
    .then(function (data) {
      if (reqId !== historyReq) return // uma chamada mais nova já assumiu a tela
      state.messages = (data.messages || []).slice()
      state.historyLoading = false
      renderMessages()
    })
    .catch(function (err) {
      if (reqId === historyReq) {
        state.historyLoading = false
        renderMessages()
      }
      throw err // preserva o comportamento de erro pra quem chama loadHistory
    })
}

// ---- pull-to-refresh (topo do chat) ----------------------------------------
// Puxar a lista de mensagens para baixo, a partir do topo, recarrega a
// conversa inteira via /api/history — mesmo caminho usado ao reconectar.
var PULL_THRESHOLD = 64
var pull = { active: false, startY: 0, over: false, refreshing: false }

function setPullBar(mode) {
  var bar = $('pull-refresh')
  var text = $('pull-refresh-text')
  if (mode === 'hidden') { bar.hidden = true; return }
  bar.hidden = false
  text.textContent = mode === 'refreshing' ? 'Atualizando…' : mode === 'ready' ? 'Solte para atualizar' : 'Puxe para atualizar'
}

function onPullStart(e) {
  if (pull.refreshing) return
  var box = $('messages')
  if (box.scrollTop > 0) { pull.active = false; return }
  pull.active = true
  pull.over = false
  pull.startY = e.touches ? e.touches[0].clientY : e.clientY
}

function onPullMove(e) {
  if (!pull.active || pull.refreshing) return
  var box = $('messages')
  if (box.scrollTop > 0) { pull.active = false; setPullBar('hidden'); return }
  var y = e.touches ? e.touches[0].clientY : e.clientY
  var dy = y - pull.startY
  if (dy <= 0) { pull.over = false; setPullBar('hidden'); return }
  // Estamos puxando a partir do topo — trava o scroll nativo (bounce da página)
  // enquanto o gesto acontece, para não brigar com o "solte para atualizar".
  if (e.cancelable) e.preventDefault()
  pull.over = dy > PULL_THRESHOLD
  setPullBar(pull.over ? 'ready' : 'pulling')
}

function onPullEnd() {
  if (!pull.active || pull.refreshing) return
  pull.active = false
  if (!pull.over) { setPullBar('hidden'); return }
  pull.refreshing = true
  setPullBar('refreshing')
  var done = function () { pull.refreshing = false; setPullBar('hidden') }
  if (!state.convId) { done(); return }
  loadHistory(state.convId, true).then(done, done)
}

function setupPullToRefresh() {
  var box = $('messages')
  box.addEventListener('touchstart', onPullStart, { passive: true })
  box.addEventListener('touchmove', onPullMove, { passive: false })
  box.addEventListener('touchend', onPullEnd)
  box.addEventListener('touchcancel', onPullEnd)
  // Mouse fallback (útil para testar no navegador embutido, fora do celular).
  box.addEventListener('mousedown', onPullStart)
  box.addEventListener('mousemove', function (e) { if (pull.active) onPullMove(e) })
  box.addEventListener('mouseup', onPullEnd)
  box.addEventListener('mouseleave', function () { if (pull.active) onPullEnd() })
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
    // O SSE não diz POR QUE caiu. Antes de reabrir, reavalia o endereço (a LAN pode
    // ter sumido — saímos da Wi‑Fi do PC) e confere com uma chamada normal, que
    // devolve um status legível: 503 = PC fora do servidor, 401 = token, 409 = outro
    // celular. Só religa o stream quando o PC responde.
    var attempt = state.retry
    repickBase().then(function () { return fetchState() }).then(function () {
      openEvents()
    }, function (err) {
      if (err && err.status === 409) return // showBlocked já assumiu a tela
      var label = $('reconnect-text')
      if (label) label.textContent = 'reconectando… ' + errorText(err)
      if (attempt === state.retry) scheduleReconnect()
    })
  }, delay)
}

function clearPairingRetry() {
  if (state.pairingRetry) clearTimeout(state.pairingRetry)
  state.pairingRetry = null
}

function syncQueuedMessages() {
  var cur = current()
  if (!cur || cur.id !== state.convId) return
  var pending = (cur.queued || []).map(function (q) { return q.text })
  state.messages = state.messages.filter(function (m) {
    if (m.kind !== 'user' || !m.queued) return true
    var i = pending.indexOf(m.text)
    if (i < 0) return false
    pending.splice(i, 1)
    return true
  })
  pending.forEach(function (text, i) {
    state.messages.push({ kind: 'user', id: 'queued-' + Date.now() + '-' + i, text: text, queued: true })
  })
  scheduleRender()
}

function renderTurnRecovery() {
  var box = $('turn-recovery')
  var cur = current()
  var recovery = cur && cur.recovery
  if (state.recoveryTimer) { clearInterval(state.recoveryTimer); state.recoveryTimer = null }
  if (!recovery) { box.hidden = true; return }
  box.hidden = false
  $('turn-recovery-title').textContent = recovery.reason === 'limit' ? 'Limite do Claude atingido' : 'Resposta interrompida'
  if (recovery.scheduledAt <= 0) {
    $('turn-recovery-time').textContent = 'Tentativas automáticas encerradas (' + recovery.attempt + '/' + recovery.maxAttempts + ')'
    return
  }
  // Relógio local de 1 s — o snapshot do PC só chega a cada 4 s e a contagem
  // pulava de 4 em 4.
  var tick = function () {
    var seconds = Math.max(0, Math.ceil((recovery.scheduledAt - Date.now()) / 1000))
    var clock = new Date(recovery.scheduledAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    $('turn-recovery-time').textContent = 'Nova tentativa em ' + seconds + 's · ' + clock
  }
  tick()
  state.recoveryTimer = setInterval(tick, 1000)
}

// ---- pending permission / AskUserQuestion modal ---------------------------

var OTHER = '__other__'

function clearPermCountdown() {
  if (state.permCountdownTimer) { clearInterval(state.permCountdownTimer); state.permCountdownTimer = null }
}

function startPermCountdown(deadline) {
  clearPermCountdown()
  var box = $('perm-countdown')
  var bar = $('perm-countdown-bar')
  if (!deadline) { box.hidden = true; return }
  box.hidden = false
  var total = Math.max(1, deadline - Date.now())
  function tick() {
    var remaining = Math.max(0, deadline - Date.now())
    bar.style.transitionDuration = '0s'
    bar.style.transform = 'scaleX(' + (remaining / total) + ')'
    if (remaining <= 0) clearPermCountdown()
  }
  tick()
  state.permCountdownTimer = setInterval(tick, 250)
}

function permRespond(convId, id, behavior, always, answers) {
  clearPermCountdown()
  $('perm-modal').hidden = true
  state.permReqId = null
  fetch(api('/api/permission-respond'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ convId: convId, id: id, behavior: behavior, always: always, answers: answers })
  }).then(fetchState).catch(function () {})
}

function renderPermission() {
  var cur = current()
  var req = cur && cur.permission
  var modal = $('perm-modal')
  if (!req) {
    modal.hidden = true
    clearPermCountdown()
    state.permReqId = null
    return
  }
  // Already showing this exact request — don't rebuild (would wipe picks mid-answer).
  if (state.permReqId === req.id) return
  state.permReqId = req.id
  modal.hidden = false
  startPermCountdown(req.deadline)

  var toolBox = $('perm-tool')
  var qBox = $('perm-questions')
  var actions = $('perm-actions')
  qBox.innerHTML = ''
  actions.innerHTML = ''

  if (req.questions && req.questions.length) {
    toolBox.hidden = true
    var picked = req.questions.map(function () { return [] })
    var other = req.questions.map(function () { return '' })

    function resolved(qi) {
      var labels = picked[qi].filter(function (l) { return l !== OTHER })
      var text = other[qi].trim()
      var wantsOther = picked[qi].indexOf(OTHER) >= 0 && text.length > 0
      return wantsOther ? labels.concat([text]) : labels
    }
    function ready() {
      for (var i = 0; i < req.questions.length; i++) if (resolved(i).length === 0) return false
      return true
    }
    function updateSubmit() { submitBtn.disabled = !ready() }

    req.questions.forEach(function (q, qi) {
      var block = document.createElement('div')
      if (q.header) {
        var h = document.createElement('div')
        h.className = 'perm-q-sub'
        h.textContent = q.header
        block.appendChild(h)
      }
      var title = document.createElement('div')
      title.className = 'perm-q-title'
      title.textContent = q.question
      block.appendChild(title)

      var opts = document.createElement('div')
      opts.className = 'perm-q-opts'
      var otherInput = null

      function renderOpt(label, desc, isOtherOpt) {
        var btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'perm-opt'
        var labelSpan = document.createElement('span')
        labelSpan.textContent = label
        btn.appendChild(labelSpan)
        if (desc) {
          var descSpan = document.createElement('span')
          descSpan.className = 'perm-opt-desc'
          descSpan.textContent = desc
          btn.appendChild(descSpan)
        }
        btn.addEventListener('click', function () {
          var cur2 = picked[qi]
          var at = cur2.indexOf(isOtherOpt ? OTHER : label)
          if (q.multiSelect) {
            if (at >= 0) cur2.splice(at, 1)
            else cur2.push(isOtherOpt ? OTHER : label)
          } else {
            picked[qi] = (cur2[0] === (isOtherOpt ? OTHER : label)) ? [] : [isOtherOpt ? OTHER : label]
          }
          // Re-sync all buttons' selected state from `picked[qi]`.
          Array.prototype.forEach.call(opts.children, function (el, idx) {
            var lbl = idx < q.options.length ? q.options[idx].label : OTHER
            el.classList.toggle('selected', picked[qi].indexOf(lbl) >= 0)
          })
          if (otherInput) otherInput.hidden = picked[qi].indexOf(OTHER) < 0
          updateSubmit()
        })
        return btn
      }

      q.options.forEach(function (op) { opts.appendChild(renderOpt(op.label, op.description, false)) })
      opts.appendChild(renderOpt('Outro…', 'Escrever uma resposta própria', true))
      block.appendChild(opts)

      otherInput = document.createElement('input')
      otherInput.type = 'text'
      otherInput.className = 'perm-other-input'
      otherInput.placeholder = 'Sua resposta'
      otherInput.hidden = true
      otherInput.addEventListener('input', function () { other[qi] = otherInput.value; updateSubmit() })
      block.appendChild(otherInput)

      qBox.appendChild(block)
    })

    var cancelBtn = document.createElement('button')
    cancelBtn.className = 'perm-btn-deny'
    cancelBtn.textContent = 'Cancelar'
    cancelBtn.addEventListener('click', function () { permRespond(cur.id, req.id, 'deny', false) })
    var submitBtn = document.createElement('button')
    submitBtn.className = 'perm-btn-submit'
    submitBtn.textContent = 'Responder'
    submitBtn.disabled = true
    submitBtn.addEventListener('click', function () {
      if (!ready()) return
      var answers = req.questions.map(function (q, qi) {
        return { header: q.header, question: q.question, selected: resolved(qi) }
      })
      permRespond(cur.id, req.id, 'allow', false, answers)
    })
    actions.appendChild(cancelBtn)
    actions.appendChild(submitBtn)
  } else {
    toolBox.hidden = false
    toolBox.innerHTML = ''
    var niceName = (req.toolName || '').replace(/^mcp__browser__/, '🌐 ').replace(/^mcp__[^_]+__/, '')
    var toolLabel = document.createElement('span')
    toolLabel.textContent = 'O agente quer executar '
    var strong = document.createElement('strong')
    strong.textContent = niceName
    toolLabel.appendChild(strong)
    toolBox.appendChild(toolLabel)

    var denyBtn = document.createElement('button')
    denyBtn.className = 'perm-btn-deny'
    denyBtn.textContent = 'Negar'
    denyBtn.addEventListener('click', function () { permRespond(cur.id, req.id, 'deny', false) })
    var onceBtn = document.createElement('button')
    onceBtn.className = 'perm-btn-allow'
    onceBtn.textContent = 'Permitir uma vez'
    onceBtn.addEventListener('click', function () { permRespond(cur.id, req.id, 'allow', false) })
    var alwaysBtn = document.createElement('button')
    alwaysBtn.className = 'perm-btn-always'
    alwaysBtn.textContent = 'Sempre permitir'
    alwaysBtn.addEventListener('click', function () { permRespond(cur.id, req.id, 'allow', true) })
    actions.appendChild(denyBtn)
    actions.appendChild(onceBtn)
    actions.appendChild(alwaysBtn)
  }
}

function recoveryAction(action) {
  if (!state.convId) return
  fetch(api('/api/recovery'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ convId: state.convId, action: action })
  }).then(fetchState).catch(function () { setStatus(false) })
}

function pairingErrorText(err) {
  return errorText(err) + ' Vou tentar de novo automaticamente.'
}

/** Retry the saved pairing without ever discarding it. The QR screen is only
 * reached by an explicit cancel/logout action. */
function attemptPairingReconnect() {
  clearPairingRetry()
  // O usuário pode ter cancelado (config apagada) enquanto o probe LAN×VPS rodava.
  if (!state.publicBase || !state.token || !$('pair').hidden) return
  fetchState().then(function (data) {
    state.pairingAttempt = 0
    showConnectedChat(data)
  }).catch(function (err) {
    if (err && err.status === 409) return // outro celular pareado: tela própria
    $('pairing-detail').textContent = pairingErrorText(err)
    var delay = Math.min(15000, 1000 * Math.pow(2, state.pairingAttempt))
    state.pairingAttempt++
    $('pairing-status').textContent = 'Tentando novamente em ' + Math.ceil(delay / 1000) + ' s…'
    // Cada tentativa reavalia LAN × VPS: o celular pode ter trocado de rede
    // enquanto esperava.
    state.pairingRetry = setTimeout(function () {
      pickBestBase(state.publicBase, state.lanBase, state.token).then(function (base) {
        state.base = base
        attemptPairingReconnect()
      })
    }, delay)
  })
}

/** `explicit` = veio de um QR/endereço digitado agora: pareia ESTE celular no PC
 *  (tomando o lugar de outro, se houver). Auto-conexão ao abrir o app nunca
 *  toma o lugar de ninguém — só o gesto de escanear é intenção do usuário. */
function beginPairingReconnect(explicit) {
  if (!state.publicBase || !state.token) { showPair(); return }
  state.blocked = false
  $('pair').hidden = true
  $('chat').hidden = true
  $('blocked').hidden = true
  $('pairing').hidden = false
  $('pairing-detail').textContent = 'Procurando a ponte do seu PC…'
  $('pairing-status').textContent = 'Conectando…'
  // Re-decide LAN vs público a cada tentativa de reconexão (cobre trocar de
  // rede entre uma sessão e outra) — nunca falha, sempre cai no público.
  pickBestBase(state.publicBase, state.lanBase, state.token).then(function (base) {
    state.base = base
    if (!explicit) { attemptPairingReconnect(); return }
    fetchApi('/api/pair', { method: 'POST', body: { deviceId: deviceId(), name: deviceName() } })
      .then(function () { attemptPairingReconnect() }, function (err) {
        // 401/503/rede: cai no laço normal, que mostra o motivo e insiste.
        if (err && err.status === 409) return
        attemptPairingReconnect()
      })
  })
}

/** O PC respondeu 409: outro celular é o pareado. Mostra quem, e oferece tomar
 *  o lugar (equivale a escanear o QR de novo) ou cancelar. */
function onAnotherDevice(res) {
  if (state.blocked) return
  state.blocked = true
  var name = 'outro celular'
  res.clone().json().then(function (j) {
    if (j && j.pairedName) { name = j.pairedName; $('blocked-name').textContent = name }
  }).catch(function () {})
  $('blocked-name').textContent = name
  if (state.es) { try { state.es.close() } catch (e) {} state.es = null }
  if (state.poll) { clearInterval(state.poll); state.poll = null }
  if (state.reconnect) { clearTimeout(state.reconnect); state.reconnect = null }
  clearPairingRetry()
  $('reconnect').hidden = true
  $('chat').hidden = true
  $('pairing').hidden = true
  $('pair').hidden = true
  $('blocked').hidden = false
}

function openEvents() {
  if (state.reconnect) { clearTimeout(state.reconnect); state.reconnect = null }
  if (state.es) state.es.close()
  var es = new EventSource(api('/api/events'))
  state.es = es
  es.onopen = function () {
    state.retry = 0
    setStatus(true)
    // Assim que a sessão conecta (primeira vez ou depois de uma queda), ressincroniza
    // o chat da conversa ativa — o histórico pode ter mudado enquanto ficamos offline.
    // Silencioso: se for a 1ª conexão, selectConv (chamado logo em seguida por showChat)
    // já mostrou o loading; numa reconexão, as mensagens já carregadas ficam visíveis.
    if (state.convId) loadHistory(state.convId, true).catch(function () {})
  }
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
    if (!msg || !msg.event) return
    var ev = msg.event
    // Estado da conta / do turno, não conteúdo: atualiza os painéis e sai.
    if (ev.kind === 'rate-limit') {
      if (ev.limits && ev.limits.rateLimitType) { state.usage[ev.limits.rateLimitType] = ev.limits; renderUsage() }
      return
    }
    if (ev.kind === 'stall-status') {
      var c0 = state.conversations.find(function (c) { return c.id === msg.convId })
      if (c0) { c0.stalledSince = ev.stalled ? ev.since : undefined; if (c0.id === state.convId) renderBusy() }
      return
    }
    if (msg.convId !== state.convId) {
      // Event for another conversation — refresh the list (busy flags/titles).
      fetchState().catch(function () {})
      return
    }
    if (isSubagentEvent(ev) || STATE_ONLY[ev.kind]) {
      if (ev.kind === 'task-list') fetchState().catch(function () {})
      return
    }
    reduce(state.messages, ev)
    scheduleRender()
    if (ev.kind === 'result' || ev.kind === 'error') {
      $('busy').hidden = true
      fetchState().catch(function () {})
    } else {
      $('busy').hidden = false
      // A tool call often means a permission/AskUserQuestion (or a plan update)
      // is coming right after — refresh promptly instead of waiting for a poll.
      if (ev.kind === 'tool-use') fetchState().catch(function () {})
    }
  }
}

function selectConv(convId) {
  state.convId = convId
  localStorage.setItem(LAST_CONV_KEY, convId)
  updateConvTitle()
  renderBusy()
  renderModelBar()
  renderTodoPlan()
  renderTurnRecovery()
  renderUsage()
  // A pending permission belongs to a specific conversation — force a rebuild
  // so switching chats doesn't show/hide the wrong one.
  state.permReqId = null
  renderPermission()
  loadHistory(convId).catch(function () {})
}

function send() {
  var input = $('input')
  var text = input.value.trim()
  var imgs = state.images.slice()
  var files = state.files.slice()
  if ((!text && !imgs.length && !files.length) || !state.convId) return
  var thumbs = imgs.map(function (im) { return 'data:' + im.mediaType + ';base64,' + im.data })
  // Optimistic echo (the PC adds the user message locally; SSE only carries
  // agent events, so there's no duplicate).
  var cur = current()
  reduce(state.messages, {
    kind: 'user', id: 'u' + Date.now(), text: text, images: thumbs, ts: Date.now(), queued: !!(cur && cur.busy),
    files: files.map(function (f) { return { name: f.name, size: f.size } })
  })
  renderMessages()
  input.value = ''
  state.images = []
  state.files = []
  renderPreview()
  autoGrow()
  $('busy').hidden = false
  // Token goes in the query string (like the GET/SSE routes); body is the command.
  fetchApi('/api/send', { method: 'POST', body: { convId: state.convId, text: text, images: imgs, files: files }, timeout: 60000 })
    .catch(function (err) {
      setStatus(false)
      if (err && err.status) alert('Não enviei: ' + errorText(err))
    })
}

// ---- voice: mic (STT) + read aloud (TTS), both processed on the PC ----------

var rec = { recorder: null, stream: null, chunks: [], mime: '' }

function pickAudioMime() {
  var cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  for (var i = 0; i < cands.length; i++) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(cands[i])) return cands[i]
  }
  return ''
}

function setMicUI(recording, transcribing) {
  var b = $('mic')
  if (!b) return
  b.classList.toggle('recording', !!recording)
  b.classList.toggle('busy', !!transcribing)
  b.title = recording ? 'Parar e transcrever' : (transcribing ? 'Transcrevendo…' : 'Falar')
}

function toggleMic() {
  if (state.recording) stopRecording()
  else startRecording()
}

function startRecording() {
  if (!state.voiceReady) { alert('Configure a chave da OpenAI no app do PC para usar voz.'); return }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
    alert('Microfone indisponível aqui. Use o app instalado (no navegador via http a gravação é bloqueada).')
    return
  }
  rec.mime = pickAudioMime()
  navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
    rec.stream = stream
    rec.chunks = []
    var r = new MediaRecorder(stream, rec.mime ? { mimeType: rec.mime } : undefined)
    rec.recorder = r
    r.ondataavailable = function (e) { if (e.data && e.data.size) rec.chunks.push(e.data) }
    r.onstop = function () {
      var type = (rec.chunks[0] && rec.chunks[0].type) || rec.mime || 'audio/webm'
      var blob = new Blob(rec.chunks, { type: type })
      stopStream()
      if (blob.size) transcribeBlob(blob, type)
      else setMicUI(false)
    }
    r.start() // one whole, finalized file on stop
    state.recording = true
    setMicUI(true)
  }).catch(function (e) {
    stopStream()
    state.recording = false
    setMicUI(false)
    var name = e && e.name ? e.name : 'erro'
    alert(name === 'NotAllowedError'
      ? 'Permissão de microfone negada. Libere o microfone para o app nas configurações do Android.'
      : 'Não consegui acessar o microfone (' + name + ').')
  })
}

function stopRecording() {
  state.recording = false
  setMicUI(false, true)
  if (rec.recorder && rec.recorder.state !== 'inactive') {
    try { rec.recorder.stop() } catch (e) { /* already stopping */ }
  }
}

function stopStream() {
  if (rec.stream) { rec.stream.getTracks().forEach(function (t) { t.stop() }); rec.stream = null }
  rec.recorder = null
}

function blobToBase64(blob) {
  return new Promise(function (resolve) {
    var r = new FileReader()
    r.onload = function () {
      var s = String(r.result)
      var i = s.indexOf('base64,')
      resolve(i >= 0 ? s.slice(i + 'base64,'.length) : '')
    }
    r.onerror = function () { resolve('') }
    r.readAsDataURL(blob)
  })
}

// Send the recorded audio to the PC, which transcribes it and returns text we
// drop into the input box (appended to whatever is already typed).
function transcribeBlob(blob, type) {
  setMicUI(false, true)
  blobToBase64(blob).then(function (b64) {
    if (!b64) { setMicUI(false); return }
    return fetch(api('/api/transcribe'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioBase64: b64, mimeType: type })
    }).then(function (r) { return r.json() }).then(function (d) {
      setMicUI(false)
      if (d && d.ok && d.text) {
        var input = $('input')
        var t = String(d.text).trim()
        input.value = input.value.trim() ? input.value.trim() + ' ' + t : t
        autoGrow()
        input.focus()
      } else if (d && d.error === 'no-key') {
        alert('Configure a chave da OpenAI no app do PC para usar voz.')
      } else {
        alert('Transcrição falhou: ' + ((d && d.error) || 'erro'))
      }
    })
  }).catch(function () { setMicUI(false); alert('Falha ao transcrever o áudio.') })
}

function stopSpeak() {
  if (state.audio) { try { state.audio.pause() } catch (e) {} state.audio = null }
  state.speakingId = null
  scheduleRender()
}

// Ask the PC to synthesize the answer's text and play the returned MP3. Tapping
// again (same message) stops it.
function toggleSpeak(id, text) {
  if (state.speakingId === id) { stopSpeak(); return }
  stopSpeak()
  state.speakingId = id
  scheduleRender()
  fetch(api('/api/tts'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text })
  }).then(function (r) { return r.json() }).then(function (d) {
    if (state.speakingId !== id) return // canceled while loading
    if (d && d.ok && d.audioBase64) {
      var audio = new Audio('data:' + (d.mimeType || 'audio/mpeg') + ';base64,' + d.audioBase64)
      state.audio = audio
      audio.onended = function () { if (state.speakingId === id) stopSpeak() }
      audio.play().catch(function () { stopSpeak() })
    } else {
      stopSpeak()
      alert(d && d.error === 'no-key' ? 'Configure a chave da OpenAI no app do PC.' : 'Falha ao gerar o áudio.')
    }
  }).catch(function () { stopSpeak() })
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

var MAX_FILE_BYTES = 16 * 1024 * 1024

function fmtBytes(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
  if (n >= 1024) return Math.round(n / 1024) + ' KB'
  return n + ' B'
}

/** Qualquer arquivo (planilha, PDF, código…): vai em base64, o PC salva em disco
 *  e passa o caminho ao agente — igual ao composer do desktop. */
function fileToBlobAttachment(file) {
  return new Promise(function (resolve, reject) {
    if (file.size > MAX_FILE_BYTES) { reject(new Error(file.name + ' passa de 16 MB')); return }
    var r = new FileReader()
    r.onload = function () {
      var s = String(r.result)
      var i = s.indexOf('base64,')
      resolve({ name: file.name || 'arquivo', mediaType: file.type || 'application/octet-stream', data: i >= 0 ? s.slice(i + 7) : '', size: file.size })
    }
    r.onerror = function () { reject(new Error('falha ao ler ' + file.name)) }
    r.readAsDataURL(file)
  })
}

function addFiles(files) {
  var all = [].slice.call(files)
  var imgs = all.filter(function (f) { return f.type.indexOf('image/') === 0 })
  var others = all.filter(function (f) { return f.type.indexOf('image/') !== 0 })
  if (imgs.length) {
    Promise.all(imgs.map(fileToAttachment)).then(function (atts) {
      state.images = state.images.concat(atts).slice(0, 8)
      renderPreview()
    }).catch(function () {})
  }
  if (others.length) {
    Promise.all(others.map(fileToBlobAttachment)).then(function (atts) {
      state.files = state.files.concat(atts).slice(0, 8)
      renderPreview()
    }).catch(function (e) { alert('Anexo ignorado: ' + (e && e.message ? e.message : 'erro')) })
  }
}

function renderPreview() {
  var tray = $('preview')
  tray.innerHTML = ''
  if (!state.images.length && !state.files.length) { tray.hidden = true; return }
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
  state.files.forEach(function (f, i) {
    var item = el('preview-item preview-file')
    item.appendChild(el('file-chip', '📎 ' + f.name + ' · ' + fmtBytes(f.size)))
    var rm = document.createElement('button')
    rm.className = 'rm'
    rm.textContent = '✕'
    rm.addEventListener('click', function () {
      state.files.splice(i, 1)
      renderPreview()
    })
    item.appendChild(rm)
    tray.appendChild(item)
  })
}

// ---- screens --------------------------------------------------------------

function showConnectedChat(data) {
  clearPairingRetry()
  state.blocked = false
  $('pair').hidden = true
  $('pairing').hidden = true
  $('blocked').hidden = true
  $('chat').hidden = false
  state.retry = 0
  requestWakeLock()
  if (!data.conversations.length) {
    alert('Nenhuma conversa no PC ainda. Crie uma conversa no app do PC primeiro.')
  } else {
    var last = localStorage.getItem(LAST_CONV_KEY)
    var pick = state.conversations.some(function (c) { return c.id === last }) ? last : state.conversations[0].id
    selectConv(pick)
  }
  openEvents()
  if (state.poll) clearInterval(state.poll)
  state.poll = setInterval(function () { fetchState().catch(function () {}) }, 4000)
}

function showPair(error) {
  clearPairingRetry()
  if (state.es) { state.es.close(); state.es = null }
  if (state.poll) { clearInterval(state.poll); state.poll = null }
  if (state.reconnect) { clearTimeout(state.reconnect); state.reconnect = null }
  if (state.recording) stopRecording()
  stopSpeak()
  $('reconnect').hidden = true
  releaseWakeLock()
  if (typeof stopScan === 'function') stopScan()
  if (state.recoveryTimer) { clearInterval(state.recoveryTimer); state.recoveryTimer = null }
  if (state.stallTimer) { clearInterval(state.stallTimer); state.stallTimer = null }
  state.blocked = false
  $('chat').hidden = true
  $('pairing').hidden = true
  $('blocked').hidden = true
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
  state.publicBase = cfg.base
  state.lanBase = cfg.lan || ''
  state.base = cfg.base
  state.token = cfg.token
  saveConfig(cfg)
  $('addr').value = cfg.base
  $('token').value = cfg.token
  beginPairingReconnect(true)
}

function cancelPairingReconnect() {
  clearConfig()
  state.base = ''
  state.publicBase = ''
  state.lanBase = ''
  state.token = ''
  state.pairingAttempt = 0
  showPair()
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
  if (!$('pairing').hidden) {
    beginPairingReconnect()
    return
  }
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
  $('pairing-cancel').addEventListener('click', cancelPairingReconnect)
  $('turn-recovery-retry').addEventListener('click', function () { recoveryAction('retry') })
  $('turn-recovery-cancel').addEventListener('click', function () { recoveryAction('cancel') })

  // Open the conversation history (drawer) from the menu button or the title.
  $('menu').addEventListener('click', openDrawer)
  $('conv-title').addEventListener('click', openDrawer)
  // Live search over the user's prompts inside the drawer.
  $('hist-search-input').addEventListener('input', onSearchInput)
  // Floating scroll-to-bottom button.
  $('messages').addEventListener('scroll', updateJumpBtn)
  $('messages').addEventListener('click', function () {
    if (state.questionOpen) { state.questionOpen = null; renderQuestionMap() }
  })
  $('jump-bottom').addEventListener('click', scrollMessagesToBottom)
  setupPullToRefresh()
  // The online indicator reveals the connection menu; "Sair" asks to confirm.
  $('status').addEventListener('click', toggleStatusMenu)
  $('scrim').addEventListener('click', closeMenus)
  $('exit').addEventListener('click', function () { closeMenus(); confirmExit() })
  // Settings panel (from the connection menu or the sidebar gear).
  $('open-settings').addEventListener('click', openSettings)
  $('drawer-settings').addEventListener('click', openSettings)
  $('settings-back').addEventListener('click', closeSettings)
  $('cfg-exit').addEventListener('click', confirmExit)
  $('cfg-skip').addEventListener('change', function (e) { setSkipPerms(e.target.checked) })
  $('send').addEventListener('click', send)
  $('stop').addEventListener('click', interruptTurn)
  $('mode-economy').addEventListener('click', function () { setMode('economy') })
  $('mode-loop').addEventListener('click', function () { setMode('loop') })
  $('mode-fast').addEventListener('click', function () { setMode('fast') })
  // Outro celular pareado: tomar o lugar (= escanear o QR de novo) ou sair.
  $('blocked-takeover').addEventListener('click', function () { beginPairingReconnect(true) })
  $('blocked-cancel').addEventListener('click', cancelPairingReconnect)
  $('mic').addEventListener('click', toggleMic)
  // blur() right after choosing: Android keeps the <select> focused after its
  // native dialog closes, and a focused select blocks renderModelBar's rebuild
  // guard — the selectors would never reconcile with the PC again.
  $('model-select').addEventListener('change', function (e) { e.target.blur(); setModel({ model: e.target.value }) })
  $('effort-select').addEventListener('change', function (e) { e.target.blur(); setModel({ effort: e.target.value }) })
  $('input').addEventListener('input', autoGrow)

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
    state.publicBase = cfg.base
    state.lanBase = cfg.lan || ''
    state.base = cfg.base
    state.token = cfg.token
    beginPairingReconnect()
  }
}

document.addEventListener('DOMContentLoaded', init)
