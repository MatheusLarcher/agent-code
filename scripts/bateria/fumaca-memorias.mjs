// Fumaça do memorista e do bibliotecário no app DE VERDADE (instância isolada, build em out/).
// Uma conversa curta que ensina uma regra → o memorista grava com o cabeçalho novo (D43/D48)?
// Depois espera a 1ª passada do bibliotecário (5 min após abrir) → o relatório da simulação saiu?
//
//   npx electron-vite build
//   node scripts/bateria/fumaca-memorias.mjs [--modelo claude-sonnet-5-5]
//
// Gasta uma conversa curta (Sonnet, esforço baixo) + a análise do memorista. Dados fora do repo,
// em ~/agent-code-bateria/_dados/fumaca-memorias-<hora>.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { driveUntilDone } from '../replay/drive.mjs'
import { APP_ROOT, cacheDirOf, launch, openProject, shutdown } from '../replay/instance.mjs'

const i = process.argv.indexOf('--modelo')
const MODELO = i >= 0 ? process.argv[i + 1] : 'claude-sonnet-5-5'
const log = (m) => console.log(`[fumaca] ${m}`)
const hora = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
const dados = path.join(os.homedir(), 'agent-code-bateria', '_dados', `fumaca-memorias-${hora}`)
const projeto = path.join(os.homedir(), 'agent-code-bateria', '_projetos', `fumaca-memorias-${hora}`)
const memorias = path.join(cacheDirOf(dados), 'memories')

// MEMORY.md é o índice gerado pelo app, não uma memória.
const listar = (dir, base = dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? listar(path.join(dir, e.name), base) : e.name.endsWith('.md') && e.name !== 'MEMORY.md' ? [path.relative(base, path.join(dir, e.name))] : [])
    : []
const ler = (f) => readFileSync(path.join(memorias, f), 'utf8')
const achar = (dir, nome) => listar(dir).find((f) => path.basename(f) === nome)
const esperar = async (cond, ms, passo = 5000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, passo))) {
    const v = cond()
    if (v) return v
  }
  return null
}

// Acervo de mentira (do repositório): soltas, repetidas e temas, para o bibliotecário ter o que fazer.
cpSync(path.join(APP_ROOT, 'scripts/medicoes/ambiente-memorias/memorias-ficticias'), memorias, { recursive: true })
const antes = new Set(listar(memorias))
const conteudoAntes = new Map([...antes].map((f) => [f, ler(f)]))
mkdirSync(projeto, { recursive: true })
writeFileSync(path.join(projeto, 'README.md'), '# Loja da padaria\nSite de pedidos da padaria.\n')
execFileSync('git', ['init', '-q'], { cwd: projeto })
log(`${antes.size} memórias de mentira em ${memorias}`)

const { app, page, bridge } = await launch(dados, { log })
const t0 = Date.now()
let ok = true
try {
  await openProject(app, page, projeto)
  const { convId } = await bridge.createConversation(projeto)
  await bridge.setModel(convId, MODELO, 'low')
  const pedido = 'Regra deste projeto: nas telas da padaria, mostre datas sempre no formato dd/mm/aaaa, porque os clientes são brasileiros e já reclamaram do formato americano. Não precisa mexer em nada agora, só confirme que entendeu.'
  await bridge.send(convId, pedido)
  const ctx = { answered: new Set(), events: [], policy: { worktree: projeto, platform: process.platform } }
  await driveUntilDone(bridge, ctx, { pick: (s) => (s.conversations ?? []).find((c) => c.id === convId), timeoutMs: 180_000, idleMs: 10_000, maxNudges: 0, log })
  log('turno terminou; esperando o memorista (até 3 min)')

  // O memorista pode CRIAR uma memória ou COMPLEMENTAR uma que já existe (o certo quando o
  // assunto já está salvo): vale qualquer arquivo novo ou diferente do original.
  const mudouMemorista = () => listar(memorias).find((f) => !antes.has(f) || ler(f) !== conteudoAntes.get(f))
  const nova = await esperar(mudouMemorista, 180_000)
  if (nova) {
    log(`MEMORISTA ${antes.has(nova) ? 'complementou' : 'criou'} ${nova}:\n${ler(nova)}`)
  } else {
    ok = false
    log('MEMORISTA: nada gravado (gate disse não, modelo respondeu OK ou falhou — ver sessions.log da instância)')
  }
  // Daqui em diante, qualquer mudança é do bibliotecário — que em simulação não grava nada.
  const depoisMemorista = new Map(listar(memorias).map((f) => [f, ler(f)]))

  const falta = Math.max(0, 5 * 60_000 + 60_000 - (Date.now() - t0))
  log(`esperando a 1ª passada do bibliotecário (até ${Math.round(falta / 1000)} s)`)
  const rel = await esperar(() => achar(dados, 'ultima-passada.md'), falta, 10_000)
  if (rel) log(`BIBLIOTECÁRIO (simulação):\n${readFileSync(path.join(dados, rel), 'utf8')}`)
  else {
    ok = false
    log('BIBLIOTECÁRIO: relatório não apareceu')
  }
  // Simulação não grava: tudo igual ao que estava depois do memorista.
  const mexidas = [...depoisMemorista.keys()].filter((f) => !existsSync(path.join(memorias, f)) || ler(f) !== depoisMemorista.get(f))
  if (mexidas.length) {
    ok = false
    log(`SIMULAÇÃO mexeu em ${mexidas.length} memória(s): ${mexidas.join(', ')}`)
  } else log('simulação não mexeu em nenhuma memória antiga')
} finally {
  await shutdown(app, dados, { log })
}
log(ok ? 'OK' : 'FALHOU')
process.exit(ok ? 0 : 1)
