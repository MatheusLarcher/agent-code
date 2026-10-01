// Sonda: os input_json_delta de um tool_use (Write/Edit) chegam aos pedaços ao
// longo do tempo ou num bloco só? E stream_event de subagente (parent_tool_use_id)
// chega ao host? Roda consultas REAIS e pequenas pelo SDK + CLI embutidos.
//
// ATENÇÃO, CUSTA DINHEIRO: cada rodada faz consultas pagas na conta ativa
// (~US$ 0,10–0,15 por rodada em 01/10/2026). Ferramenta de diagnóstico, não roda
// em teste nem em build — use só para refazer a medição se o SDK/CLI mudar.
// Resultado de referência (SDK 0.3.286): principal = AOS PEDAÇOS; subagente =
// nenhum stream_event (por isso o escritório usa digitação simulada nele).
//
//   node scripts/probe-tool-input-stream.mjs [--model claude-opus-5-5] [--effort low]
//        [--round main|sub|all] [--fgts on|off]
//
// --fgts on|off força CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1|0 (comparação);
// sem a flag, o CLI decide sozinho (é o que o app faz).
// Ambiente = o do processo (a conta padrão do app herda process.env, inclusive
// CLAUDE_CONFIG_DIR), menos os marcadores de uma sessão-pai do CLI. Nenhum valor
// de variável é impresso. Pasta de trabalho em os.tmpdir(), apagada no fim.
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { query } from '@anthropic-ai/claude-agent-sdk'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const MODEL = arg('model', 'claude-opus-5-5')
const EFFORT = arg('effort', 'low')
const ROUND = arg('round', 'all')
const FGTS = args.includes('--fgts') ? arg('fgts', 'on') : null
const ROUND_TIMEOUT_MS = 240_000
if (!['main', 'sub', 'all'].includes(ROUND)) throw new Error(`--round inválido: ${ROUND}`)
if (FGTS !== null && !['on', 'off'].includes(FGTS)) throw new Error(`--fgts inválido: ${FGTS}`)

const require = createRequire(import.meta.url)

/** Mesma resolução de src/main/claudeCli.ts (claudeCliPath). */
function claudeCliPath() {
  const plat = process.platform
  const bin = plat === 'win32' ? 'claude.exe' : 'claude'
  const pkgs = [`@anthropic-ai/claude-agent-sdk-${plat}-${process.arch}`]
  if (plat === 'linux') pkgs.push(`@anthropic-ai/claude-agent-sdk-${plat}-${process.arch}-musl`)
  for (const pkg of pkgs) {
    try { return require.resolve(`${pkg}/${bin}`) } catch { /* próximo candidato */ }
  }
  throw new Error(`Claude CLI binary not found for ${plat}-${process.arch} in node_modules`)
}

async function sdkVersions() {
  const pkg = JSON.parse(await readFile(join(dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'), 'utf8'))
  return { sdk: pkg.version, claudeCode: pkg.claudeCodeVersion ?? '?' }
}

// Variáveis que só existem porque esta sonda pode rodar DENTRO de uma sessão do
// CLI (terminal do agente). O processo do app não as tem; herdá-las faria o CLI
// filho se comportar como sessão aninhada. Só os nomes saem no log.
const PARENT_SESSION_VARS = [
  'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_AGENT_SDK_VERSION'
]
function sessionEnv() {
  const env = { ...process.env }
  const stripped = PARENT_SESSION_VARS.filter((k) => k in env)
  for (const k of stripped) delete env[k]
  if (FGTS !== null) env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING = FGTS === 'on' ? '1' : '0'
  return { env, stripped }
}

const redact = (s) => String(s)
  .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***')
  .replace(/(bearer|token|authorization|api[_-]?key)(["'\s:=]+)[^\s"',}]+/gi, '$1$2***')

/** Write/Edit/Read só dentro de `root`; Agent/Task liberado (rodada do subagente). */
function makePermission(root, denials) {
  const inside = (p) => {
    if (typeof p !== 'string' || !p) return false
    const rel = relative(root, resolve(root, p))
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }
  return async (toolName, input) => {
    if (['Write', 'Edit', 'Read'].includes(toolName) && inside(input?.file_path)) {
      return { behavior: 'allow', updatedInput: input }
    }
    if (toolName === 'Agent' || toolName === 'Task') return { behavior: 'allow', updatedInput: input }
    denials.push(toolName)
    return { behavior: 'deny', message: `Sonda: ${toolName} não permitido (só Write/Edit/Read na pasta temporária).` }
  }
}

/**
 * Consome uma query e devolve a linha do tempo dos stream_event e o que chegou
 * de subagente. `index` do bloco é por mensagem, então a chave inclui o nº da
 * mensagem (message_start) dentro do mesmo parent_tool_use_id.
 */
async function runRound(label, prompt, root, env) {
  const denials = []
  const stderrTail = []
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), ROUND_TIMEOUT_MS)
  const t0 = performance.now()
  const ms = () => Math.round(performance.now() - t0)
  const events = []
  const blocks = new Map()
  const msgSeq = new Map()
  const sub = { streamByType: {}, messagesByType: {}, toolUses: [] }
  const info = { label, initModel: null, result: null, messageModels: new Set() }

  const q = query({
    prompt,
    options: {
      cwd: root,
      model: MODEL,
      effort: EFFORT,
      env,
      pathToClaudeCodeExecutable: claudeCliPath(),
      executable: 'node',
      includePartialMessages: true,
      permissionMode: 'default',
      canUseTool: makePermission(root, denials),
      tools: ['Read', 'Write', 'Edit', 'Agent'],
      settingSources: [],
      persistSession: false,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      abortController: abort,
      stderr: (d) => { stderrTail.push(redact(d).slice(0, 300)); if (stderrTail.length > 8) stderrTail.shift() }
    }
  })

  try {
    for await (const m of q) {
      const parent = m.parent_tool_use_id ?? null
      if (m.type === 'system' && m.subtype === 'init') info.initModel = m.model
      if (m.type === 'result') {
        info.result = {
          subtype: m.subtype, is_error: m.is_error, num_turns: m.num_turns, duration_ms: m.duration_ms,
          cost_usd: m.total_cost_usd, models: Object.keys(m.modelUsage ?? {}),
          output_tokens: m.usage?.output_tokens
        }
      }
      if (parent && m.type !== 'stream_event') {
        sub.messagesByType[m.type] = (sub.messagesByType[m.type] ?? 0) + 1
        for (const c of m.message?.content ?? []) {
          if (c?.type === 'tool_use') sub.toolUses.push({ t: ms(), name: c.name, inputBytes: Buffer.byteLength(JSON.stringify(c.input ?? {})) })
        }
      }
      if (m.type !== 'stream_event') continue

      const ev = m.event
      const pk = parent ?? 'main'
      if (parent) sub.streamByType[ev.type] = (sub.streamByType[ev.type] ?? 0) + 1
      if (ev.type === 'message_start') {
        msgSeq.set(pk, (msgSeq.get(pk) ?? 0) + 1)
        if (ev.message?.model) info.messageModels.add(ev.message.model)
      }
      const seq = msgSeq.get(pk) ?? 0
      const row = {
        t: ms(), event: ev.type, delta: ev.delta?.type ?? null,
        bytes: ev.delta?.type === 'input_json_delta' ? Buffer.byteLength(ev.delta.partial_json ?? '') : null,
        index: ev.index ?? null, msg: seq,
        tool: ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use' ? ev.content_block.name : null,
        parent
      }
      events.push(row)
      const key = `${pk}#${seq}:${ev.index}`
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        blocks.set(key, { key, tool: ev.content_block.name, parent, start: row.t, stop: null, deltas: [], json: '' })
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta') {
        const b = blocks.get(key)
        if (b) { b.deltas.push({ t: row.t, bytes: row.bytes }); b.json += ev.delta.partial_json ?? '' }
      } else if (ev.type === 'content_block_stop' && blocks.has(key)) {
        blocks.get(key).stop = row.t
      }
    }
  } catch (err) {
    info.error = redact(err?.message ?? err)
    info.stderrTail = stderrTail
  } finally {
    clearTimeout(timer)
  }
  info.messageModels = [...info.messageModels]
  return { info, events, blocks: [...blocks.values()], sub, denials }
}

/** Tamanho do que a ferramenta recebeu, em linhas — confere se o pedido (~150/~30) foi cumprido. */
function inputLines(b) {
  const n = (s) => (typeof s === 'string' ? s.split('\n').length : null)
  try {
    const input = JSON.parse(b.json)
    if (b.tool === 'Write') return `content=${n(input.content)}`
    if (b.tool === 'Edit') return `old=${n(input.old_string)} new=${n(input.new_string)}`
    return '-'
  } catch {
    return 'json-incompleto'
  }
}

function summarize(b) {
  const d = b.deltas
  const first = d[0]?.t ?? null
  const last = d.at(-1)?.t ?? null
  // Vários deltas podem sair do mesmo pedaço de SSE (mesmo ms): "espalhado" é
  // medido em instantes de chegada distintos, não em nº de deltas.
  const instants = [...new Set(d.map((x) => x.t))]
  const maxGap = instants.reduce((a, t, i) => (i ? Math.max(a, t - instants[i - 1]) : a), 0)
  return {
    tool: b.tool, parent: b.parent, key: b.key, deltas: d.length, lines: inputLines(b),
    instants: instants.length, max_gap_ms: maxGap,
    span_ms: first === null ? 0 : last - first,
    start_to_stop_ms: b.stop === null ? null : b.stop - b.start,
    max_chunk_bytes: d.reduce((a, x) => Math.max(a, x.bytes), 0),
    total_bytes: d.reduce((a, x) => a + x.bytes, 0)
  }
}

const verdictFor = (s) => (s.instants >= 5 && s.span_ms >= 500 ? 'AOS PEDAÇOS' : 'BLOCO ÚNICO')

function printRound(r) {
  const { info, events, blocks, sub, denials } = r
  console.log(`\n=== rodada ${info.label} ===`)
  console.log(JSON.stringify({ initModel: info.initModel, messageModels: info.messageModels, result: info.result, denials, error: info.error }))
  if (info.stderrTail?.length) console.log('stderr (fim, redigido):', info.stderrTail.join(' | '))
  const counts = {}
  for (const e of events) {
    const k = e.delta ? `${e.event}/${e.delta}` : e.event
    counts[k] = (counts[k] ?? 0) + 1
  }
  console.log('stream_event por tipo:', JSON.stringify(counts))
  const rows = blocks.map(summarize)
  console.log('\nbloco tool_use | linhas | deltas | instantes distintos | maior lacuna (ms) | intervalo 1º→último (ms) | start→stop (ms) | maior pedaço (B) | total (B) | veredito')
  for (const s of rows) {
    console.log(`${s.tool} ${s.key} | ${s.lines} | ${s.deltas} | ${s.instants} | ${s.max_gap_ms} | ${s.span_ms} | ${s.start_to_stop_ms} | ${s.max_chunk_bytes} | ${s.total_bytes} | ${verdictFor(s)}`)
  }
  for (const b of blocks) {
    const mine = events.filter((e) => `${e.parent ?? 'main'}#${e.msg}:${e.index}` === b.key)
    console.log(`\n-- log do bloco ${b.tool} ${b.key} (${mine.length} eventos) --`)
    const show = mine.length <= 8 ? mine : [...mine.slice(0, 4), '…', ...mine.slice(-4)]
    for (const e of show) console.log(typeof e === 'string' ? e : JSON.stringify(e))
  }
  console.log('\nsubagente: stream_event com parent_tool_use_id != null por tipo:', JSON.stringify(sub.streamByType))
  console.log('subagente: mensagens (não-stream) com parent_tool_use_id != null por tipo:', JSON.stringify(sub.messagesByType))
  if (sub.toolUses.length) console.log('subagente: tool_use completos recebidos:', JSON.stringify(sub.toolUses))
  return rows
}

const MAIN_PROMPT = [
  'Sonda técnica de streaming. Faça exatamente isto, sem ler nada antes:',
  '1) Use a ferramenta Write para criar o arquivo probe.ts nesta pasta: um módulo TypeScript com cerca de 150 linhas',
  '   (por exemplo, 15 funções utilitárias puras de ~9 linhas cada, cada uma com um comentário de uma linha).',
  '2) Em seguida, com UMA única chamada da ferramenta Edit, substitua um trecho contíguo de cerca de 30 linhas desse',
  '   arquivo (reescreva 3 funções vizinhas com outra implementação).',
  'Não use outras ferramentas, não leia o arquivo de volta e termine com uma frase curta.'
].join('\n')

const subPrompt = (root) => [
  'Sonda técnica de subagente. Use a ferramenta Agent com subagent_type "general-purpose" e delegue esta tarefa:',
  `"Com a ferramenta Write, crie o arquivo ${join(root, 'sub.txt')} contendo 20 linhas no formato 'linha N' (N de 1 a 20). Não use outras ferramentas."`,
  'Você mesmo NÃO deve usar Write nem Edit. Quando o subagente terminar, responda só "ok".'
].join('\n')

const root = await mkdtemp(join(tmpdir(), 'probe-tool-stream-'))
let exitCode = 0
try {
  const versions = await sdkVersions()
  const { env, stripped } = sessionEnv()
  console.log(JSON.stringify({
    sdk: versions.sdk, claudeCode: versions.claudeCode, model: MODEL, effort: EFFORT, round: ROUND, fgts: FGTS,
    cli: relative(process.cwd(), claudeCliPath()), configDirFromEnv: Boolean(env.CLAUDE_CONFIG_DIR),
    strippedParentSessionVars: stripped
  }))
  const verdicts = {}
  if (ROUND === 'main' || ROUND === 'all') {
    const r = await runRound('main (Write ~150 linhas + Edit ~30 linhas)', MAIN_PROMPT, root, env)
    const rows = printRound(r)
    const write = rows.filter((s) => s.tool === 'Write').sort((a, b) => b.total_bytes - a.total_bytes)[0]
    verdicts.write = write ? verdictFor(write) : 'SEM WRITE'
    const edit = rows.find((s) => s.tool === 'Edit')
    verdicts.edit = edit ? verdictFor(edit) : 'SEM EDIT'
    if (r.info.error || r.info.result?.is_error) exitCode = 1
  }
  if (ROUND === 'sub' || ROUND === 'all') {
    const r = await runRound('sub (Agent general-purpose → Write pequeno)', subPrompt(root), root, env)
    printRound(r)
    const n = Object.values(r.sub.streamByType).reduce((a, x) => a + x, 0)
    verdicts.subagentStreamEvents = n > 0 ? `CHEGA (${n} stream_event)` : 'NÃO CHEGA'
    verdicts.subagentToolUseMessages = r.sub.toolUses.map((t) => t.name)
    if (r.info.error || r.info.result?.is_error) exitCode = 1
  }
  console.log('\nVEREDITO', JSON.stringify(verdicts))
} finally {
  await rm(root, { recursive: true, force: true })
  console.log(`pasta temporária apagada: ${root}`)
}
process.exitCode = exitCode
