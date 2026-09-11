// RelayClient — liga o PC ao broker (VPS) por um WebSocket DE SAÍDA, para o
// controle remoto funcionar fora da LAN sem abrir porta nem usar senha de VPS.
//
// O PC disca pro broker e se registra com o seu token. O broker manda, por frames,
// as requests do celular; o RelayClient as repassa ao RemoteServer LOCAL
// (127.0.0.1:porta) — reaproveitando 100% a lógica/auth existente — e devolve a
// resposta (incl. SSE em streaming) em frames. Reconecta sozinho com backoff.
//
// Conexão "meio-aberta" é o inimigo aqui: depois de um sleep ou troca de Wi‑Fi o
// socket TCP pode ficar OPEN por minutos sem ninguém do outro lado. Por isso há um
// heartbeat de aplicação (`ping`/`pong` em JSON, além do ping WS do broker) e um
// relógio de "última vida": silêncio acima de `DEAD_AFTER_MS` derruba o socket e
// reconecta — sem isso a UI diz "acesso remoto pronto" e o celular só vê 503/504.
import WebSocket from 'ws'
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from 'node:http'

/** Estado da ligação com o broker, como a UI mostra. */
export type RelayState = 'off' | 'connecting' | 'connected' | 'busy' | 'denied'

export interface RelayClientDeps {
  /** URL do broker, ex.: wss://agent-code.larchertech.com/__relay */
  brokerUrl: string
  /** Chave opcional p/ autorizar o uso do broker (o token é a auth real). */
  relayKey?: string
  /** Token fixo desta instalação (o mesmo que o RemoteServer exige). */
  getToken: () => string
  /** Identidade estável desta instalação — o broker usa para distinguir "o mesmo
   *  PC reconectando" (substitui) de "outro PC com o mesmo token" (recusa). */
  getInstanceId?: () => string
  /** Porta do RemoteServer local (pode variar por fallback). */
  getPort: () => number
  /** Notifica mudança de status (conectado ao broker?). */
  onStatus?: (connected: boolean, state: RelayState) => void
  /** Log opcional de diagnóstico. */
  log?: (line: string) => void
}

interface OpenFrame {
  type: 'open'
  rid: number
  method: string
  url: string
  headers: Record<string, string>
}

/** Intervalo do nosso ping de aplicação. */
export const PING_INTERVAL_MS = 20_000
/** Sem NENHUM sinal do broker por este tempo = socket morto. */
export const DEAD_AFTER_MS = 65_000
/** `hello` sem `ready` dentro deste prazo = tentar de novo. */
export const HELLO_TIMEOUT_MS = 15_000
/** Enquanto outro PC é o dono do token, espera-se mais entre tentativas. */
export const BUSY_RETRY_MS = 30_000

export class RelayClient {
  private ws: WebSocket | null = null
  private stopped = true
  private state: RelayState = 'off'
  private backoff = 1000
  private timer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private helloTimer: ReturnType<typeof setTimeout> | null = null
  private lastSeen = 0
  /** rid -> request HTTP local em andamento. */
  private reqs = new Map<number, ClientRequest>()

  constructor(private readonly deps: RelayClientDeps) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.backoff = 1000
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.abortAll()
    this.closeSocket()
    this.setState('off')
  }

  /** Derruba a conexão atual (se houver) e reconecta já — usado ao acordar do
   *  sleep ou quando a rede volta: o socket antigo quase sempre está morto. */
  kick(): void {
    if (this.stopped) return
    this.deps.log?.('relay: reconexão forçada')
    this.closeSocket()
    this.abortAll()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.backoff = 1000
    this.connect()
  }

  isConnected(): boolean {
    return this.state === 'connected'
  }

  getState(): RelayState {
    return this.state
  }

  private setState(next: RelayState): void {
    if (this.state === next) return
    this.state = next
    this.deps.onStatus?.(next === 'connected', next)
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.helloTimer) clearTimeout(this.helloTimer)
    this.timer = null
    this.heartbeat = null
    this.helloTimer = null
  }

  private closeSocket(): void {
    const ws = this.ws
    this.ws = null
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.helloTimer) clearTimeout(this.helloTimer)
    this.heartbeat = null
    this.helloTimer = null
    if (!ws) return
    ws.removeAllListeners()
    try {
      ws.terminate()
    } catch {
      /* ignore */
    }
  }

  private abortAll(): void {
    for (const req of this.reqs.values()) {
      try {
        req.destroy()
      } catch {
        /* ignore */
      }
    }
    this.reqs.clear()
  }

  private connect(): void {
    if (this.stopped || this.ws) return
    const token = this.deps.getToken()
    if (!token) {
      this.scheduleReconnect()
      return
    }
    let ws: WebSocket
    try {
      ws = new WebSocket(this.deps.brokerUrl, { handshakeTimeout: HELLO_TIMEOUT_MS })
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    this.setState('connecting')
    this.lastSeen = Date.now()
    ws.on('open', () => {
      this.sendTo(ws, {
        type: 'hello',
        token,
        relayKey: this.deps.relayKey || undefined,
        instanceId: this.deps.getInstanceId?.() || undefined
      })
      // `ready` precisa chegar — senão o broker (ou um proxy no meio) aceitou o
      // socket mas não está roteando; melhor recomeçar do que esperar em silêncio.
      this.helloTimer = setTimeout(() => {
        if (this.ws === ws && this.state !== 'connected') {
          this.deps.log?.('relay: sem ready do broker, reconectando')
          this.dropAndRetry(ws)
        }
      }, HELLO_TIMEOUT_MS)
    })
    ws.on('message', (raw: WebSocket.RawData) => {
      this.lastSeen = Date.now()
      this.onFrame(ws, raw.toString())
    })
    ws.on('ping', () => {
      this.lastSeen = Date.now()
    })
    ws.on('pong', () => {
      this.lastSeen = Date.now()
    })
    ws.on('error', (e: Error) => {
      this.deps.log?.(`relay: erro no socket: ${e.message}`)
    })
    ws.on('close', () => {
      if (this.ws !== ws) return
      this.dropAndRetry(ws)
    })
  }

  private dropAndRetry(ws: WebSocket, retryIn?: number): void {
    if (this.ws === ws) this.closeSocket()
    this.abortAll()
    if (this.state !== 'busy' && this.state !== 'denied') this.setState(this.stopped ? 'off' : 'connecting')
    this.scheduleReconnect(retryIn)
  }

  private startHeartbeat(ws: WebSocket): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = setInterval(() => {
      if (this.ws !== ws) return
      if (Date.now() - this.lastSeen > DEAD_AFTER_MS) {
        this.deps.log?.('relay: broker mudo, derrubando a conexão')
        this.dropAndRetry(ws)
        return
      }
      this.sendTo(ws, { type: 'ping' })
      try {
        ws.ping()
      } catch {
        /* ignore */
      }
    }, PING_INTERVAL_MS)
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref()
  }

  private scheduleReconnect(delayOverride?: number): void {
    if (this.stopped || this.timer) return
    const delay = delayOverride ?? this.backoff
    if (delayOverride == null) this.backoff = Math.min(this.backoff * 2, 30_000)
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect()
    }, delay)
  }

  private onFrame(ws: WebSocket, raw: string): void {
    let msg: { type?: string; rid?: number; b64?: string; method?: string; url?: string; headers?: Record<string, string> }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    switch (msg.type) {
      case 'ready':
        this.backoff = 1000
        if (this.helloTimer) clearTimeout(this.helloTimer)
        this.helloTimer = null
        this.setState('connected')
        this.startHeartbeat(ws)
        return
      case 'pong':
        return
      case 'denied':
        // relayKey errado — não adianta martelar; para até reiniciar a ponte.
        this.deps.log?.('relay: broker recusou a chave')
        this.stop()
        this.setState('denied')
        return
      case 'busy':
        // Outro PC é o dono deste token no broker. Não há o que fazer daqui — o
        // celular está falando com o primeiro PC. Fica tentando devagar: quando
        // aquele PC desligar, este assume.
        this.deps.log?.('relay: outro PC já está registrado com este token')
        this.setState('busy')
        this.dropAndRetry(ws, BUSY_RETRY_MS)
        return
      case 'open':
        this.openLocal(ws, msg as OpenFrame)
        return
      case 'data': {
        const req = this.reqs.get(msg.rid as number)
        if (req && msg.b64 != null) req.write(Buffer.from(msg.b64, 'base64'))
        return
      }
      case 'end': {
        const req = this.reqs.get(msg.rid as number)
        if (req) req.end()
        return
      }
      case 'abort': {
        const req = this.reqs.get(msg.rid as number)
        if (req) {
          try {
            req.destroy()
          } catch {
            /* ignore */
          }
          this.reqs.delete(msg.rid as number)
        }
        return
      }
      default:
        return
    }
  }

  private openLocal(ws: WebSocket, msg: OpenFrame): void {
    const port = this.deps.getPort()
    const headers: Record<string, string> = { ...msg.headers, host: `127.0.0.1:${port}` }
    const req = httpRequest(
      { host: '127.0.0.1', port, method: msg.method, path: msg.url, headers },
      (res) => {
        this.sendTo(ws, { type: 'head', rid: msg.rid, status: res.statusCode ?? 502, headers: res.headers as IncomingHttpHeaders })
        res.on('data', (chunk: Buffer) => this.sendTo(ws, { type: 'data', rid: msg.rid, b64: chunk.toString('base64') }))
        res.on('end', () => {
          this.reqs.delete(msg.rid)
          this.sendTo(ws, { type: 'end', rid: msg.rid })
        })
        res.on('error', () => {
          this.reqs.delete(msg.rid)
          this.sendTo(ws, { type: 'error', rid: msg.rid, message: 'res error' })
        })
      }
    )
    req.on('error', (e: Error) => {
      this.reqs.delete(msg.rid)
      this.sendTo(ws, { type: 'error', rid: msg.rid, message: e.message })
    })
    this.reqs.set(msg.rid, req)
    // O corpo (se houver) chega via frames 'data'/'end'. Para GET, o broker manda
    // 'end' logo em seguida, finalizando a request.
  }

  private sendTo(ws: WebSocket, obj: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(obj))
      } catch {
        /* ignore */
      }
    }
  }
}
