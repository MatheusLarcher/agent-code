// agent-code broker — canal de suporte remoto.
//
// O exe do cliente DISCA pra cá por WebSocket (/__suporte), anuncia um código de
// 9 dígitos e espera. O Agent Code do técnico chama POST /suporte/parear com a
// chave da equipe; o broker pergunta ao exe (que pergunta ao cliente na tela) e,
// no aceite, devolve o token que o próprio exe gerou. Daí em diante as chamadas
// MCP do técnico entram por HTTP em /suporte/mcp/<sessão> e descem ao exe pelos
// mesmos frames open/data/end do relay do celular (broker.js), com a resposta
// subindo por head/data/end. Estado só em memória: código→exe e sessão→exe.
//
// Protocolo no WebSocket (frames JSON), além dos de transporte do broker.js:
//   exe→broker: {type:'hello', v, codigo, pc, sistema, versaoSistema, versao, capacidades, admin}
//   exe→broker: {type:'hello', v, retomar:{sessao, segredo}, ...}   (exe reaberto como admin)
//   broker→exe: {type:'ready', sessao?} | {type:'atualize', url} | {type:'negado', motivo}
//   broker→exe: {type:'pedido', id, tecnico} | {type:'cancelado', id}
//   exe→broker: {type:'aceite', id, ok, token?}
//   broker→exe: {type:'retomar', sessao, segredo}
//   exe→broker: {type:'evento', evento:'recurso'|'admin', recurso?, estado?}
//   qualquer lado: {type:'encerrar', motivo?}
//
// Três travas independentes: chave da equipe (aqui), código (aqui) e o clique do
// cliente (no exe). O log nunca traz conteúdo de chamada, token, chave nem código.
//
// As constantes abaixo espelham src/shared/suporteRemoto.ts (conferidas por teste).
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { bearer, enderecoDe, filtrar, igual, json, lerCorpo, limpo, send, sha256 } from './suporteUtil.js'

export const PROTOCOLO_MINIMO = 1
export const DOWNLOAD_URL = 'https://github.com/MatheusLarcher/agent-code/releases/latest/download/AgentCode-Suporte.exe'
export const CABECALHO_CHAVE = 'x-suporte-chave'
export const CHAMADA_BYTES = 32 * 1024 * 1024
export const MORTO_MS = 65_000
export const SEM_TECNICO_MS = 15 * 60_000
export const PEDIDO_ACESSO_MS = 60_000
export const CODIGO_DIGITOS = 9
export const TENTATIVAS_POR_MINUTO = 5
export const BLOQUEIO_MS = 10 * 60_000
export const MAXIMO_EXES = 50

const CAMINHO_WS = '/__suporte'
const CAMINHO_DOWNLOAD = '/suporte'
const CAMINHO_PAREAR = '/suporte/parear'
const ROTAS_SESSAO = ['/suporte/mcp', '/suporte/eventos', '/suporte/encerrar']
const ROTA_RE = /^\/suporte\/(mcp|eventos|encerrar)\/([A-Za-z0-9_-]{16,64})$/
const CODIGO_RE = new RegExp(`^\\d{${CODIGO_DIGITOS}}$`)
const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/
const RECURSOS = ['tela', 'comandos', 'arquivos', 'chrome', 'celular', 'administrador']
const ESTADOS = ['ligado', 'desligado', 'travado']
/** Cabeçalhos do técnico que não descem ao exe (a chave da equipe nunca sai daqui). */
const NAO_REPASSAR = new Set(['host', 'cookie', CABECALHO_CHAVE])
/**
 * Cria o canal de suporte. Sem `chave` (SUPORTE_KEY) o canal inteiro recusa.
 * Os tempos e limites são injetáveis para os testes.
 * Retorna { handleHttp, handleUpgrade, sweep, close, stats, exes, sessoes }.
 */
export function createSuporte({
  chave = '',
  now = Date.now,
  log = () => {},
  mortoMs = MORTO_MS,
  semTecnicoMs = SEM_TECNICO_MS,
  pedidoMs = PEDIDO_ACESSO_MS,
  headTimeoutMs = 60_000,
  chamadaBytes = CHAMADA_BYTES,
  maximoExes = MAXIMO_EXES,
  maximoPorEndereco = 5,
  tentativasPorMinuto = TENTATIVAS_POR_MINUTO,
  bloqueioMs = BLOQUEIO_MS
} = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 })
  /** Toda conexão de exe viva (com código, em sessão ou substituída). */
  const conexoes = new Set()
  /** código → exe ainda sem técnico. O código sai daqui ao parear: vale uma sessão só. */
  const exes = new Map()
  /** id da sessão → { id, segredo, tokenHash, exe, info, ouvintes } */
  const sessoes = new Map()
  /** endereço → { falhas: [instantes], ate } */
  const tentativas = new Map()
  let seq = 0

  // ---- exe (WebSocket) ----------------------------------------------------

  function handleUpgrade(req, socket, head) {
    if (req.url.split('?')[0] !== CAMINHO_WS) return false
    const endereco = enderecoDe(req)
    wss.handleUpgrade(req, socket, head, (ws) => onExe(ws, endereco))
    return true
  }

  function onExe(ws, endereco) {
    let exe = null
    const semHello = setTimeout(() => ws.terminate(), 15_000)
    ws.on('error', () => {})
    ws.on('close', () => {
      clearTimeout(semHello)
      if (exe) soltar(exe, 'caiu')
    })
    ws.once('message', (raw) => {
      clearTimeout(semHello)
      const negar = (motivo) => {
        send(ws, { type: 'negado', motivo })
        ws.close()
      }
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return negar('invalido')
      }
      if (!msg || msg.type !== 'hello') return negar('invalido')
      if (!chave) return negar('desligado')
      if (!Number.isInteger(msg.v) || msg.v < PROTOCOLO_MINIMO) {
        send(ws, { type: 'atualize', url: DOWNLOAD_URL })
        ws.close()
        return
      }
      const info = {
        pc: limpo(msg.pc, 64) || 'PC',
        sistema: limpo(msg.sistema, 32) || 'desconhecido',
        versaoSistema: limpo(msg.versaoSistema, 64),
        versao: limpo(msg.versao, 32),
        capacidades: Array.isArray(msg.capacidades) ? RECURSOS.filter((r) => msg.capacidades.includes(r)) : [],
        admin: msg.admin === true
      }
      const novo = { ws, codigo: null, info, endereco, desde: now(), lastSeen: now(), reqs: new Map(), sessao: null, pedido: null, substituido: false }
      if (msg.retomar) {
        // Exe reaberto como administrador: reassume a sessão com o segredo que só ele recebeu.
        const r = msg.retomar
        const sessao = r && typeof r.sessao === 'string' ? sessoes.get(r.sessao) : null
        if (!sessao || typeof r.segredo !== 'string' || !igual(r.segredo, sessao.segredo)) return negar('invalido')
        const antigo = sessao.exe
        antigo.sessao = null
        antigo.substituido = true // responde o que estava pendente e sai sozinho
        antigo.desde = now()
        novo.sessao = sessao
        sessao.exe = novo
        sessao.info = info
        if (info.admin) emitir(sessao, { evento: 'admin' })
        log('[suporte] sessão retomada')
      } else {
        if (typeof msg.codigo !== 'string' || !CODIGO_RE.test(msg.codigo)) return negar('invalido')
        if (exes.has(msg.codigo)) return negar('codigo')
        let doEndereco = 0
        for (const c of conexoes) if (c.endereco === endereco) doEndereco++
        if (conexoes.size >= maximoExes || doEndereco >= maximoPorEndereco) return negar('cheio')
        novo.codigo = msg.codigo
        exes.set(msg.codigo, novo)
      }
      exe = novo
      conexoes.add(exe)
      send(ws, novo.sessao ? { type: 'ready', sessao: novo.sessao.id } : { type: 'ready' })
      ws.on('message', (d) => onFrame(exe, d))
      ws.on('pong', () => {
        exe.lastSeen = now()
      })
    })
  }

  /** Tira o exe do ar: responde o que estava pendente e, se ele era o dono, acaba a sessão. */
  function soltar(exe, evento, motivo) {
    if (!conexoes.delete(exe)) return
    if (exe.codigo && exes.get(exe.codigo) === exe) exes.delete(exe.codigo)
    if (exe.pedido) exe.pedido.responder({ ok: false })
    for (const entry of exe.reqs.values()) falhar(entry, 502, 'o computador do cliente desconectou')
    exe.reqs.clear()
    if (exe.sessao && exe.sessao.exe === exe) encerrarSessao(exe.sessao, evento, motivo)
    try {
      exe.ws.terminate()
    } catch {
      /* ignore */
    }
  }

  function encerrarSessao(sessao, evento, motivo) {
    if (!sessoes.delete(sessao.id)) return
    sessao.exe.sessao = null
    emitir(sessao, motivo ? { evento, motivo } : { evento })
    for (const res of sessao.ouvintes) {
      try {
        res.end()
      } catch {
        /* ignore */
      }
    }
    sessao.ouvintes.clear()
    log(`[suporte] sessão ${evento === 'caiu' ? 'caiu' : 'encerrada'}`)
  }

  function emitir(sessao, dado) {
    const linha = `data: ${JSON.stringify(dado)}\n\n`
    for (const res of sessao.ouvintes) {
      try {
        res.write(linha)
      } catch {
        /* ignore */
      }
    }
  }

  function falhar(entry, status, texto) {
    if (entry.timer) clearTimeout(entry.timer)
    const { res } = entry
    // Resposta já começada (SSE): cortar a conexão é o erro claro; texto solto viraria lixo no fluxo.
    if (res.headersSent) res.destroy()
    else json(res, status, { erro: texto })
  }

  function onFrame(exe, raw) {
    exe.lastSeen = now()
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'ping') return send(exe.ws, { type: 'pong' })
    if (msg.type === 'aceite') {
      if (exe.pedido && String(msg.id) === exe.pedido.id) exe.pedido.responder(msg)
      return
    }
    if (msg.type === 'evento') {
      const sessao = exe.sessao
      if (!sessao) return
      if (msg.evento === 'admin') {
        sessao.info.admin = true
        emitir(sessao, { evento: 'admin' })
      } else if (msg.evento === 'recurso' && RECURSOS.includes(msg.recurso) && ESTADOS.includes(msg.estado)) {
        emitir(sessao, { evento: 'recurso', recurso: msg.recurso, estado: msg.estado })
      }
      return
    }
    if (msg.type === 'encerrar') {
      if (exe.sessao) encerrarSessao(exe.sessao, 'encerrado', 'cliente')
      return
    }
    const entry = exe.reqs.get(msg.rid)
    if (!entry) return
    const { res } = entry
    if (msg.type === 'head') {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = null
      if (!res.headersSent) {
        res.writeHead(Number(msg.status) || 200, filtrar(msg.headers))
        if (typeof res.flushHeaders === 'function') res.flushHeaders()
      }
    } else if (msg.type === 'data' && typeof msg.b64 === 'string') {
      const pedaco = Buffer.from(msg.b64, 'base64')
      entry.enviado += pedaco.length
      if (entry.enviado > chamadaBytes) {
        exe.reqs.delete(msg.rid)
        send(exe.ws, { type: 'abort', rid: msg.rid })
        return falhar(entry, 502, 'resposta grande demais')
      }
      try {
        res.write(pedaco)
      } catch {
        /* cliente foi embora */
      }
    } else if (msg.type === 'end') {
      exe.reqs.delete(msg.rid)
      try {
        res.end()
      } catch {
        /* ignore */
      }
    } else if (msg.type === 'error') {
      exe.reqs.delete(msg.rid)
      falhar(entry, 502, 'o computador do cliente não conseguiu responder')
    }
  }

  // ---- técnico (HTTP) -----------------------------------------------------

  function bloqueado(endereco) {
    const e = tentativas.get(endereco)
    return e && e.ate > now() ? e.ate - now() : 0
  }

  function falha(endereco) {
    const t = now()
    const e = tentativas.get(endereco) || { falhas: [], ate: 0 }
    e.falhas = e.falhas.filter((x) => t - x < 60_000)
    e.falhas.push(t)
    if (e.falhas.length >= tentativasPorMinuto) {
      e.ate = t + bloqueioMs
      e.falhas = []
      log('[suporte] endereço bloqueado por tentativas erradas')
    }
    if (tentativas.size > 10_000) tentativas.delete(tentativas.keys().next().value)
    tentativas.set(endereco, e)
  }

  /** Atende /suporte e /suporte/*. Devolve false para o que não é deste canal. */
  function handleHttp(req, res) {
    const caminho = new URL(req.url, 'http://x').pathname
    if (caminho !== CAMINHO_DOWNLOAD && !caminho.startsWith(CAMINHO_DOWNLOAD + '/')) return false
    if (caminho === CAMINHO_DOWNLOAD) {
      res.writeHead(302, { location: DOWNLOAD_URL, 'cache-control': 'no-store' })
      res.end()
      return true
    }
    if (!chave) {
      json(res, 503, { erro: 'desligado' })
      return true
    }
    if (caminho === CAMINHO_PAREAR) {
      void parear(req, res)
      return true
    }
    const m = ROTA_RE.exec(caminho)
    const sessao = m ? sessoes.get(m[2]) : null
    if (!m || !ROTAS_SESSAO.includes(`/suporte/${m[1]}`)) json(res, 404, { erro: 'rota' })
    else if (!sessao) json(res, 404, { erro: 'sessao' })
    else if (!bearer(req)) json(res, 401, { erro: 'token' })
    else if (m[1] === 'mcp') repassar(sessao, req, res)
    else if (!timingSafeEqual(sha256(bearer(req)), sessao.tokenHash)) json(res, 401, { erro: 'token' })
    else if (m[1] === 'eventos') eventos(sessao, req, res)
    else encerrar(sessao, req, res)
    return true
  }

  async function parear(req, res) {
    if (req.method !== 'POST') return json(res, 405, { erro: 'invalido' })
    const endereco = enderecoDe(req)
    const espera = bloqueado(endereco)
    if (espera) {
      res.setHeader('retry-after', String(Math.ceil(espera / 1000)))
      return json(res, 429, { erro: 'bloqueado', esperaSeg: Math.ceil(espera / 1000) })
    }
    const recebida = req.headers[CABECALHO_CHAVE]
    const corpo = await lerCorpo(req, 4096)
    if (typeof recebida !== 'string' || !igual(recebida, chave)) {
      falha(endereco)
      return json(res, 403, { erro: 'chave' })
    }
    let pedido = null
    try {
      pedido = corpo ? JSON.parse(corpo.toString('utf8')) : null
    } catch {
      /* cai no inválido */
    }
    const codigo = typeof pedido?.codigo === 'string' ? pedido.codigo.replace(/[\s.\-]/g, '') : ''
    const tecnico = limpo(pedido?.tecnico, 40)
    if (!CODIGO_RE.test(codigo) || !tecnico) return json(res, 400, { erro: 'invalido' })
    const exe = exes.get(codigo)
    if (!exe) {
      falha(endereco)
      return json(res, 404, { erro: 'codigo' })
    }
    if (exe.pedido || exe.sessao) return json(res, 409, { erro: 'ocupado' })

    const id = String(++seq)
    let aberto = true
    const resposta = await new Promise((resolve) => {
      const desistir = () => {
        send(exe.ws, { type: 'cancelado', id })
        resolve({ ok: false })
      }
      const timer = setTimeout(desistir, pedidoMs + 5000)
      exe.pedido = {
        id,
        responder: (m) => {
          clearTimeout(timer)
          resolve(m)
        }
      }
      res.on('close', () => {
        if (!aberto) return
        clearTimeout(timer)
        desistir()
      })
      send(exe.ws, { type: 'pedido', id, tecnico })
    })
    aberto = false
    exe.pedido = null
    const token = resposta && resposta.ok === true && typeof resposta.token === 'string' ? resposta.token : ''
    if (!TOKEN_RE.test(token) || !conexoes.has(exe)) {
      log('[suporte] recusou')
      return json(res, 403, { erro: 'recusado' })
    }
    const sessao = {
      id: randomBytes(16).toString('base64url'),
      segredo: randomBytes(32).toString('base64url'),
      tokenHash: sha256(token), // o token em si não fica guardado aqui
      exe,
      info: exe.info,
      ouvintes: new Set()
    }
    sessoes.set(sessao.id, sessao)
    exe.sessao = sessao
    exes.delete(codigo) // um técnico por código, e o código vale para uma sessão só
    send(exe.ws, { type: 'retomar', sessao: sessao.id, segredo: sessao.segredo })
    log('[suporte] pareou')
    json(res, 200, { sessao: sessao.id, token, info: sessao.info })
  }

  /** Desce a requisição HTTP ao exe e sobe a resposta (JSON ou SSE em streaming). */
  function repassar(sessao, req, res) {
    const exe = sessao.exe
    const rid = ++seq
    const entry = { res, enviado: 0, timer: null }
    const largar = () => {
      if (exe.reqs.get(rid) !== entry) return false
      if (entry.timer) clearTimeout(entry.timer)
      exe.reqs.delete(rid)
      send(exe.ws, { type: 'abort', rid })
      return true
    }
    entry.timer = setTimeout(() => {
      if (largar()) json(res, 504, { erro: 'o computador do cliente não respondeu a tempo' })
    }, headTimeoutMs)
    exe.reqs.set(rid, entry)
    send(exe.ws, { type: 'open', rid, method: req.method, url: req.url, headers: filtrar(req.headers, NAO_REPASSAR) })
    let recebido = 0
    req.on('data', (chunk) => {
      recebido += chunk.length
      if (recebido > chamadaBytes) {
        if (largar()) json(res, 413, { erro: 'chamada grande demais' })
        req.destroy()
        return
      }
      send(exe.ws, { type: 'data', rid, b64: chunk.toString('base64') })
    })
    req.on('end', () => send(exe.ws, { type: 'end', rid }))
    req.on('error', () => send(exe.ws, { type: 'abort', rid }))
    res.on('close', largar)
  }

  function eventos(sessao, req, res) {
    if (req.method !== 'GET') return json(res, 405, { erro: 'invalido' })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
    res.flushHeaders()
    res.write(`data: ${JSON.stringify({ evento: 'conectado', admin: sessao.info.admin })}\n\n`)
    sessao.ouvintes.add(res)
    res.on('close', () => sessao.ouvintes.delete(res))
  }

  function encerrar(sessao, req, res) {
    if (req.method !== 'POST') return json(res, 405, { erro: 'invalido' })
    const exe = sessao.exe
    send(exe.ws, { type: 'encerrar', motivo: 'tecnico' })
    encerrarSessao(sessao, 'encerrado', 'tecnico')
    // O código daquele exe já foi usado: ele reconecta com outro. close() entrega o frame antes.
    conexoes.delete(exe)
    for (const entry of exe.reqs.values()) falhar(entry, 502, 'a sessão foi encerrada')
    exe.reqs.clear()
    exe.ws.close()
    json(res, 200, { ok: true })
  }

  // ---- manutenção ---------------------------------------------------------

  /** Derruba exe mudo, exe sem técnico há tempo demais e mantém os fluxos vivos. */
  function sweep(agora = now()) {
    for (const exe of [...conexoes]) {
      if (agora - exe.lastSeen > mortoMs || (exe.substituido && agora - exe.desde > 60_000)) {
        soltar(exe, 'caiu')
      } else if (!exe.sessao && !exe.substituido && agora - exe.desde > semTecnicoMs) {
        send(exe.ws, { type: 'negado', motivo: 'ocioso' })
        soltar(exe, 'caiu')
      } else if (exe.ws.readyState === exe.ws.OPEN) {
        try {
          exe.ws.ping()
        } catch {
          /* ignore */
        }
      }
    }
    for (const sessao of sessoes.values()) {
      for (const res of sessao.ouvintes) {
        try {
          res.write(': vivo\n\n')
        } catch {
          /* ignore */
        }
      }
    }
    for (const [endereco, e] of tentativas) {
      if (e.ate <= agora && e.falhas.every((x) => agora - x >= 60_000)) tentativas.delete(endereco)
    }
  }

  function close() {
    for (const exe of [...conexoes]) soltar(exe, 'caiu')
    wss.close()
  }

  return { handleHttp, handleUpgrade, sweep, close, exes, sessoes, stats: () => ({ exes: conexoes.size, sessoes: sessoes.size }) }
}
