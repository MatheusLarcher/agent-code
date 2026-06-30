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
  openTools: {},     // tool-use ids the user expanded (persist across re-renders)
  voiceReady: false, // PC has an OpenAI key → show mic/listen buttons
  recording: false,  // mic is capturing right now
  speakingId: null,  // id of the assistant message being read aloud (or null)
  audio: null,       // <Audio> currently playing the TTS
  scrollToMsg: null, // message id to scroll to after a search-result navigation
  skipPerms: false   // global "Permitir tudo" state (mirrored from the PC)
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
  // Remember position BEFORE clearing: clearing resets scrollTop to 0, which would
  // otherwise yank the view to the top on every streaming event.
  var prevTop = box.scrollTop
  var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80
  box.innerHTML = ''
  var scrollTarget = null
  state.messages.forEach(function (m) {
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
      if (m.text) u.appendChild(document.createTextNode(m.text))
      wrap.appendChild(u)
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
  return fetch(api('/api/state'))
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
    .then(function (data) {
      state.conversations = data.conversations || []
      var wasReady = state.voiceReady
      state.voiceReady = !!data.voiceReady
      var mic = $('mic')
      if (mic) mic.hidden = !state.voiceReady
      // Mirror the PC's "Permitir tudo" state; keep the settings toggle in sync.
      state.skipPerms = !!data.skipPerms
      syncSkipToggle()
      // Don't clobber active search results when the conversation list refreshes.
      var sb = $('hist-search-input')
      if (!$('history').hidden && !(sb && sb.value.trim())) renderHistory()
      updateConvTitle()
      var cur = current()
      $('busy').hidden = !(cur && cur.busy)
      // If voice availability flipped, refresh so the "Ouvir" buttons appear/hide.
      if (wasReady !== state.voiceReady) scheduleRender()
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
    var proj = el('hist-project')
    proj.appendChild(icon('folder', 14))
    proj.appendChild(document.createTextNode(' ' + basename(k)))
    g.appendChild(proj)
    groups[k].forEach(function (c) {
      var row = el('hist-row' + (c.id === state.convId ? ' active' : ''))
      row.appendChild(el('hist-title', c.title || 'Conversa'))
      if (c.busy) { var hb = el('hist-busy'); hb.appendChild(icon('clock', 13)); row.appendChild(hb) }
      row.addEventListener('click', function () { selectConv(c.id); closeDrawer() })
      g.appendChild(row)
    })
    list.appendChild(g)
  })
  updateConvTitle()
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
    showPair()
  }
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
    scheduleRender()
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
  reduce(state.messages, { kind: 'user', id: 'u' + Date.now(), text: text, images: thumbs, ts: Date.now() })
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
  if (state.recording) stopRecording()
  stopSpeak()
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
  // Live search over the user's prompts inside the drawer.
  $('hist-search-input').addEventListener('input', onSearchInput)
  // Floating scroll-to-bottom button.
  $('messages').addEventListener('scroll', updateJumpBtn)
  $('jump-bottom').addEventListener('click', scrollMessagesToBottom)
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
  $('mic').addEventListener('click', toggleMic)
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
