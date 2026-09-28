import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import {
  CHROME_BRIDGE_PORTS,
  CLOSE_AUTH_FAILED,
  ERR_NOT_CONNECTED,
  ERR_TIMEOUT,
  HELLO_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  type ServerToExtension
} from './protocol'

export interface ChromeBridgeOptions {
  extensionId: string
  token: string
  /** Versão esperada da extensão (manifest.version), devolvida no welcome. */
  version: string
  ports?: readonly number[]
  helloTimeoutMs?: number
}

export interface ChromeBridgeStatus {
  listening: boolean
  port: number | null
  connected: boolean
  extensionVersion: string | null
  userAgent: string | null
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

/** Servidor WebSocket local (127.0.0.1) que a extensão do Chrome conecta. Emite 'status'. */
export class ChromeBridge extends EventEmitter {
  private wss: WebSocketServer | null = null
  private port: number | null = null
  private active: WebSocket | null = null
  private extVersion: string | null = null
  private userAgent: string | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private readonly ports: readonly number[]
  private readonly helloTimeoutMs: number

  constructor(private readonly opts: ChromeBridgeOptions) {
    super()
    this.ports = opts.ports ?? CHROME_BRIDGE_PORTS
    this.helloTimeoutMs = opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS
  }

  async start(): Promise<number> {
    if (this.wss && this.port !== null) return this.port
    for (const port of this.ports) {
      const wss = await this.tryListen(port)
      if (wss) {
        this.wss = wss
        this.port = port
        wss.on('connection', (ws) => this.onConnection(ws))
        this.emitStatus()
        return port
      }
    }
    throw new Error(`Nenhuma porta livre para a ponte Chrome: ${this.ports.join(', ')}`)
  }

  async stop(): Promise<void> {
    const wss = this.wss
    this.wss = null
    this.port = null
    this.dropActive()
    if (wss) {
      for (const c of wss.clients) c.terminate()
      await new Promise<void>((r) => wss.close(() => r()))
    }
    this.emitStatus()
  }

  getStatus(): ChromeBridgeStatus {
    return {
      listening: this.wss !== null,
      port: this.port,
      connected: this.active !== null,
      extensionVersion: this.extVersion,
      userAgent: this.userAgent
    }
  }

  call(method: string, params: unknown = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const ws = this.active
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(ERR_NOT_CONNECTED))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(ERR_TIMEOUT))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.send(ws, { type: 'req', id, method, params })
    })
  }

  private tryListen(port: number): Promise<WebSocketServer | null> {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({
        host: '127.0.0.1',
        port,
        maxPayload: 32 * 1024 * 1024,
        verifyClient: (info: { req: IncomingMessage }) =>
          info.req.headers.origin === `chrome-extension://${this.opts.extensionId}`
      })
      const onError = (): void => {
        wss.close()
        resolve(null)
      }
      wss.once('error', onError)
      wss.once('listening', () => {
        wss.off('error', onError)
        wss.on('error', () => undefined)
        resolve(wss)
      })
    })
  }

  private onConnection(ws: WebSocket): void {
    let authed = false
    const helloTimer = setTimeout(() => {
      if (!authed) ws.close(CLOSE_AUTH_FAILED, 'hello timeout')
    }, this.helloTimeoutMs)

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(raw.toString())
        if (!parsed || typeof parsed !== 'object') return
        msg = parsed as Record<string, unknown>
      } catch {
        return
      }
      if (!authed) {
        if (msg.type !== 'hello' || msg.token !== this.opts.token) {
          clearTimeout(helloTimer)
          ws.close(CLOSE_AUTH_FAILED, 'unauthorized')
          return
        }
        authed = true
        clearTimeout(helloTimer)
        this.accept(ws, msg)
        return
      }
      if (ws !== this.active) return
      if (msg.type === 'ping') this.send(ws, { type: 'pong' })
      else if (msg.type === 'res') this.onResponse(msg)
    })

    ws.on('close', () => {
      clearTimeout(helloTimer)
      if (ws === this.active) {
        this.active = null
        this.rejectAll()
        this.emitStatus()
      }
    })
    ws.on('error', () => undefined)
  }

  private accept(ws: WebSocket, hello: Record<string, unknown>): void {
    if (this.active && this.active !== ws) this.dropActive()
    this.active = ws
    this.extVersion = typeof hello.version === 'string' ? hello.version : null
    this.userAgent = typeof hello.userAgent === 'string' ? hello.userAgent : null
    this.send(ws, { type: 'welcome', version: this.opts.version })
    this.emitStatus()
  }

  private onResponse(msg: Record<string, unknown>): void {
    if (typeof msg.id !== 'number') return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.ok === true) p.resolve(msg.result)
    else p.reject(new Error(typeof msg.error === 'string' ? msg.error : 'Erro desconhecido'))
  }

  private dropActive(): void {
    const old = this.active
    this.active = null
    this.rejectAll()
    if (old) old.close(1000, 'replaced')
  }

  private rejectAll(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(ERR_NOT_CONNECTED))
    }
    this.pending.clear()
  }

  private send(ws: WebSocket, msg: ServerToExtension): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus())
  }
}
