/**
 * Paridade do prompt NA REQUISIÇÃO REAL: Claude × Kimi com o CLI de verdade.
 * Um gravador local finge a API (responde "ok" e grava tudo, credencial
 * redigida, sem encaminhar nada à rede); a sessão Claude aponta direto para ele
 * e a sessão Kimi passa pelo roteador do Kimi, com os dois upstreams do roteador
 * apontados para o mesmo gravador. Compara a primeira requisição principal
 * (a que tem `tools`) de cada lado. Usado por wireParity.test.ts (npm test) e
 * por scripts/verify-prompt-parity.mjs (instalador).
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startKimiRouterServer } from './kimiRouter'
import { hoistInlineTools } from './kimiRouterRules'
import { kimiSessionEnv } from './kimiSession'

export interface Recorded { method: string; url: string; headers: Record<string, string>; body: Record<string, any> | null }

const SSE = (model: string): string => [
  ['message_start', { type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
  ['message_stop', { type: 'message_stop' }]
].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')

/** Gravador: responde como a Messages API e guarda cada pedido. Nunca encaminha. */
export async function startRecorder(): Promise<{ base: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = []
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) headers[k] = /^(authorization|x-api-key)$/i.test(k) ? '<redigido>' : String(v)
      let body: Record<string, any> | null = null
      try { body = raw ? JSON.parse(raw) : null } catch { body = null }
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers, body })
      const url = req.url ?? ''
      if (req.method === 'POST' && url.includes('/v1/messages/count_tokens')) return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":100}')
      if (req.method === 'POST' && url.includes('/v1/messages')) {
        if (body?.stream) return void res.writeHead(200, { 'content-type': 'text/event-stream' }).end(SSE(String(body.model)))
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: body?.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } }))
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { base: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) }
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC)/i.test(k)) env[k] = v
  return env
}

async function runSession(opts: { model: string; env: NodeJS.ProcessEnv; cwd: string; cli?: string; sdkPath: string }): Promise<void> {
  const { query } = (await import(pathToFileURL(opts.sdkPath).href)) as { query: (a: unknown) => AsyncIterable<{ type: string }> }
  for await (const m of query({
    prompt: 'PARIDADE: responda ok',
    options: {
      cwd: opts.cwd,
      model: opts.model,
      env: { ...opts.env, CLAUDE_CODE_ENABLE_TODO_TOOLS: 'true' },
      thinking: { type: 'adaptive', display: 'summarized' },
      permissionMode: 'default',
      maxTurns: 1,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'APPEND_PARIDADE' },
      ...(opts.cli ? { pathToClaudeCodeExecutable: opts.cli } : {})
    }
  })) {
    if (m.type === 'result') break
  }
}

/** Linhas que descrevem o modelo (identidade verdadeira, decisão do usuário). */
const IDENTITY_LINES = [/^.*You are powered by the model.*$/gm, /^.*Co-Authored-By: .*$/gm]

function normalizeText(text: string): string {
  let t = text
  for (const re of IDENTITY_LINES) t = t.replace(re, '<identidade do modelo>')
  return t
}

/** Visão comparável da requisição principal: só o que o modelo lê. As
 *  adaptações permitidas do roteador (KIMI_WIRE_ADAPTATIONS) são aplicadas aos
 *  dois lados antes: ferramentas inline vão para `tools` — a posição muda, o
 *  conteúdo não. */
export function comparable(input: Record<string, any>): string[] {
  const body = JSON.parse(JSON.stringify(input)) as Record<string, any>
  hoistInlineTools(body)
  const lines: string[] = []
  const sys = Array.isArray(body.system) ? body.system : [{ type: 'text', text: String(body.system ?? '') }]
  sys.forEach((s: any, i: number) => normalizeText(String(s.text ?? '')).split('\n').forEach((l) => lines.push(`system[${i}]: ${l}`)))
  for (const t of body.tools ?? []) {
    lines.push(`tool ${t.name}: defer=${Boolean(t.defer_loading)} type=${t.type ?? ''}`)
    String(t.description ?? '').split('\n').forEach((l) => lines.push(`tool ${t.name} desc: ${normalizeText(l)}`))
    lines.push(`tool ${t.name} schema: ${JSON.stringify(t.input_schema ?? null)}`)
  }
  ;(body.messages ?? []).forEach((m: any, i: number) => {
    const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]
    parts.forEach((p: any, j: number) => {
      const text = typeof p.text === 'string' ? p.text : JSON.stringify({ ...p, cache_control: undefined })
      normalizeText(text).split('\n').forEach((l) => lines.push(`msg[${i}].${m.role}[${j}] ${p.type}: ${l}`))
    })
  })
  lines.push(`thinking: ${JSON.stringify(body.thinking ?? null)}`)
  lines.push(`context_management: ${JSON.stringify(body.context_management ?? null)}`)
  lines.push(`max_tokens: ${body.max_tokens}`)
  return lines
}

/** Diff legível por LCS (`- [claude]` / `+ [kimi]`), vazio quando iguais. */
export function diffLines(a: string[], b: string[]): string[] {
  const n = a.length
  const m = b.length
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while ((i < n || j < m) && out.length < 80) {
    if (i < n && j < m && a[i] === b[j]) { i++; j++ }
    else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) out.push(`+ [kimi]   ${b[j++]}`)
    else out.push(`- [claude] ${a[i++]}`)
  }
  return out
}

export const mainRequest = (reqs: Recorded[]): Recorded | undefined =>
  reqs.find((r) => r.method === 'POST' && r.url.includes('/v1/messages') && !r.url.includes('count_tokens') && Array.isArray(r.body?.tools) && r.body!.tools.length > 0)

export interface ParityResult { claude?: Recorded; kimi?: Recorded; kimiUpstream: Recorded[]; anthropicUpstream: Recorded[]; diff: string[] }

/** Roda as duas sessões e compara. `sabotar` põe o apelido FABLE no lado Kimi (prova que o teste pega). */
export async function runWireParity(opts: { repoRoot: string; cli?: string; configDir?: string; sabotar?: boolean }): Promise<ParityResult> {
  const sdkPath = join(opts.repoRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs')
  const work = mkdtempSync(join(tmpdir(), 'paridade-'))
  const cwd = join(work, 'projeto')
  mkdirSync(cwd, { recursive: true })
  const configDir = opts.configDir ?? join(work, 'cfg')
  mkdirSync(configDir, { recursive: true })
  const anthropicRec = await startRecorder()
  const kimiRec = await startRecorder()
  const claudeRec = await startRecorder()
  const secret = 'paridade'
  const router = await startKimiRouterServer({
    credential: () => ({ apiKey: 'chave-falsa-da-paridade', region: 'intl', contextWindow: 262_144, orgInstructions: '' }),
    secret,
    anthropicBase: anthropicRec.base,
    kimiBase: () => `${kimiRec.base}/coding`
  })
  try {
    const base = { ...cleanEnv(), CLAUDE_CONFIG_DIR: configDir, ...(opts.configDir ? {} : { ANTHROPIC_AUTH_TOKEN: 'token-falso-da-paridade' }) }
    await runSession({ model: 'claude-opus-5-5', env: { ...base, ANTHROPIC_BASE_URL: claudeRec.base }, cwd, cli: opts.cli, sdkPath })
    const kimiEnv = {
      ...kimiSessionEnv(base, 'k3.1-pro', `http://127.0.0.1:${router.port}/${secret}`, { contextWindow: 262_144 }),
      ...(opts.configDir ? {} : { ANTHROPIC_AUTH_TOKEN: 'token-falso-da-paridade' }),
      ...(opts.sabotar ? { ANTHROPIC_DEFAULT_FABLE_MODEL: 'k3.1-pro' } : {})
    }
    await runSession({ model: 'k3.1-pro', env: kimiEnv, cwd, cli: opts.cli, sdkPath })
    const claude = mainRequest(claudeRec.requests)
    const kimi = mainRequest(kimiRec.requests)
    const diff = claude?.body && kimi?.body ? diffLines(comparable(claude.body), comparable(kimi.body)) : ['requisição principal ausente em um dos lados']
    return { claude, kimi, kimiUpstream: kimiRec.requests, anthropicUpstream: anthropicRec.requests, diff }
  } finally {
    await router.close()
    await Promise.all([anthropicRec.close(), kimiRec.close(), claudeRec.close()])
    rmSync(work, { recursive: true, force: true })
  }
}
