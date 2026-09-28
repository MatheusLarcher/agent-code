/**
 * Servidor HTTP local do MCP de entrada (contrato Forgia → Agent Code):
 *
 * - escuta só em 127.0.0.1, na 1ª porta livre de 47110–47149;
 * - `GET /agent-code` (sem token): identificação leve para a varredura do
 *   cliente (~300 ms de timeout por porta);
 * - `POST /mcp`: MCP Streamable HTTP 2025-06-18, sempre com resposta JSON (sem
 *   SSE). Antes de qualquer coisa: `Origin` presente → 403, `Host` estranho →
 *   403 (DNS rebinding), token errado → 401 — nada executa sem passar pelos três.
 *
 * O JSON-RPC é escrito à mão (só node:http): o SDK do MCP não é dependência
 * direta do app e o `main` empacotado não o levaria.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  MCP_INBOUND_PORT_COUNT,
  MCP_INBOUND_PORT_START,
  MCP_INBOUND_TOKEN,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME
} from './mcpConstants'

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Resultado de uma ferramenta: o objeto vira `structuredContent` e texto JSON. */
export interface McpToolResult {
  value: Record<string, unknown>
  isError?: boolean
}

export interface McpToolsApi {
  list(): McpToolDefinition[]
  /** `null`: ferramenta desconhecida (erro de protocolo, não de ferramenta). */
  call(name: string, args: unknown): Promise<McpToolResult | null>
}

export interface McpReadiness {
  pronto: boolean
  motivo: null | 'login'
}

export interface McpHttpServerDeps {
  version: string
  readiness: () => McpReadiness
  /** Campos a mais do `GET /agent-code` (recursos, modelos). Leve: a varredura
   *  do cliente espera ~300 ms (quem implementa limita a própria espera). Não
   *  sobrescreve os campos base. */
  info?: () => Record<string, unknown> | Promise<Record<string, unknown>>
  tools: McpToolsApi
  token?: string
  portStart?: number
  portCount?: number
  log?: (line: string) => void
}

/** Cabe o maior `agent_code_enviar` válido: 4 imagens de 5 MB em base64 (~27 MB)
 *  + prompt de até 500 mil caracteres. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: unknown
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest()

/** Compara o `Authorization` em tempo constante (hash dos dois lados: mesmo tamanho sempre). */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? '')
  if (!m) return false
  return timingSafeEqual(sha256(m[1].trim()), sha256(token))
}

/** `Host` aceito: só o loopback, na porta em que o servidor está. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false
  const h = host.trim().toLowerCase()
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
    'Cache-Control': 'no-store',
    ...headers
  })
  res.end(text)
}

function sendEmpty(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, headers)
  res.end()
}

function rpcError(id: JsonRpcRequest['id'], code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('corpo grande demais'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Escuta em `host`, da porta `start` em diante, até `attempts` portas. Porta
 * ocupada (EADDRINUSE) ou reservada pelo Windows/Hyper-V (EACCES) → a seguinte.
 */
export function listenInRange(server: Server, host: string, start: number, attempts: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = start
    const tryPort = (): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.off('listening', onListening)
        if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && port < start + attempts - 1) {
          port++
          tryPort()
        } else reject(err)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve(port)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    }
    tryPort()
  })
}

export class McpHttpServer {
  private server: Server | null = null
  private boundPort = 0
  private readonly sessions = new Set<string>()
  private readonly token: string

  constructor(private readonly deps: McpHttpServerDeps) {
    this.token = deps.token ?? MCP_INBOUND_TOKEN
  }

  get port(): number {
    return this.boundPort
  }

  async start(): Promise<number> {
    if (this.server) return this.boundPort
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.deps.log?.(`[mcp-inbound] erro: ${err instanceof Error ? err.message : String(err)}`)
        if (!res.headersSent) sendJson(res, 500, rpcError(null, -32603, 'Erro interno'))
        else res.end()
      })
    })
    this.boundPort = await listenInRange(
      server,
      '127.0.0.1',
      this.deps.portStart ?? MCP_INBOUND_PORT_START,
      this.deps.portCount ?? MCP_INBOUND_PORT_COUNT
    )
    this.server = server
    return this.boundPort
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.sessions.clear()
    if (!server) return
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    // Conexão keep-alive de um cliente seguraria o close até o timeout dela.
    server.closeAllConnections()
    await closed
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/agent-code') {
      if (req.method !== 'GET') return sendEmpty(res, 405, { Allow: 'GET' })
      const { pronto, motivo } = this.deps.readiness()
      const base: Record<string, unknown> = { app: 'agent-code', versao: this.deps.version, mcp: '/mcp', pronto, motivo }
      let extra: Record<string, unknown> = {}
      try {
        extra = (await this.deps.info?.()) ?? {}
      } catch (err) {
        // A identificação não pode cair por causa dos extras: sai sem eles.
        this.deps.log?.(`[mcp-inbound] info do GET falhou: ${err instanceof Error ? err.message : String(err)}`)
      }
      for (const [k, v] of Object.entries(extra)) if (!(k in base)) base[k] = v
      return sendJson(res, 200, base)
    }
    if (path !== '/mcp') return sendJson(res, 404, { erro: 'não encontrado' })
    // Página web (qualquer Origin) e DNS rebinding (Host de outro nome) ficam de
    // fora ANTES do token: o token é público, estas duas checagens não.
    if (req.headers.origin !== undefined) return sendJson(res, 403, { erro: 'Origin não é aceito' })
    if (!hostAllowed(req.headers.host, this.boundPort)) return sendJson(res, 403, { erro: 'Host não é aceito' })
    if (req.method === 'GET') return sendEmpty(res, 405, { Allow: 'POST, DELETE' })
    if (!bearerMatches(req.headers.authorization, this.token)) return sendJson(res, 401, { erro: 'token inválido' })
    if (req.method === 'DELETE') {
      const sid = req.headers['mcp-session-id']
      if (typeof sid === 'string') this.sessions.delete(sid)
      return sendEmpty(res, 204)
    }
    if (req.method !== 'POST') return sendEmpty(res, 405, { Allow: 'POST, DELETE' })

    let msg: JsonRpcRequest
    try {
      msg = JSON.parse(await readBody(req)) as JsonRpcRequest
    } catch {
      return sendJson(res, 400, rpcError(null, -32700, 'JSON inválido'))
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') {
      return sendJson(res, 400, rpcError(null, -32600, 'Requisição JSON-RPC inválida'))
    }
    // Notificação (sem id): nada a responder.
    if (msg.id === undefined) return sendEmpty(res, 202)
    await this.respond(msg, res)
  }

  private async respond(msg: JsonRpcRequest, res: ServerResponse): Promise<void> {
    const ok = (result: unknown, headers: Record<string, string> = {}): void =>
      sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result }, headers)
    switch (msg.method) {
      case 'initialize': {
        // Sessão só identifica o cliente; o token é quem autoriza. Não se exige o
        // cabeçalho depois: reiniciado o app, o cliente segue sem um 404 no meio.
        const sid = randomUUID()
        this.sessions.add(sid)
        return ok(
          {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: MCP_SERVER_NAME, version: this.deps.version }
          },
          { 'Mcp-Session-Id': sid }
        )
      }
      case 'ping':
        return ok({})
      case 'tools/list':
        return ok({ tools: this.deps.tools.list() })
      case 'tools/call': {
        const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown }
        if (typeof params.name !== 'string') return sendJson(res, 200, rpcError(msg.id, -32602, 'name obrigatório'))
        const out = await this.deps.tools.call(params.name, params.arguments ?? {})
        if (!out) return sendJson(res, 200, rpcError(msg.id, -32602, `Ferramenta desconhecida: ${params.name}`))
        return ok({
          content: [{ type: 'text', text: JSON.stringify(out.value) }],
          structuredContent: out.value,
          ...(out.isError ? { isError: true } : {})
        })
      }
      default:
        return sendJson(res, 200, rpcError(msg.id, -32601, `Método não suportado: ${msg.method}`))
    }
  }
}
