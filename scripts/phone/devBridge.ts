/**
 * Ponte de teste do app do celular (ver dev-bridge.mjs): o RemoteServer real com
 * estado simulado. Ações de controle (GET ou POST em http://127.0.0.1:8799/ctl/…):
 *
 *   stream?conv=c1         o agente responde (texto em streaming + ferramenta + fim)
 *   permission?conv=c1     pedido de permissão de ferramenta (com prazo)
 *   question?conv=c1       AskUserQuestion (2 perguntas, uma múltipla)
 *   busy?conv=c1&on=1      ocupada / livre;  stall?conv=c1   "sem resposta há…"
 *   todo?conv=c1           plano de tarefas;  recovery?conv=c1   recuperação de turno
 *   download?conv=c1       resposta com [[download:…]] (arquivo real em %TEMP%)
 *   central-ask | central-foreign | central-question | central-permission
 *   empty                  sem conversas;  reset   estado inicial
 *   stop | start           desliga/religa a ponte (PC desligado)
 *   other-phone            outro celular toma o lugar (POST /api/pair)
 *   log                    o que o celular mandou (send/transcribe/respostas)
 */
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { RemoteServer } from '../../src/main/remote/remoteServer'
import { readOfficeAgentFile } from '../../src/main/officeAgents'
import type { ChatEvent, RemoteConversation, RemoteStatePayload } from '../../src/shared/ipc'

const TOKEN = process.env.PHONE_DEV_TOKEN || 'devtoken'
const CTL_PORT = Number(process.env.PHONE_DEV_CTL || 8799)
const WWW = resolve(process.cwd(), 'smartfone-remote', 'www')
const PROJ_A = 'C:\\Projetos\\loja-bolos'
const PROJ_B = 'C:\\Projetos\\app-financas'
const DL_FILE = join(tmpdir(), 'relatorio-teste.pdf')
writeFileSync(DL_FILE, '%PDF-1.4\n% arquivo de teste da ponte do celular\n')

type Msg = Record<string, unknown> & { kind: string; id?: string }
const log: unknown[] = []
const note = (what: string, data: unknown): void => {
  log.push({ at: new Date().toISOString(), what, data })
  if (log.length > 200) log.shift()
  console.log('[celular →]', what, JSON.stringify(data).slice(0, 300))
}

let seq = 0
const id = (p: string): string => `${p}-${Date.now().toString(36)}-${++seq}`
const now = Date.now()

function initialState(): RemoteStatePayload {
  const c1Msgs: Msg[] = [
    { kind: 'user', id: 'u-c1-1', text: 'Cria a seção de cardápio do site com botão de WhatsApp.', ts: now - 3600_000 },
    { kind: 'assistant-text', id: 'a-c1-1', text: 'Vou ler a estrutura do projeto primeiro.', final: true },
    { kind: 'tool-use', id: 't-c1-1', name: 'Read', input: { file_path: `${PROJ_A}\\index.html` }, parentToolUseId: null, result: { isError: false, text: '<html>…</html>' } },
    { kind: 'tool-use', id: 't-c1-2', name: 'Edit', input: { file_path: `${PROJ_A}\\index.html`, old_string: '<main>', new_string: '<main>\n  <section id="cardapio">\n  </section>' }, parentToolUseId: null, result: { isError: false, text: 'ok' } },
    { kind: 'tool-use', id: 't-c1-3', name: 'Bash', input: { command: 'npm run build', description: 'Gera o site' }, parentToolUseId: null, result: { isError: true, text: 'Error: falta o arquivo cardapio.json' } },
    { kind: 'assistant-text', id: 'a-c1-2', answer: true, final: true, text: '## Pronto\n\nCriei a **seção de cardápio** com:\n\n- lista de bolos\n- botão de `WhatsApp`\n\n```js\nconst zap = "https://wa.me/55..."\n```\n\n| Bolo | Preço |\n|---|---|\n| Cenoura | R$ 40 |' }
  ]
  const conv = (o: Partial<RemoteConversation> & { id: string }): RemoteConversation => ({
    title: 'Conversa', cwd: PROJ_A, busy: false, connected: true, updatedAt: now, messages: [], queued: [],
    model: 'claude-opus-5-5', effort: 'high', fastModeAvailable: true, ...o
  })
  return {
    conversations: [
      conv({ id: 'central', title: 'Central', cwd: PROJ_A, central: centralSnapshot() }),
      conv({
        id: 'c1', title: 'Cardápio do site', messages: c1Msgs, updatedAt: now - 1000,
        questions: [{ id: 'u-c1-1', text: 'Cria a seção de cardápio do site com botão de WhatsApp.', ts: now - 3600_000, position: 0 }],
        tokens: { context: 84_000, output: 12_400, cost: 1.37, contextLimit: 200_000 }
      }),
      conv({ id: 'c2', title: 'Ajustar carrinho', updatedAt: now - 7200_000, messages: [{ kind: 'user', id: 'u-c2-1', text: 'Testa o carrinho', ts: now - 7200_000 }] }),
      conv({ id: 'c3', title: 'Relatório mensal', cwd: PROJ_B, updatedAt: now - 86400_000, model: 'claude-sonnet-5-5' })
    ],
    skipPerms: false,
    models: [
      { id: 'claude-opus-5-5', label: 'Opus 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
      { id: 'claude-fable-5-1', label: 'Fable 5.1' }
    ],
    modelEffort: { 'claude-opus-5-5': ['low', 'medium', 'high', 'max'], 'claude-sonnet-5-5': ['low', 'medium', 'high'] },
    effortLabels: { low: 'Baixo', medium: 'Médio', high: 'Alto', max: 'Máximo' },
    usage: {
      five_hour: { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.42, resetsAt: now + 2 * 3600_000 },
      seven_day: { rateLimitType: 'seven_day', status: 'allowed_warning', utilization: 0.86, resetsAt: now + 3 * 86400_000 }
    },
    projects: [PROJ_A, PROJ_B, 'C:\\Projetos\\sem-conversa']
  }
}

function centralSnapshot(): NonNullable<RemoteConversation['central']> {
  return {
    entries: [
      { kind: 'request', id: 'r1', ts: now - 3600_000, text: 'Cria a seção de cardápio do site', state: 'delivered', notice: { to: 'loja-bolos · Cardápio do site', why: 'fala de site e cardápio', color: '#6f9bd1' }, anchor: { convId: 'c1', msgId: 'u-c1-1' } },
      { kind: 'reply', id: 'rp1', ts: now - 3500_000, requestId: 'r1', anchor: { convId: 'c1', msgId: 'u-c1-1' }, who: 'loja-bolos · Cardápio do site', color: '#6f9bd1', notes: ['Vou ler a estrutura do projeto primeiro.'], answer: 'Criei a **seção de cardápio**.', activity: { segments: [{ text: 'Read', tone: 'strong' }, { text: ' index.html · ' }, { text: '+3', tone: 'add' }], text: 'Read index.html · Edit +3', count: 3, errors: 1, done: true } }
    ],
    rail: [{ convId: 'c1', project: 'loja-bolos', title: 'Cardápio do site', color: '#6f9bd1', icon: null, sandbox: false }],
    questions: []
  }
}

let state = initialState()
const conv = (cid: string): RemoteConversation | undefined => state.conversations.find((c) => c.id === cid)
const publish = (): void => server.setState(state)

/** Aplica o evento ao retrato (o que o renderer faria) e manda ao celular. */
function emit(cid: string, e: ChatEvent): void {
  const c = conv(cid)
  if (c) {
    const msgs = c.messages as Msg[]
    if (e.kind === 'assistant-text') {
      const i = msgs.findIndex((m) => m.kind === 'assistant-text' && m.id === e.id)
      if (i >= 0) msgs[i] = { ...e }
      else msgs.push({ ...e })
    } else if (e.kind === 'tool-result') {
      const t = msgs.find((m) => m.kind === 'tool-use' && m.id === e.toolUseId)
      if (t) t.result = { isError: e.isError, text: e.text }
    } else if (e.kind === 'result') {
      for (let k = msgs.length - 1; k >= 0; k--) if (msgs[k].kind === 'assistant-text') { msgs[k].answer = true; break }
    } else if (e.kind !== 'rate-limit' && e.kind !== 'stall-status') msgs.push({ ...e } as Msg)
    c.updatedAt = Date.now()
  }
  publish()
  server.broadcast(cid, e)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function agentReply(cid: string, prompt: string, withDownload = false): Promise<void> {
  const c = conv(cid)
  if (!c) return
  c.busy = true
  publish()
  const full = withDownload
    ? `Gerei o relatório.\n\n[[download:${DL_FILE}]]`
    : `Entendido: **${prompt.slice(0, 60) || 'anexo recebido'}**. Fiz uma checagem rápida e está tudo certo.`
  const tid = id('t')
  emit(cid, { kind: 'tool-use', id: tid, name: 'Grep', input: { pattern: 'TODO' }, parentToolUseId: null })
  await sleep(500)
  emit(cid, { kind: 'tool-result', id: id('tr'), toolUseId: tid, isError: false, text: '3 resultados' })
  const aid = id('a')
  for (let n = 8; n <= full.length; n += 8) {
    emit(cid, { kind: 'assistant-text', id: aid, text: full.slice(0, n), final: false })
    await sleep(60)
  }
  emit(cid, { kind: 'assistant-text', id: aid, text: full, final: true })
  emit(cid, { kind: 'result', id: id('res'), isError: false, text: full, durationMs: 1800 })
  c.busy = false
  c.queued = []
  publish()
}

const server = new RemoteServer({
  apkPath: () => resolve(process.cwd(), 'smartfone-remote', 'dist', 'agent-remote.apk'),
  wwwDir: () => WWW,
  loadToken: () => TOKEN,
  // O escritório 3D do celular: os modelos/animações de verdade da pasta resources/office-agents.
  officeAgentFile: (name) => readOfficeAgentFile(name, { packaged: false, resourcesPath: '', appPath: process.cwd() }),
  onInbound: (cid, text, images, files, replyTo) => {
    note('send', { cid, text, images: images?.length ?? 0, files: files?.map((f) => f.name), replyTo })
    const c = conv(cid)
    if (!c) return
    if (cid === 'central') {
      const entries = c.central!.entries
      const rid = id('r')
      entries.push({ kind: 'request', id: rid, ts: Date.now(), text, state: 'routing' })
      publish()
      setTimeout(() => {
        const e = entries.find((x) => x.id === rid)
        if (e && e.kind === 'request') Object.assign(e, { state: 'delivered', notice: { to: 'loja-bolos · Cardápio do site', why: 'teste', color: '#6f9bd1' }, anchor: { convId: 'c1', msgId: 'u-c1-1' } })
        publish()
      }, 1500)
      return
    }
    if (c.busy) {
      c.queued = [...(c.queued ?? []), { text }]
      publish()
      return
    }
    ;(c.messages as Msg[]).push({ kind: 'user', id: id('u'), text, ts: Date.now() })
    void agentReply(cid, text)
  },
  onInterrupt: (cid) => {
    note('interrupt', cid)
    const c = conv(cid)
    if (c) c.busy = false
    publish()
  },
  onSetMode: (cid, mode, on) => note('set-mode', { cid, mode, on }),
  onSetModel: (cid, model, effort) => note('set-model', { cid, model, effort }),
  onSetSkipPerms: (on) => {
    note('skip-perms', on)
    state.skipPerms = on
    publish()
  },
  onRecoveryAction: (cid, action) => {
    note('recovery', { cid, action })
    const c = conv(cid)
    if (c) delete c.recovery
    publish()
  },
  onPermissionResponse: (cid, res) => {
    note('permission-respond', { cid, res })
    const c = conv(cid)
    if (c) delete c.permission
    const central = conv('central')?.central
    if (central) central.questions = central.questions.filter((q) => q.request.id !== res.id)
    publish()
  },
  onCentralChoose: (choice) => {
    note('central-choose', choice)
    const e = conv('central')?.central?.entries.find((x) => x.id === choice.entryId)
    if (e && e.kind === 'request') Object.assign(e, { state: 'delivered', ask: undefined, notice: { to: 'app-financas · Relatório mensal', why: 'escolhido no celular', color: '#7fae6f' }, anchor: { convId: 'c3', msgId: 'x' } })
    setTimeout(publish, 400)
  },
  onConversationAction: (a) => {
    note('conversation', a)
    if (a.type === 'create') state.conversations.push({ id: a.convId, title: 'Nova conversa', cwd: a.cwd, busy: false, connected: false, updatedAt: Date.now(), messages: [], queued: [], model: 'claude-opus-5-5' })
    if (a.type === 'rename') Object.assign(conv(a.convId) ?? {}, { title: a.title })
    if (a.type === 'delete') state.conversations = state.conversations.filter((c) => c.id !== a.convId)
    publish()
  },
  transcribe: async (b64, mime) => {
    note('transcribe (áudio no PC)', { bytes: Math.floor((b64.length * 3) / 4), mime })
    return 'texto transcrito no PC'
  },
  tts: async (text) => {
    note('tts', text.slice(0, 80))
    return { base64: silentWav(), mimeType: 'audio/wav' }
  },
  ttsParts: (text) => text.split(/(?<=[.!?])\s+/).filter(Boolean)
})

/** 0,4 s de silêncio (WAV PCM 16 kHz) para o "Ouvir" tocar algo. */
function silentWav(): string {
  const n = 6400
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24)
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  return b.toString('base64')
}

async function control(action: string, q: URLSearchParams): Promise<unknown> {
  const cid = q.get('conv') || 'c1'
  const c = conv(cid)
  const deadline = Date.now() + 7 * 60_000
  switch (action) {
    case 'stream': void agentReply(cid, q.get('text') || 'pedido de teste'); return 'ok'
    case 'download': void agentReply(cid, 'relatório', true); return DL_FILE
    case 'permission': if (c) c.permission = { id: id('p'), toolName: 'Bash', input: { command: 'rm -rf build', description: 'Limpa a pasta de build' }, deadline }; break
    case 'question':
      if (c) c.permission = { id: id('q'), toolName: 'AskUserQuestion', input: {}, deadline, questions: [
        { header: 'Cor', question: 'Qual cor do botão?', multiSelect: false, options: [{ label: 'Verde', description: 'cor do WhatsApp' }, { label: 'Coral', description: 'cor da marca' }] },
        { header: 'Seções', question: 'Quais seções incluir?', multiSelect: true, options: [{ label: 'Bolos', description: '' }, { label: 'Tortas', description: '' }, { label: 'Doces', description: '' }] }
      ] }
      break
    case 'busy': if (c) c.busy = q.get('on') !== '0'; break
    case 'stall': if (c) { c.busy = true; c.stalledSince = Date.now() - 45_000 }; break
    case 'todo': if (c) c.todoPlan = { active: true, items: [
      { content: 'Ler o projeto', status: 'completed', activeForm: 'Lendo o projeto' },
      { content: 'Criar a seção', status: 'in_progress', activeForm: 'Criando a seção' },
      { content: 'Testar no navegador', status: 'pending', activeForm: 'Testando' }] }; break
    case 'recovery': if (c) c.recovery = { reason: 'limit', scheduledAt: Date.now() + 90_000, attempt: 1, maxAttempts: 3, errorText: 'limite' }; break
    case 'central-ask': conv('central')?.central?.entries.push({ kind: 'request', id: id('r'), ts: Date.now(), text: 'Faz o relatório do mês', state: 'asking', ask: { reason: 'low-confidence', options: [
      { label: 'app-financas · Relatório mensal', sub: 'conversa', icon: null, glyph: 'project', best: true },
      { label: 'Nova conversa em app-financas', icon: null, glyph: 'new', best: false },
      { label: 'Sandbox', icon: null, glyph: 'sandbox', best: false }] } }); break
    case 'central-foreign': conv('central')?.central?.entries.push({ kind: 'request', id: id('r'), ts: Date.now(), text: 'Pedido feito no outro PC', state: 'asking', foreign: true, ask: { reason: 'low-confidence', options: [{ label: 'outro-projeto · Conversa', icon: null, glyph: 'project', best: true }] } }); break
    case 'central-question': conv('central')?.central?.questions.push({ convId: 'c1', who: 'loja-bolos · Cardápio do site', color: '#6f9bd1', request: { id: id('cq'), toolName: 'AskUserQuestion', input: {}, deadline, questions: [{ header: 'Preço', question: 'Mostrar preços no cardápio?', multiSelect: false, options: [{ label: 'Sim', description: '' }, { label: 'Não', description: '' }] }] } }); break
    case 'central-permission': conv('central')?.central?.questions.push({ convId: 'c1', who: 'loja-bolos · Cardápio do site', color: '#6f9bd1', request: { id: id('cp'), toolName: 'Bash', input: { command: 'npm publish', description: 'Publica o pacote' }, deadline } }); break
    case 'empty': state.conversations = []; state.projects = []; break
    case 'reset': state = initialState(); break
    case 'stop': await server.stop(); return 'ponte desligada'
    case 'start': await server.start(); publish(); return server.info()
    case 'other-phone': {
      const i = server.info()
      const r = await fetch(`http://127.0.0.1:${i.port}/api/pair?token=${TOKEN}`, { method: 'POST', body: JSON.stringify({ deviceId: 'ph-outro', name: 'Galaxy do vizinho' }) })
      return r.json()
    }
    case 'log': return log
    case 'state': return server.info()
    default: return { error: 'ação desconhecida' }
  }
  publish()
  return 'ok'
}

await server.start()
publish()
const info = server.info()
createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x')
  const action = u.pathname.replace(/^\/ctl\//, '')
  control(action, u.searchParams).then(
    (r) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(r)) },
    (e) => { res.writeHead(500); res.end(String(e)) }
  )
}).listen(CTL_PORT, '0.0.0.0')
console.log(`Ponte de teste: http://${info.ip}:${info.port}  (token ${TOKEN})`)
console.log(`  cliente:  http://127.0.0.1:${info.port}/app/?token=${TOKEN}`)
console.log(`  QR (LAN): http://${info.ip}:${info.port}/?token=${TOKEN}`)
console.log(`  controle: http://127.0.0.1:${CTL_PORT}/ctl/<ação>`)
