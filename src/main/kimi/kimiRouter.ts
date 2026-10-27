/**
 * Roteador local do Kimi. A sessão Kimi do app aponta o CLI para cá
 * (`ANTHROPIC_BASE_URL=http://127.0.0.1:<porta>/<segredo>`). O CLI continua
 * logado na conta Claude da conversa; o roteador manda ao Kimi Code só os pedidos
 * com modelo Kimi (trocando a credencial pela chave do Kimi) e repassa todo o
 * resto à Anthropic intacto. Regras e resultado da sonda em kimiRouterRules.ts.
 *
 * Nunca: credencial da Anthropic para o Kimi, chave do Kimi para a Anthropic,
 * modelo Kimi para a Anthropic. A chave do Kimi não entra no ambiente do CLI:
 * é lida da config a cada pedido. Só ouve 127.0.0.1, e o segredo no caminho
 * barra qualquer outro processo (pedido sem o segredo → 404).
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { insertOrgInstructionsInBody } from '../orgInstructions'
import { translateKimiError } from './kimiErrors'
import { kimiCodingBase, type KimiRegion } from './kimiIdentity'
import { notifyKimiAuxReserve } from './kimiSession'
import {
  anthropicHeaders,
  auxReserveBody,
  claudeUnavailable,
  hasClaudeCredential,
  hoistInlineTools,
  kimiHeaders,
  redactHeaders,
  routeFor
} from './kimiRouterRules'

const MAX_REQUEST_BYTES = 32 * 1024 * 1024
const ANTHROPIC_BASE = 'https://api.anthropic.com'
/** Depois de uma falha de cota/credencial do Claude, quanto tempo os auxiliares vão direto ao Kimi. */
const CLAUDE_OUT_MS = 5 * 60_000

export interface KimiRouterCredential {
  apiKey: string
  region: KimiRegion
  contextWindow: number
  orgInstructions: string
}

export interface KimiRouterDeps {
  /** Credencial atual (null = Kimi desligado/sem chave). Lida a cada pedido. */
  credential: () => KimiRouterCredential | null
  secret: string
  /** Upstreams injetáveis (testes). */
  anthropicBase?: string
  kimiBase?: (region: KimiRegion) => string
  fetchImpl?: typeof fetch
  log?: (line: string) => void
  /** Pasta do registro (KIMI_ROUTER_LOG): um JSON por pedido, credenciais redigidas. */
  logDir?: string
  /** Avisado quando um auxiliar do CLI cai na reserva do Kimi (por sessão do CLI). */
  onAuxReserve?: (sessionId: string) => void
  now?: () => number
}

export interface KimiRouterHandle {
  port: number
  close: () => Promise<void>
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > MAX_REQUEST_BYTES) throw new Error('corpo do pedido grande demais')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

function sendError(response: ServerResponse, status: number, type: string, message: string): void {
  if (response.headersSent) {
    response.end()
    return
  }
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ type: 'error', error: { type, message } }))
}

const SKIP_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection'])

async function pipeUpstream(response: ServerResponse, upstream: Response): Promise<void> {
  const headers: Record<string, string> = {}
  upstream.headers.forEach((v, k) => {
    if (!SKIP_RESPONSE_HEADERS.has(k.toLowerCase())) headers[k] = v
  })
  response.writeHead(upstream.status, headers)
  if (!upstream.body) return void response.end()
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(upstream.body as never).on('error', reject).pipe(response).on('finish', resolve).on('error', reject)
  })
}

export function startKimiRouterServer(deps: KimiRouterDeps): Promise<KimiRouterHandle> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const anthropicBase = deps.anthropicBase ?? ANTHROPIC_BASE
  const kimiBase = deps.kimiBase ?? kimiCodingBase
  const now = deps.now ?? Date.now
  const prefix = `/${deps.secret}`
  let claudeOutUntil = 0
  let seq = 0

  const record = (entry: Record<string, unknown>): void => {
    if (!deps.logDir) return
    try {
      mkdirSync(deps.logDir, { recursive: true })
      const n = String(++seq).padStart(4, '0')
      writeFileSync(join(deps.logDir, `${n}-${String(entry.route)}.json`), JSON.stringify(entry, null, 2))
      appendFileSync(join(deps.logDir, 'index.jsonl'), JSON.stringify({ n, route: entry.route, model: entry.model, status: entry.status }) + '\n')
    } catch (err) {
      deps.log?.(`kimi router: falha ao gravar o registro: ${String(err)}`)
    }
  }

  const toKimi = async (
    request: IncomingMessage, response: ServerResponse, path: string, body: Record<string, unknown>, cred: KimiRouterCredential, route: string
  ): Promise<void> => {
    const hoisted = hoistInlineTools(body)
    const inserted = insertOrgInstructionsInBody(body, cred.orgInstructions)
    if (cred.orgInstructions.trim() && !inserted && path.endsWith('/messages')) {
      deps.log?.('kimi router: instruções da organização sem âncora no prompt de sistema; não inseridas')
    }
    const text = JSON.stringify(body)
    const headers = kimiHeaders(request.headers, cred.apiKey)
    const upstream = await fetchImpl(`${kimiBase(cred.region)}${path}`, { method: 'POST', headers, body: text })
    record({ route, path, model: body.model, status: upstream.status, orgInstructions: inserted, inlineToolsHoisted: hoisted, headers: redactHeaders(headers), body })
    if (!upstream.ok) {
      const raw = await upstream.text()
      const translated = translateKimiError(upstream.status, raw, cred.contextWindow, Buffer.byteLength(text))
      response.writeHead(translated?.status ?? upstream.status, { 'content-type': 'application/json' })
      return void response.end(translated?.body ?? raw)
    }
    await pipeUpstream(response, upstream)
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = request.url ?? ''
    if (url !== prefix && !url.startsWith(`${prefix}/`)) return void response.writeHead(404).end()
    const path = url.slice(prefix.length) || '/'
    const raw = request.method === 'GET' || request.method === 'HEAD' ? Buffer.alloc(0) : await readBody(request)
    let body: Record<string, unknown> | null = null
    if (raw.length) {
      try {
        body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
      } catch {
        body = null
      }
    }
    const route = routeFor(body?.model)
    if (route === 'reject') return sendError(response, 400, 'invalid_request_error', `Modelo desconhecido para o roteador do Kimi: ${String(body?.model)}`)

    if (route === 'kimi') {
      const cred = deps.credential()
      if (!cred) return sendError(response, 401, 'authentication_error', 'Kimi desligado ou sem chave. Abra Configurações → Kimi.')
      return toKimi(request, response, path, body!, cred, 'kimi')
    }

    // Anthropic: intacto. Reserva de auxiliares no Kimi só com cota/credencial Claude fora.
    const isMessages = request.method === 'POST' && /^\/v1\/messages(\?|$|\/count_tokens)/.test(path) && body !== null
    const cred = isMessages ? deps.credential() : null
    const hadCredential = hasClaudeCredential(request.headers)
    const sessionId = String(request.headers['x-claude-code-session-id'] ?? '')
    if (cred && (!hadCredential || now() < claudeOutUntil)) {
      deps.onAuxReserve?.(sessionId)
      return toKimi(request, response, path.replace(/\?.*$/, ''), auxReserveBody(body!), cred, 'kimi-reserva')
    }
    const headers = anthropicHeaders(request.headers)
    const upstream = await fetchImpl(`${anthropicBase}${path}`, { method: request.method, headers, body: raw.length ? new Uint8Array(raw) : undefined })
    record({ route: 'anthropic', path, model: body?.model, status: upstream.status, headers: redactHeaders(headers), body })
    if (!upstream.ok && cred) {
      const text = await upstream.text()
      if (claudeUnavailable(upstream.status, text, hadCredential)) {
        claudeOutUntil = now() + CLAUDE_OUT_MS
        deps.log?.('kimi router: Claude indisponível (cota); auxiliares desta sessão no Kimi por 5 min')
        deps.onAuxReserve?.(sessionId)
        return toKimi(request, response, path.replace(/\?.*$/, ''), auxReserveBody(body!), cred, 'kimi-reserva')
      }
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      return void response.end(text)
    }
    await pipeUpstream(response, upstream)
  }

  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      handle(request, response).catch((err) => {
        deps.log?.(`kimi router: falha no pedido: ${String(err)}`)
        sendError(response, 502, 'api_error', 'O roteador do Kimi não conseguiu completar o pedido.')
      })
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      deps.log?.(`kimi router ouvindo em 127.0.0.1:${port}`)
      resolve({ port, close: () => new Promise((done, fail) => server.close((e) => (e ? fail(e) : done()))) })
    })
  })
}

let running: Promise<{ baseUrl: string }> | null = null

/** Sobe o roteador uma vez por app (singleton, como o proxy do Codex). O aviso
 *  de reserva vai às sessões Kimi abertas (cada uma casa pelo id do CLI). */
export function ensureKimiRouterRunning(
  credential: () => KimiRouterCredential | null,
  log?: (line: string) => void
): Promise<{ baseUrl: string }> {
  if (running) return running
  const secret = randomUUID()
  running = startKimiRouterServer({
    credential,
    secret,
    log,
    logDir: process.env.KIMI_ROUTER_LOG || undefined,
    onAuxReserve: notifyKimiAuxReserve
  })
    .then((h) => ({ baseUrl: `http://127.0.0.1:${h.port}/${secret}` }))
    .catch((err) => {
      running = null
      throw err
    })
  return running
}
