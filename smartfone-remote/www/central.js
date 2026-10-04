/*
 * A Central no celular — a conversa única que leva cada pedido para a conversa
 * certa (no PC: src/renderer/src/central/). Desenha o retrato que o PC publica
 * no /api/state (`conversation.central`, montado por centralRemote.ts), como no
 * mockup v3:
 *   - trilho das conversas trabalhando agora (o toque abre a conversa);
 *   - pedidos com o aviso do destino (`→ destino`; o adotado, `em projeto · conversa`);
 *   - "Para onde vai?" com um botão por opção → POST /api/central-choose;
 *   - blocos de resposta e perguntas/permissões dos destinos: centralTurns.js.
 * Erros seguem o padrão do app (alert); o andamento aparece na própria tela.
 * Carregado depois do app.js: usa o `state` e as funções dele.
 */
'use strict'

var CENTRAL_CONV_ID = 'central'
var CENTRAL_PLACEHOLDER = 'Fale com o agent…'
/** A bolha "enviando…" some se o retrato do PC não trouxer o pedido neste tempo. */
var CENTRAL_SENT_TTL_MS = 20000
/** Escolha/resposta enviada: os botões ficam travados até o retrato mudar (ou este tempo). */
var CENTRAL_BUSY_TTL_MS = 10000
var CENTRAL_ASK_HINT = {
  'low-confidence': 'não tenho certeza — a mensagem está esperando',
  'typesafe-failed': 'o TypeSafe não respondeu — a mensagem está esperando',
  'target-missing': 'o destino não existe mais — escolha outro',
  moved: 'escolha o destino certo'
}
/** Traço desenhado quando o destino não tem ícone de projeto. */
var CENTRAL_GLYPH = { project: 'folder', sandbox: 'sandbox', 'new': 'plus' }

var centralUi = {
  open: {},        // id da resposta → ações do turno abertas
  tools: {},       // id da resposta → { loading, error, found, list, closed, partial, count }
  why: {},         // id do pedido → mostrando o porquê do destino
  sent: [],        // { text, files, at, known } enviados daqui, até o retrato trazê-los
  busy: {},        // id do pedido / 'q:' + id da pergunta → quando a escolha/resposta saiu
  picks: {},       // convId:id da pergunta → escolhas por pergunta (várias ou múltipla)
  sig: '',         // assinatura do último desenho
  placeholder: null,
  timers: [],
  replyTo: null    // modo resposta: { id, who, color, text } da mensagem citada
}

// Ícones de traço da Central, no conjunto do app.js (ICONS + icon()).
ICONS.sandbox = '<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>'
ICONS.plus = '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'
ICONS.open = '<path d="M14 5h5v5"/><line x1="19" y1="5" x2="11" y2="13"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>'
ICONS.chevron = '<polyline points="9 6 15 12 9 18"/>'
ICONS.check = '<polyline points="5 12.5 10 17 19 7"/>'
ICONS.reply = '<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>'

function isCentralConv(c) { return !!c && c.id === CENTRAL_CONV_ID }
function centralOpen() { return state.convId === CENTRAL_CONV_ID }
function centralConv() {
  for (var i = 0; i < state.conversations.length; i++) if (isCentralConv(state.conversations[i])) return state.conversations[i]
  return null
}
/** O retrato publicado pelo PC (vazio enquanto não chega). */
function centralSnapshot() {
  var conv = centralConv()
  var c = (conv && conv.central) || {}
  return {
    entries: Array.isArray(c.entries) ? c.entries : [],
    rail: Array.isArray(c.rail) ? c.rail : [],
    questions: Array.isArray(c.questions) ? c.questions : []
  }
}

function span(cls, text) {
  var s = document.createElement('span')
  if (cls) s.className = cls
  if (text != null) s.textContent = text
  return s
}
function button(cls, onClick) {
  var b = document.createElement('button')
  b.type = 'button'
  b.className = cls
  b.addEventListener('click', function (e) { e.stopPropagation(); onClick() })
  return b
}
function svgIcon(name, size, cls) {
  var ic = icon(name, size)
  ic.setAttribute('class', cls)
  return ic
}
/** A cor do destino vem do PC (paleta fixa); qualquer outra coisa vira a neutra. */
function tint(node, color) {
  node.style.setProperty('--c', typeof color === 'string' && /^#[0-9a-f]{3,8}$/i.test(color) ? color : 'var(--muted)')
  return node
}
/** O ícone do projeto (o data URL pequeno que o PC manda) ou o traço: pasta, sandbox ou "+". */
function destIcon(iconUrl, glyph, size) {
  if (typeof iconUrl === 'string' && /^data:image\//i.test(iconUrl)) {
    var img = document.createElement('img')
    img.className = 'c-pi'
    img.alt = ''
    img.width = size
    img.height = size
    img.src = iconUrl
    return img
  }
  return svgIcon(CENTRAL_GLYPH[glyph] || 'folder', size, 'c-pi c-glyph')
}
function waitLine(text) {
  var w = el('c-wait')
  w.appendChild(span('spinner c-spinner'))
  w.appendChild(span('', text))
  return w
}

// ---- moldura: lista de conversas, título, campo, trilho ----------------------

/** A Central fixa no topo da lista de conversas: orbe, "Central" e uma bolinha por destino trabalhando. */
function renderCentralRow(list) {
  var conv = centralConv()
  if (!conv) return
  var row = el('hist-row central-row' + (centralOpen() ? ' active' : ''))
  row.appendChild(el('central-orb'))
  var text = el('central-row-text')
  text.appendChild(el('hist-title', conv.title || 'Central'))
  text.appendChild(el('central-row-sub', 'fale com o agent'))
  row.appendChild(text)
  var dots = el('central-dots')
  centralSnapshot().rail.slice(0, 6).forEach(function (card) { dots.appendChild(tint(span('central-dot'), card.color)) })
  row.appendChild(dots)
  row.addEventListener('click', function () { selectConv(CENTRAL_CONV_ID); closeDrawer() })
  list.appendChild(row)
}

/** Título, campo e trilho seguem a conversa aberta (chamado pelo updateConvTitle). */
function syncCentralChrome() {
  var on = centralOpen()
  var input = $('input')
  if (input) {
    if (centralUi.placeholder === null) centralUi.placeholder = input.getAttribute('placeholder') || ''
    input.setAttribute('placeholder', on ? CENTRAL_PLACEHOLDER : centralUi.placeholder)
  }
  var title = $('conv-title')
  if (title) title.classList.toggle('is-central', on)
  var rail = $('central-rail')
  if (rail && !on) rail.hidden = true
  if (!on) centralUi.replyTo = null
  renderCentralReplyBar()
}

/** Os cartões das conversas trabalhando agora: ícone, nome, cor e a bolinha pulsando. */
function renderCentralRail(rail) {
  var bar = $('central-rail')
  if (!bar) return
  bar.innerHTML = ''
  bar.hidden = !centralOpen() || !rail.length
  rail.forEach(function (card) {
    var b = tint(button('c-run', function () { openCentralDestination({ convId: card.convId }) }), card.color)
    b.appendChild(destIcon(card.icon, card.sandbox ? 'sandbox' : 'project', 16))
    b.appendChild(span('c-run-title', card.title || card.project || 'conversa'))
    b.appendChild(span('c-run-dot'))
    b.title = (card.project ? card.project + ' · ' : '') + (card.title || '')
    bar.appendChild(b)
  })
}

// ---- a tela ------------------------------------------------------------------

/** A Central no lugar das mensagens. Redesenha só quando o retrato mudou, ao entrar ou com `force`. */
function renderCentral(box, force) {
  var snap = centralSnapshot()
  pruneCentral(snap)
  var entering = !box.querySelector('.central-view')
  var sig = JSON.stringify([snap, centralUi.sent.length, Object.keys(centralUi.busy).length])
  if (!force && !entering && sig === centralUi.sig) return
  centralUi.sig = sig
  renderCentralRail(snap.rail)
  var prevTop = box.scrollTop
  var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80
  var view = el('central-view')
  snap.entries.forEach(function (e) {
    if (!e) return
    if (e.kind === 'request') renderCentralRequest(view, e)
    else if (e.kind === 'reply') renderCentralReply(view, e)
    else if (e.kind === 'question') renderCentralAnswered(view, e)
  })
  centralUi.sent.forEach(function (s) { renderCentralSending(view, s) })
  snap.questions.forEach(function (q) { if (q && q.request) renderCentralQuestion(view, q) })
  if (!view.children.length) view.appendChild(el('c-empty', 'Diga o que precisa: a Central leva para a conversa certa.'))
  box.innerHTML = ''
  box.appendChild(view)
  box.scrollTop = entering || nearBottom ? box.scrollHeight : prevTop
  updateJumpBtn()
  renderQuestionMap()
}
function rerenderCentral() { if (centralOpen()) renderCentral($('messages'), true) }

/** Some a bolha "enviando…" que o retrato já trouxe (ou que venceu) e destrava escolha/resposta já aplicada. */
function pruneCentral(snap) {
  var now = Date.now()
  centralUi.sent = centralUi.sent.filter(function (s) {
    if (now - s.at > CENTRAL_SENT_TTL_MS) return false
    return !snap.entries.some(function (e) {
      return e && e.kind === 'request' && !s.known[e.id] && String(e.text || '').slice(0, 200) === s.text.slice(0, 200)
    })
  })
  Object.keys(centralUi.busy).forEach(function (key) {
    var pending = key.indexOf('q:') === 0
      ? snap.questions.some(function (q) { return q && q.request && 'q:' + q.request.id === key })
      : snap.entries.some(function (e) { return e && e.kind === 'request' && e.id === key && e.state === 'asking' })
    if (!pending || now - centralUi.busy[key] > CENTRAL_BUSY_TTL_MS) delete centralUi.busy[key]
  })
}

/** O PC publica o retrato ~0,4 s depois de mudar: lê de novo logo, sem esperar o ciclo de 4 s. */
function refreshCentralSoon() {
  centralUi.timers.forEach(clearTimeout)
  centralUi.timers = [700, 1800, 3500].map(function (ms) {
    return setTimeout(function () { fetchState().catch(function () {}) }, ms)
  })
}

/** Enviado daqui (send do app.js): bolha "enviando…" até o retrato trazer o pedido (ids que já existiam não contam). */
function centralNoteSent(text, files) {
  var known = {}
  centralSnapshot().entries.forEach(function (e) { if (e) known[e.id] = true })
  centralUi.sent.push({ text: text, files: files, at: Date.now(), known: known })
  refreshCentralSoon()
}
function centralSendFailed(text) {
  centralUi.sent = centralUi.sent.filter(function (s) { return s.text !== text })
  rerenderCentral()
}

/** "abrir": a conversa do destino no app, rolada até o turno quando há âncora. */
function openCentralDestination(anchor) {
  if (!anchor || !anchor.convId) return
  if (!state.conversations.some(function (c) { return c.id === anchor.convId })) {
    alert('Essa conversa não está carregada no PC agora.')
    return
  }
  state.scrollToMsg = anchor.msgId || null
  selectConv(anchor.convId)
}

// ---- pedidos e "Para onde vai?" ----------------------------------------------

function renderCentralRequest(view, e) {
  var row = el('c-me' + (centralUi.why[e.id] ? ' show-why' : ''))
  if (e.replyTo) row.appendChild(centralQuoteNode(e.replyTo))
  var bubble = el('c-bubble')
  appendRequestText(bubble, typeof e.text === 'string' ? e.text : '', Array.isArray(e.attachments) ? e.attachments : [])
  // O porquê do destino fica escondido (no PC aparece no hover): o toque na bolha mostra.
  if (e.notice && e.notice.why) {
    bubble.addEventListener('click', function () { centralUi.why[e.id] = !centralUi.why[e.id]; rerenderCentral() })
  }
  row.appendChild(bubble)
  var line = requestLine(e)
  if (line) row.appendChild(line)
  centralSwipe(row, centralQuoteOf(e))
  view.appendChild(row)
  // Adotado (A1) nunca pergunta para onde vai.
  if (e.state === 'asking' && e.ask && e.origin !== 'conversation') view.appendChild(renderCentralAsk(e))
}

/** O texto com o nome de cada anexo no lugar do {{midia:N}} (como no PC); os sem marcador vão depois. */
function appendRequestText(bubble, text, names) {
  var used = {}
  var re = /\{\{midia:(\d{1,4})\}\}/g
  var last = 0
  var m
  while ((m = re.exec(text))) {
    if (m.index > last) bubble.appendChild(document.createTextNode(text.slice(last, m.index)))
    used[+m[1]] = true
    bubble.appendChild(span('c-att', names[+m[1] - 1] || 'mídia ' + m[1]))
    last = re.lastIndex
  }
  if (last < text.length) bubble.appendChild(document.createTextNode(text.slice(last)))
  var rest = names.filter(function (_, i) { return !used[i + 1] })
  if (!rest.length) return
  var atts = el('c-atts')
  rest.forEach(function (name) { atts.appendChild(span('c-att', name)) })
  bubble.appendChild(atts)
}

/** Debaixo da bolha: decidindo, não entregue, ou para onde foi (`→ destino`; adotado: `em …`). */
function requestLine(e) {
  if (e.state === 'routing') return waitLine('escolhendo o destino…')
  if (e.state === 'failed') return el('c-route c-bad', 'não foi entregue')
  var n = e.notice
  if (!n || e.state === 'asking') return null
  var line = tint(el('c-route'), n.color)
  if (n.why) line.appendChild(span('c-why', n.why + ' ·'))
  var to = button('c-to', function () { openCentralDestination(e.anchor) })
  to.textContent = (e.origin === 'conversation' ? 'em ' : '→ ') + n.to
  line.appendChild(to)
  return line
}

/** "Para onde vai?". Pedido de OUTRO PC (`foreign`) só aquele PC entrega: as opções aparecem sem
 *  botões, com "aguardando o outro PC", e nada é enviado daqui. */
function renderCentralAsk(e) {
  var foreign = e.foreign === true
  var card = el('c-ask' + (foreign ? ' foreign' : ''))
  var head = el('c-ask-head')
  head.appendChild(span('c-ask-title', 'Para onde vai?'))
  if (!foreign && CENTRAL_ASK_HINT[e.ask.reason]) head.appendChild(span('c-ask-hint', CENTRAL_ASK_HINT[e.ask.reason]))
  card.appendChild(head)
  var busy = !foreign && !!centralUi.busy[e.id]
  var opts = el('c-opts')
  ;(Array.isArray(e.ask.options) ? e.ask.options : []).forEach(function (o, i) {
    var cls = 'c-opt' + (o.best ? ' best' : '')
    var b = foreign ? span(cls) : button(cls, function () { centralChoose(e.id, i) })
    if (!foreign) b.disabled = busy
    b.appendChild(destIcon(o.icon, o.glyph, 14))
    b.appendChild(span('c-opt-label', o.label || 'destino'))
    if (o.sub) b.appendChild(span('c-opt-sub', o.sub))
    opts.appendChild(b)
  })
  card.appendChild(opts)
  if (foreign) card.appendChild(el('c-ask-foreign', 'aguardando o outro PC'))
  else if (busy) card.appendChild(waitLine('levando para o destino…'))
  return card
}

/** "Para onde vai?": a opção vai ao PC, que entrega como no clique de lá (nunca para pedido de outro PC). */
function centralChoose(entryId, option) {
  if (centralUi.busy[entryId] || isForeignRequest(entryId)) return
  centralUi.busy[entryId] = Date.now()
  rerenderCentral()
  fetchApi('/api/central-choose', { method: 'POST', body: { entryId: entryId, option: option } }).then(refreshCentralSoon, function (err) {
    delete centralUi.busy[entryId]
    rerenderCentral()
    if (err && err.status === 409) return // outro celular pareado: a tela própria já assumiu
    alert('Não foi possível escolher o destino: ' + errorText(err))
  })
}

function isForeignRequest(entryId) {
  return centralSnapshot().entries.some(function (e) { return e && e.kind === 'request' && e.id === entryId && e.foreign === true })
}

function renderCentralSending(view, s) {
  var row = el('c-me c-sending')
  row.appendChild(el('c-bubble', s.text || (s.files === 1 ? '1 anexo' : s.files + ' anexos')))
  row.appendChild(waitLine('enviando…'))
  view.appendChild(row)
}

// ---- responder uma mensagem (estilo WhatsApp) ---------------------------------
// Arrastar a mensagem para a direita além do limiar ativa o modo resposta: a
// citação aparece acima do campo e o envio leva `replyTo` (id da entrada) no
// POST /api/send — o PC entrega direto na conversa dela, sem o decisor.

/** Até onde a mensagem anda e a partir de onde soltar responde (px). */
var CENTRAL_SWIPE_MAX = 80
var CENTRAL_SWIPE_ARM = 56
var CENTRAL_QUOTE_MAX = 160

function clipText(text, max) {
  var t = String(text || '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

/** A citação de uma entrada do retrato, ou null quando não se responde (sem destino ou de outro PC). */
function centralQuoteOf(e) {
  if (!e || !e.anchor || !e.anchor.convId || e.foreign === true) return null
  if (e.kind === 'request') {
    if (e.state !== 'delivered') return null
    var n = e.notice || {}
    return { id: e.id, who: n.to || '', color: n.color, text: clipText(e.text, CENTRAL_QUOTE_MAX) }
  }
  if (e.kind === 'reply') {
    var notes = Array.isArray(e.notes) ? e.notes : []
    var body = e.answer || notes[notes.length - 1] || (e.activity && e.activity.text) || ''
    return { id: e.id, who: e.who || '', color: e.color, text: clipText(body, CENTRAL_QUOTE_MAX) }
  }
  return null
}

/** A citação: na cor da conversa, "projeto · conversa" e o trecho; com `onCancel`, o ×. */
function centralQuoteNode(q, onCancel) {
  var box = tint(el('c-quote'), q.color)
  var body = el('c-quote-body')
  if (q.who) body.appendChild(span('c-quote-who', q.who))
  body.appendChild(span('c-quote-text', q.text || ''))
  box.appendChild(body)
  if (onCancel) {
    var x = button('c-quote-x', onCancel)
    x.textContent = '×'
    x.setAttribute('aria-label', 'Cancelar resposta')
    box.appendChild(x)
  }
  return box
}

function renderCentralReplyBar() {
  var bar = $('c-replybar')
  if (!bar) return
  var q = centralOpen() ? centralUi.replyTo : null
  bar.innerHTML = ''
  bar.hidden = !q
  if (!q) return
  var node = centralQuoteNode(q, function () { setCentralReply(null) })
  bar.style.setProperty('--c', node.style.getPropertyValue('--c'))
  while (node.firstChild) bar.appendChild(node.firstChild)
}

function setCentralReply(q) {
  centralUi.replyTo = q
  renderCentralReplyBar()
  var input = $('input')
  if (q && input) input.focus()
}

/** O `replyTo` do próximo envio na Central (e sai do modo resposta). */
function takeCentralReply() {
  var q = centralUi.replyTo
  if (q) setCentralReply(null)
  return q ? q.id : null
}

/** O gesto: arrastar para a direita (horizontal dominante) move a mensagem e revela a seta;
 *  soltar além do limiar responde. Sempre volta ao lugar com animação. */
function centralSwipe(node, quote) {
  if (!quote) return
  node.classList.add('c-swipe')
  node.setAttribute('data-reply-id', quote.id)
  var ic = svgIcon('reply', 16, 'c-swipe-ic')
  node.appendChild(ic)
  var start = null
  var dx = 0
  var axis = null
  var swiped = false
  node.addEventListener('pointerdown', function (e) {
    if (e.button) return
    start = { x: e.clientX, y: e.clientY, id: e.pointerId }
    dx = 0
    axis = null
  })
  node.addEventListener('pointermove', function (e) {
    if (!start || e.pointerId !== start.id) return
    var mx = e.clientX - start.x
    var my = e.clientY - start.y
    if (!axis) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return
      axis = mx > 0 && Math.abs(mx) > Math.abs(my) ? 'x' : 'y'
      if (axis !== 'x') return
      try { node.setPointerCapture(e.pointerId) } catch (_) { /* sem captura: segue */ }
      node.classList.remove('c-settle')
      node.classList.add('c-dragging')
    }
    if (axis !== 'x') return
    dx = Math.max(0, Math.min(CENTRAL_SWIPE_MAX, mx))
    node.style.transform = 'translateX(' + dx + 'px)'
    ic.style.opacity = String(Math.min(1, dx / CENTRAL_SWIPE_ARM))
    ic.classList.toggle('armed', dx >= CENTRAL_SWIPE_ARM)
    e.preventDefault()
  })
  function end() {
    if (!start) return
    var fire = axis === 'x' && dx >= CENTRAL_SWIPE_ARM
    swiped = axis === 'x'
    start = null
    axis = null
    node.classList.remove('c-dragging')
    node.classList.add('c-settle')
    node.style.transform = ''
    ic.style.opacity = '0'
    ic.classList.remove('armed')
    if (!fire) return
    if (navigator.vibrate) { try { navigator.vibrate(10) } catch (_) { /* sem vibração */ } }
    setCentralReply(quote)
  }
  node.addEventListener('pointerup', end)
  node.addEventListener('pointercancel', end)
  // O toque que terminou um arrasto não vira clique (abrir destino, mostrar o porquê).
  node.addEventListener('click', function (e) {
    if (!swiped) return
    swiped = false
    e.stopPropagation()
    e.preventDefault()
  }, true)
}
