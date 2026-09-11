// agent-code broker — relay de acesso remoto multiusuário, roteado por token.
//
// O PC (desktop) DISCA pra cá por WebSocket (/__relay) e se registra com o seu
// token. O celular faz HTTP normal em https://host/...?token=XYZ; o broker acha o
// PC com aquele token e encapsula a request em frames JSON, devolvendo a resposta
// (incluindo SSE em streaming) pro celular. Stateless: o estado é só o mapa
// token→conexão, em memória. Sem DB.
//
// Protocolo (frames JSON):
//   PC→broker:  {type:'hello', token, relayKey?, instanceId?}
//   broker→PC:  {type:'ready'} | {type:'denied'} | {type:'busy'}
//   broker→PC:  {type:'open', rid, method, url, headers}
//   broker→PC:  {type:'data', rid, b64} | {type:'end', rid} | {type:'abort', rid}
//   PC→broker:  {type:'head', rid, status, headers}
//   PC→broker:  {type:'data', rid, b64} | {type:'end', rid} | {type:'error', rid, message}
//   PC→broker:  {type:'ping'}  →  broker→PC: {type:'pong'}   (heartbeat de aplicação)
//
// Regras de posse do token:
//   - "O primeiro PC vence": um PC com `instanceId` DIFERENTE do dono atual recebe
//     `busy` e é desligado — o celular continua indo pro PC original. Só quando o
//     dono cai (close ou heartbeat perdido) o token fica livre para outro.
//   - O MESMO PC (mesmo instanceId) reconectando substitui a conexão antiga na
//     hora — é o caso comum depois de sleep/troca de rede, quando o socket velho
//     ainda não foi detectado como morto.
//   - Sem instanceId (cliente antigo) vale a regra antiga: o novo substitui.
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

// Cabeçalhos hop-by-hop não devem ser repassados num proxy.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer'
])

/** Intervalo do ping WS do broker → PC. */
export const PING_INTERVAL_MS = 25_000
/** PC que não responde nenhum pong/frame por este tempo é dado como morto. */
export const HOST_DEAD_MS = 70_000
/** Tempo máximo esperando o PC começar a responder (frame `head`) uma request. */
export const HEAD_TIMEOUT_MS = 60_000
/** Corpo máximo aceito do celular (imagens em base64 ficam bem abaixo disso). */
export const MAX_BODY_BYTES = 32 * 1024 * 1024

function filterHeaders(headers, drop = []) {
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = k.toLowerCase()
    if (HOP_BY_HOP.has(lk) || drop.includes(lk) || v == null) continue
    out[k] = v
  }
  return out
}

function readCookie(req, name) {
  const raw = req.headers.cookie
  if (!raw) return ''
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return ''
}

function plain(res, status, text) {
  try {
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text)
  } catch {
    /* client gone */
  }
}

/**
 * Cria o broker. `relayKey` (opcional): se definido, só aceita PCs que mandem o
 * mesmo valor no `hello` (porta de entrada anti-abuso; o token do app é a auth
 * real). `now` é injetável para os testes de heartbeat.
 * Retorna { server, wss, hosts, listen, close, stats, sweep }.
 */
export function createBroker({ relayKey = '', pingIntervalMs = PING_INTERVAL_MS, hostDeadMs = HOST_DEAD_MS, headTimeoutMs = HEAD_TIMEOUT_MS } = {}) {
  /** token -> { ws, instanceId, reqs: Map(rid -> {res, timer}), lastSeen } */
  const hosts = new Map()
  let ridSeq = 0

  const server = createServer(handleHttp)
  const wss = new WebSocketServer({ server, path: '/__relay', maxPayload: 64 * 1024 * 1024 })

  wss.on('connection', (ws) => {
    let token = null
    let host = null
    ws.once('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        ws.close()
        return
      }
      if (msg.type !== 'hello' || typeof msg.token !== 'string' || !msg.token) {
        ws.close()
        return
      }
      if (relayKey && msg.relayKey !== relayKey) {
        send(ws, { type: 'denied' })
        ws.close()
        return
      }
      token = msg.token
      const instanceId = typeof msg.instanceId === 'string' && msg.instanceId ? msg.instanceId : ''
      const prev = hosts.get(token)
      if (prev && prev.ws !== ws) {
        const samePc = !instanceId || !prev.instanceId || prev.instanceId === instanceId
        if (!samePc) {
          // Outro PC com o mesmo token: o primeiro continua sendo o dono.
          send(ws, { type: 'busy' })
          ws.close()
          return
        }
        dropHost(prev, token)
      }
      host = { ws, instanceId, reqs: new Map(), lastSeen: Date.now() }
      hosts.set(token, host)
      send(ws, { type: 'ready' })
      ws.on('message', (d) => onHostFrame(host, d))
      ws.on('pong', () => {
        host.lastSeen = Date.now()
      })
    })
    ws.on('close', () => {
      if (host && hosts.get(token) === host) dropHost(host, token)
    })
  })

  /** Encerra o PC dono de `token`: responde 502 ao que estava pendente e fecha o WS. */
  function dropHost(host, token) {
    if (hosts.get(token) === host) hosts.delete(token)
    for (const { res, timer } of host.reqs.values()) {
      if (timer) clearTimeout(timer)
      plain(res, 502, 'o PC desconectou durante a requisição')
    }
    host.reqs.clear()
    try {
      host.ws.terminate()
    } catch {
      /* ignore */
    }
  }

  function onHostFrame(host, raw) {
    host.lastSeen = Date.now()
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg.type === 'ping') {
      send(host.ws, { type: 'pong' })
      return
    }
    const entry = host.reqs.get(msg.rid)
    if (!entry) return
    const { res } = entry
    if (msg.type === 'head') {
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      if (!res.headersSent) {
        res.writeHead(msg.status || 200, filterHeaders(msg.headers))
        // SSE precisa dos headers na rede já, antes do 1º evento.
        if (typeof res.flushHeaders === 'function') res.flushHeaders()
      }
    } else if (msg.type === 'data') {
      try {
        res.write(Buffer.from(msg.b64, 'base64'))
      } catch {
        /* client gone */
      }
    } else if (msg.type === 'end') {
      host.reqs.delete(msg.rid)
      try {
        res.end()
      } catch {
        /* ignore */
      }
    } else if (msg.type === 'error') {
      host.reqs.delete(msg.rid)
      plain(res, 502, 'relay error')
    }
  }

  function handleHttp(req, res) {
    const url = new URL(req.url, 'http://x')
    const fromQuery = url.searchParams.get('token')
    const token = fromQuery || readCookie(req, 'relay_token')
    if (!token) return plain(res, 400, 'token ausente')
    const host = hosts.get(token)
    if (!host) return plain(res, 503, 'nenhum PC conectado com esse token')
    const rid = ++ridSeq
    const entry = {
      res,
      // Se o PC não começar a responder a tempo, o celular recebe um erro claro em
      // vez de ficar pendurado (o PC pode ter morrido sem o WS fechar ainda).
      timer: setTimeout(() => {
        if (host.reqs.get(rid) !== entry) return
        host.reqs.delete(rid)
        send(host.ws, { type: 'abort', rid })
        plain(res, 504, 'o PC não respondeu a tempo')
      }, headTimeoutMs)
    }
    host.reqs.set(rid, entry)
    // Lembra o token num cookie p/ sub-requests sem ?token= (fallback do navegador).
    if (fromQuery) {
      res.setHeader('Set-Cookie', `relay_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`)
    }
    const headers = filterHeaders(req.headers, ['host'])
    send(host.ws, { type: 'open', rid, method: req.method, url: req.url, headers })
    let received = 0
    req.on('data', (chunk) => {
      received += chunk.length
      if (received > MAX_BODY_BYTES) {
        if (host.reqs.get(rid) === entry) {
          clearTimeout(entry.timer)
          host.reqs.delete(rid)
          send(host.ws, { type: 'abort', rid })
        }
        plain(res, 413, 'corpo grande demais')
        req.destroy()
        return
      }
      send(host.ws, { type: 'data', rid, b64: chunk.toString('base64') })
    })
    req.on('end', () => send(host.ws, { type: 'end', rid }))
    req.on('error', () => send(host.ws, { type: 'abort', rid }))
    res.on('close', () => {
      const cur = host.reqs.get(rid)
      if (cur === entry) {
        if (entry.timer) clearTimeout(entry.timer)
        host.reqs.delete(rid)
        send(host.ws, { type: 'abort', rid })
      }
    })
  }

  function send(ws, obj) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(obj))
      } catch {
        /* ignore */
      }
    }
  }

  /** Pinga todo PC e derruba os que ficaram mudos por mais de `hostDeadMs`. */
  function sweep(now = Date.now()) {
    for (const [token, host] of hosts) {
      if (now - host.lastSeen > hostDeadMs) {
        dropHost(host, token)
        continue
      }
      if (host.ws.readyState === host.ws.OPEN) {
        try {
          host.ws.ping()
        } catch {
          /* ignore */
        }
      }
    }
  }

  // Mantém conexões vivas (Cloudflare/Nginx cortam WS ocioso) e detecta as mortas.
  const ping = setInterval(() => sweep(), pingIntervalMs)
  if (ping.unref) ping.unref()

  return {
    server,
    wss,
    hosts,
    sweep,
    listen: (port, cb) => server.listen(port, cb),
    close: () =>
      new Promise((resolve) => {
        clearInterval(ping)
        for (const [token, host] of hosts) dropHost(host, token)
        wss.close(() => server.close(() => resolve()))
      }),
    stats: () => ({ hosts: hosts.size })
  }
}
