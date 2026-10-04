/*
 * A volta dos destinos na Central do celular (central.js desenha a tela e chama
 * estas funções): o bloco de resposta com a linha de atividade pronta — o toque
 * abre as ações do turno com o renderTool() do chat, lidas do histórico do
 * destino, nunca copiadas — e as perguntas/permissões dos destinos, respondidas
 * pelo permRespond() do app.js com o convId DO DESTINO.
 * Carregado depois do central.js (usa centralUi, span, button, tint…).
 */
'use strict'

// ---- respostas e a linha de atividade ----------------------------------------

function renderCentralReply(view, r) {
  if (!r.anchor) return
  var block = tint(el('c-agent'), r.color)
  block.appendChild(el('c-who', r.who))
  ;(Array.isArray(r.notes) ? r.notes : []).forEach(function (n) {
    var note = el('c-note md')
    note.innerHTML = mdToHtml(n)
    block.appendChild(note)
  })
  if (r.answer) {
    var parsed = parseDownloads(r.answer)
    if (parsed.clean) {
      var answer = el('c-answer md')
      answer.innerHTML = mdToHtml(parsed.clean)
      block.appendChild(answer)
    }
    parsed.paths.forEach(function (path) {
      var dl = button('c-dl', function () { triggerDownload(path) })
      dl.appendChild(icon('download', 15))
      dl.appendChild(span('', 'Baixar ' + basename(path)))
      block.appendChild(dl)
    })
  }
  var act = renderCentralActivity(r)
  if (act) block.appendChild(act)
  if (centralUi.open[r.id]) block.appendChild(renderTurnTools(r))
  block.appendChild(openLink(r.anchor))
  centralSwipe(block, centralQuoteOf(r))
  view.appendChild(block)
}

function openLink(anchor) {
  var open = button('c-open', function () { openCentralDestination(anchor) })
  open.appendChild(span('', 'abrir'))
  open.appendChild(icon('open', 13))
  return open
}

/** A linha-resumo pronta (vinda do PC): girando enquanto o turno roda, o total de ações à direita. */
function renderCentralActivity(r) {
  var a = r.activity || {}
  var count = a.count || 0
  var running = !a.done
  if (!count && !running) return null
  var line = button('c-act' + (centralUi.open[r.id] ? ' open' : ''), function () { if (count) toggleTurnTools(r) })
  line.appendChild(running ? span('c-spin') : svgIcon('chevron', 12, 'c-chev'))
  var sum = span('c-sum')
  ;(Array.isArray(a.segments) ? a.segments : []).forEach(function (s) { sum.appendChild(segmentNode(s)) })
  if (running && a.now) sum.appendChild(document.createTextNode((sum.childNodes.length ? ' · ' : '') + 'agora: ' + a.now))
  if (!sum.childNodes.length) sum.textContent = running ? 'trabalhando…' : count + (count === 1 ? ' ação' : ' ações')
  if (a.text) line.title = a.text
  line.appendChild(sum)
  line.appendChild(span('c-count', String(count)))
  return line
}

function segmentNode(s) {
  if (s && s.tone === 'strong') {
    var b = document.createElement('b')
    b.textContent = s.text
    return b
  }
  var tone = s && s.tone
  return span(tone === 'add' || tone === 'ok' ? 'c-ok' : tone === 'rem' || tone === 'bad' ? 'c-bad' : '', s ? s.text : '')
}

function toggleTurnTools(r) {
  if (centralUi.open[r.id]) delete centralUi.open[r.id]
  else {
    centralUi.open[r.id] = true
    loadTurnTools(r)
  }
  rerenderCentral()
}

/** As ações do turno, lidas do destino: /api/history; âncora fora das últimas mensagens, a janela em volta dela. */
function loadTurnTools(r) {
  var prev = centralUi.tools[r.id]
  if (prev && prev.loading) return
  var count = (r.activity && r.activity.count) || 0
  centralUi.tools[r.id] = { loading: true, count: count, found: !!(prev && prev.found), list: (prev && prev.list) || [], closed: !!(prev && prev.closed), partial: !!(prev && prev.partial) }
  var conv = encodeURIComponent(r.anchor.convId)
  var done = function (t) { centralUi.tools[r.id] = t; rerenderCentral() }
  fetchApi('/api/history?conv=' + conv)
    .then(function (data) {
      var msgs = (data && data.messages) || []
      if (anchorAt(msgs, r.anchor.msgId) >= 0) return { msgs: msgs, partial: false }
      return fetchApi('/api/history-window?conv=' + conv + '&message=' + encodeURIComponent(r.anchor.msgId)).then(
        function (w) { return { msgs: (w && w.messages) || [], partial: true } },
        function (err) { if (err && err.status === 404) return { msgs: [], partial: true }; throw err }
      )
    })
    .then(function (got) {
      var turn = turnToolsOf(got.msgs, r.anchor.msgId)
      done({ loading: false, count: count, found: !!turn, list: turn ? turn.tools : [], closed: !!(turn && turn.closed), partial: got.partial })
    }, function (err) {
      done({ loading: false, count: count, error: errorText(err) })
    })
}

function anchorAt(msgs, msgId) {
  for (var i = 0; i < msgs.length; i++) if (msgs[i] && msgs[i].kind === 'user' && msgs[i].id === msgId) return i
  return -1
}

/** Os tool-use do turno (sem subagente nem plano, como no chat): da âncora até a próxima mensagem do usuário que abre turno. */
function turnToolsOf(msgs, msgId) {
  var start = anchorAt(msgs, msgId)
  if (start < 0) return null
  var tools = []
  for (var i = start + 1; i < msgs.length; i++) {
    var m = msgs[i]
    if (m && m.kind === 'user' && !m.injected) return { tools: tools, closed: true }
    if (m && m.kind === 'tool-use' && !isHiddenMessage(m)) tools.push(m)
  }
  return { tools: tools, closed: false }
}

function renderTurnTools(r) {
  var box = el('c-tools')
  var t = centralUi.tools[r.id]
  // Turno rodando com ação nova desde a leitura: lê de novo (a lista anterior fica na tela).
  if (t && !t.loading && !t.error && t.count !== ((r.activity && r.activity.count) || 0)) loadTurnTools(r)
  t = centralUi.tools[r.id]
  if (!t || (t.loading && !t.found)) box.appendChild(waitLine('carregando as ações…'))
  else if (t.error) box.appendChild(el('c-tools-note c-bad', 'Não foi possível carregar as ações: ' + t.error))
  else if (!t.found) box.appendChild(el('c-tools-note', 'As ações deste turno não estão mais nas mensagens recentes — abra a conversa.'))
  else {
    if (!t.list.length) box.appendChild(el('c-tools-note', 'Nenhuma ação neste trecho.'))
    t.list.forEach(function (m) { box.appendChild(renderTool(m)) })
    if (t.partial && !t.closed) box.appendChild(el('c-tools-note', 'Mostrando o trecho disponível — abra a conversa para ver o resto.'))
  }
  return box
}

// ---- perguntas dos destinos ----------------------------------------------------

function renderCentralAnswered(view, q) {
  var card = tint(el('c-qdone'), q.color)
  card.appendChild(el('c-who', q.who))
  card.appendChild(el('c-qdone-q', q.question))
  var answer = el('c-qdone-a')
  answer.appendChild(svgIcon('check', 12, 'c-check'))
  answer.appendChild(span('', q.answer))
  card.appendChild(answer)
  view.appendChild(card)
}

/** Pergunta/permissão viva de um destino, na cor dele; a resposta vai com o convId DO DESTINO. */
function renderCentralQuestion(view, q) {
  var req = q.request
  var asks = Array.isArray(req.questions) && req.questions.length ? req.questions : null
  var card = tint(el('c-q'), q.color)
  card.appendChild(el('c-who', q.who + (asks ? ' pergunta' : ' pede permissão')))
  var busy = !!centralUi.busy['q:' + req.id]
  if (asks) renderQuestionOptions(card, q, req, asks, busy)
  else renderPermissionAsk(card, q, req, busy)
  if (busy) card.appendChild(waitLine('respondendo…'))
  card.appendChild(openLink({ convId: q.convId }))
  view.appendChild(card)
}

/** Uma pergunta de escolha única: o toque responde. Várias perguntas ou múltipla escolha: marca e "Responder". */
function renderQuestionOptions(card, q, req, asks, busy) {
  var key = q.convId + ':' + req.id
  var simple = asks.length === 1 && !asks[0].multiSelect
  var picks = centralUi.picks[key] || (centralUi.picks[key] = asks.map(function () { return [] }))
  asks.forEach(function (a, qi) {
    card.appendChild(el('c-q-title', a.question))
    var opts = el('c-opts')
    ;(Array.isArray(a.options) ? a.options : []).forEach(function (o) {
      var b = button('c-opt' + (picks[qi].indexOf(o.label) >= 0 ? ' picked' : ''), function () {
        if (simple) return answerDestination(q, req, 'allow', [{ header: a.header, question: a.question, selected: [o.label] }])
        var at = picks[qi].indexOf(o.label)
        if (a.multiSelect) { if (at >= 0) picks[qi].splice(at, 1); else picks[qi].push(o.label) }
        else picks[qi] = at >= 0 ? [] : [o.label]
        rerenderCentral()
      })
      b.disabled = busy
      b.appendChild(span('c-opt-label', o.label))
      if (o.description) b.appendChild(span('c-opt-sub', o.description))
      opts.appendChild(b)
    })
    card.appendChild(opts)
  })
  if (simple) return
  var actions = el('c-q-actions')
  var submit = button('c-btn primary', function () {
    answerDestination(q, req, 'allow', asks.map(function (a, qi) { return { header: a.header, question: a.question, selected: picks[qi].slice() } }))
  })
  submit.textContent = 'Responder'
  submit.disabled = busy || picks.some(function (p) { return !p.length })
  actions.appendChild(submit)
  card.appendChild(actions)
}

/** Permissão de ferramenta do destino: o que ela quer fazer, e Negar / Permitir. */
function renderPermissionAsk(card, q, req, busy) {
  var input = req.input || {}
  var name = String(req.toolName || 'ferramenta')
  var info = describeTool(name, input)
  var title = el('c-q-title')
  title.appendChild(span('', 'quer usar '))
  var verb = document.createElement('b')
  verb.textContent = /^mcp__/.test(name) ? name.replace(/^mcp__[^_]+__/, '') : info.verb
  title.appendChild(verb)
  if (info.detail) title.appendChild(span('', ' ' + info.detail))
  card.appendChild(title)
  var code = input.command || input.url || input.pattern || input.query
  if (typeof code === 'string' && code) card.appendChild(el('c-q-code', code))
  if (typeof input.description === 'string' && input.description) card.appendChild(el('c-q-desc', input.description))
  var actions = el('c-q-actions')
  var deny = button('c-btn', function () { answerDestination(q, req, 'deny') })
  deny.textContent = 'Negar'
  var allow = button('c-btn primary', function () { answerDestination(q, req, 'allow') })
  allow.textContent = 'Permitir'
  deny.disabled = allow.disabled = busy
  actions.appendChild(deny)
  actions.appendChild(allow)
  card.appendChild(actions)
}

/** A resposta vai pelo permRespond do app.js (POST /api/permission-respond) com o convId DO DESTINO. */
function answerDestination(q, req, behavior, answers) {
  var key = 'q:' + req.id
  if (centralUi.busy[key]) return
  centralUi.busy[key] = Date.now()
  delete centralUi.picks[q.convId + ':' + req.id]
  rerenderCentral()
  permRespond(q.convId, req.id, behavior, false, answers)
  refreshCentralSoon()
}
