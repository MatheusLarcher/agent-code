// Roda a bateria fixa no Agent Code DESTE repositório (o app de verdade, numa
// instância isolada) e grava um placar por tarefa: tempo, tokens, acerto e decisões.
//
//   npx electron-vite build                      # a instância abre o build (out/)
//   node scripts/bateria/rodar.mjs [ids...] [--modelo claude-opus-5-5] [--esforco high] [--rotulo antes] [--rodada <existente>]
//
// Cada tarefa: cópia nova do projeto de exemplo (git init), instância com pasta de
// dados própria, uma conversa, o pedido, condução até o fim (permissões pela política
// do replay, perguntas com a opção recomendada) e a conferência da tarefa.
// Resultados: docs/bateria/resultados/<rodada>/<id>.json. Transcripts e dados ficam
// fora do repositório, em ~/agent-code-bateria.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { driveUntilDone } from '../replay/drive.mjs'
import { APP_ROOT, cacheDirOf, launch, openProject, ramUsedFraction, seedDataDir, shutdown, waitForMemory } from '../replay/instance.mjs'
import { claudeProjectSlug } from '../replay/measure.mjs'
import { memoriasInjetadas, transcriptLines } from './memorias.mjs'
import { TAREFAS, diffInfo } from './tarefas.mjs'

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args.splice(i, 2)[1] : def
}
const MODELO = opt('modelo', 'claude-opus-5-5')
const ESFORCO = opt('esforco', 'high')
const ROTULO = opt('rotulo', '')
// --rodada <nome>: grava numa rodada já existente (uma tarefa por chamada, mesma pasta).
const RODADA_FIXA = opt('rodada', '')
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? (args.splice(i, 1), true) : false
}
// --memorias / --skills: COPIA (a origem só é lida) as memórias / skills reais do
// usuário para a pasta da instância, para medir como ele usa. Nunca grava na origem.
const MEMORIAS = flag('memorias')
const SKILLS = flag('skills')
// --repeticoes N: roda cada tarefa N vezes (<id>-r1.json, <id>-r2.json…).
const REPETICOES = Math.max(1, Number(opt('repeticoes', '1')) || 1)
const PASTA_REAL = path.join(os.homedir(), 'Documents', 'agent-code')
const ids = args.filter((a) => !a.startsWith('--'))
const tarefas = ids.length ? TAREFAS.filter((t) => ids.includes(t.id)) : TAREFAS
if (!tarefas.length) throw new Error(`nenhuma tarefa com esses ids. Existem: ${TAREFAS.map((t) => t.id).join(', ')}`)
if (RODADA_FIXA && !/^[\w.-]+$/.test(RODADA_FIXA)) throw new Error(`--rodada inválida: ${RODADA_FIXA}`)

const RODADA = RODADA_FIXA || `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}${ROTULO ? `-${ROTULO}` : ''}`
const BASE = path.join(os.homedir(), 'agent-code-bateria', RODADA)
const SAIDA = path.join(APP_ROOT, 'docs', 'bateria', 'resultados', RODADA)
const log = (...m) => console.log(`[bateria ${new Date().toLocaleTimeString('pt-BR')}]`, ...m)

/** Ferramentas, perguntas e tokens do transcript. */
export function contar(lines) {
  const c = { ferramentas: 0, porFerramenta: {}, perguntas: 0, chamadas: 0, tokens: { entrada: 0, saida: 0, cacheLido: 0, cacheCriado: 0 } }
  const vistos = new Set()
  for (const l of lines) {
    if (l.type !== 'assistant' || !l.message) continue
    const id = l.message.id
    // O CLI grava uma linha por bloco da mesma resposta: o uso conta uma vez por id.
    if (id && !vistos.has(id)) {
      vistos.add(id)
      c.chamadas++
      const u = l.message.usage ?? {}
      c.tokens.entrada += u.input_tokens ?? 0
      c.tokens.saida += u.output_tokens ?? 0
      c.tokens.cacheLido += u.cache_read_input_tokens ?? 0
      c.tokens.cacheCriado += u.cache_creation_input_tokens ?? 0
    }
    for (const b of Array.isArray(l.message.content) ? l.message.content : []) {
      if (b.type !== 'tool_use') continue
      c.ferramentas++
      c.porFerramenta[b.name] = (c.porFerramenta[b.name] ?? 0) + 1
      if (b.name === 'AskUserQuestion') c.perguntas++
    }
  }
  return c
}

/** Linhas `turn-timing` do sessions.log da instância. */
function tempos(dados) {
  const achar = (d, depth = 0) => {
    if (depth > 5 || !existsSync(d)) return null
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isFile() && e.name === 'sessions.log') return p
      if (e.isDirectory() && e.name !== 'pgdata') { const f = achar(p, depth + 1); if (f) return f }
    }
    return null
  }
  const f = achar(dados)
  if (!f) return []
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.event === 'turn-timing').map((l) => l.ms)
}

const contarMd = (d) => (existsSync(d) ? readdirSync(d, { recursive: true }).filter((f) => String(f).endsWith('.md')).length : 0)

async function rodarTarefa(t, nome = t.id) {
  const dir = path.join(BASE, nome, 'projeto')
  // Dados fora da pasta-mãe do projeto: um `rm -rf ..` do agente não derruba a instância.
  const dados = path.join(BASE, '_dados', nome)
  if (SKILLS) seedDataDir(dados, { userSkillsDir: path.join(PASTA_REAL, 'skills') })
  if (MEMORIAS) {
    cpSync(path.join(PASTA_REAL, 'memories'), path.join(cacheDirOf(dados), 'memories'), { recursive: true })
    log(`${nome}: ${contarMd(path.join(cacheDirOf(dados), 'memories'))} memórias copiadas para a instância`)
  }
  mkdirSync(path.dirname(dir), { recursive: true })
  cpSync(path.join(import.meta.dirname, 'fixtures', t.fixture), dir, { recursive: true })
  const g = (a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  g(['init', '-q']); g(['add', '-A']); g(['-c', 'user.name=bateria', '-c', 'user.email=bateria@local', 'commit', '-qm', 'inicial'])

  await waitForMemory(2, { log })
  // Critério da medição: RAM física abaixo de 80% antes de cada rodada.
  for (let usada; (usada = ramUsedFraction()) >= 0.8;) {
    log(`[memória] RAM em ${Math.round(usada * 100)}%; esperando ficar abaixo de 80%`)
    await new Promise((r) => setTimeout(r, 30_000))
  }
  log(`${nome}: RAM em ${Math.round(ramUsedFraction() * 100)}% ao abrir`)
  const { app, page, bridge } = await launch(dados, { log })
  const t0 = Date.now()
  let fim
  try {
    // A ponte só cria conversa em pasta que o app já conhece como projeto.
    await openProject(app, page, dir)
    const created = await bridge.createConversation(dir)
    if (!created?.convId) throw new Error(`a ponte não criou a conversa: ${JSON.stringify(created)}`)
    let conv
    for (let i = 0; i < 30 && !conv; i++) {
      conv = ((await bridge.state()).conversations ?? []).find((c) => c.id === created.convId)
      if (!conv) await new Promise((r) => setTimeout(r, 1000))
    }
    if (!conv) throw new Error('a conversa não apareceu na ponte')
    await bridge.setModel(conv.id, MODELO, ESFORCO)
    const ctx = { answered: new Set(), events: [], policy: { worktree: dir, platform: process.platform } }
    log(`${t.id}: enviando "${t.pedido}"`)
    await bridge.send(conv.id, t.pedido)
    fim = await driveUntilDone(bridge, ctx, {
      pick: (s) => (s.conversations ?? []).find((c) => c.id === conv.id),
      timeoutMs: t.tetoMs,
      idleMs: 20_000,
      maxNudges: 0,
      log
    })
    // Mensagens seguintes na mesma conversa (latência com o CLI já aberto).
    for (const texto of t.depois ?? []) {
      if (fim.status !== 'done') break
      log(`${t.id}: enviando "${texto}"`)
      await bridge.send(conv.id, texto)
      const seguinte = await driveUntilDone(bridge, ctx, {
        pick: (s) => (s.conversations ?? []).find((c) => c.id === conv.id),
        timeoutMs: t.tetoMs, idleMs: 20_000, maxNudges: 0, log
      })
      fim = { ...seguinte, workMs: (fim.workMs ?? fim.ms) + (seguinte.workMs ?? seguinte.ms) }
    }
    fim.eventos = ctx.events
    // Quebra do contexto por categoria (o mesmo /context do CLI), com a sessão ainda aberta.
    fim.contexto = await page.evaluate((id) => window.api.countContextExact(id), conv.id).catch((e) => ({ ok: false, reason: String(e) }))
  } finally {
    await shutdown(app, dados, { log })
  }

  const linhas = transcriptLines(path.join(os.homedir(), '.claude', 'projects', claudeProjectSlug(dir)))
  const contagem = contar(linhas)
  const diff = diffInfo(dir)
  const final = fim.finalText ?? ''
  const itens = t.checar({ dir, diff, final, contagem, fim })
  const valem = itens.filter((i) => i.ok !== null)
  const nota = valem.length ? valem.reduce((s, i) => s + (i.ok ? i.peso : 0), 0) / valem.reduce((s, i) => s + i.peso, 0) : null
  return {
    tarefa: t.id, resumo: t.resumo, pedido: t.pedido, modelo: MODELO, esforco: ESFORCO,
    status: fim.status, msTotal: Date.now() - t0, msTrabalho: fim.workMs ?? fim.ms,
    tempos: tempos(dados), memorias: memoriasInjetadas(linhas), contagem, diff: { arquivos: diff.files, add: diff.add, del: diff.del },
    itens, nota, respostaFinal: final.slice(0, 4000), eventos: fim.eventos, contexto: fim.contexto
  }
}

mkdirSync(SAIDA, { recursive: true })
log(`rodada ${RODADA}: ${tarefas.map((t) => t.id).join(', ')} | ${MODELO} ${ESFORCO}`)
for (const t of tarefas) for (let n = 1; n <= REPETICOES; n++) {
  const nome = REPETICOES > 1 ? `${t.id}-r${n}` : t.id
  try {
    const r = await rodarTarefa(t, nome)
    writeFileSync(path.join(SAIDA, `${nome}.json`), JSON.stringify(r, null, 2))
    log(`${nome}: ${r.status} em ${(r.msTrabalho / 1000).toFixed(1)} s | nota ${r.nota === null ? '—' : Math.round(r.nota * 100) + '%'} | ${r.itens.map((i) => `${i.ok ? '✓' : '✗'} ${i.nome}`).join(' · ')}`)
  } catch (e) {
    log(`${nome}: ERRO de infraestrutura — ${e?.stack ?? e}`)
    writeFileSync(path.join(SAIDA, `${nome}.json`), JSON.stringify({ tarefa: t.id, status: 'erro', erro: String(e?.message ?? e) }, null, 2))
  }
}
log(`resultados em ${path.relative(APP_ROOT, SAIDA)}. Placar: node scripts/bateria/placar.mjs ${RODADA}`)
