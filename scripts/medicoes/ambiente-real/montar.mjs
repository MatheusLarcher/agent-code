// Monta o AMBIENTE REAL de avaliação da escolha de memórias, com dados do próprio usuário,
// FORA do repositório (padrão ~/agent-code-ambiente-real). Só leitura nas origens.
//
//   node scripts/medicoes/ambiente-real/montar.mjs [--destino ~/agent-code-ambiente-real] [--amostra 80] [--semente 3]
//
// 1. memorias/: as memórias do app (~/Documents/agent-code/memories) e as do Claude Code
//    (~/.claude/projects/*/memory), cada projeto na sua pasta — um acervo único, como será
//    com a nuvem. Arquivos de índice (MEMORY.md) ficam de fora.
// 2. pedidos.json: as mensagens reais do usuário nas conversas gravadas (~/.claude/projects),
//    sem comandos, avisos do sistema, prompts de observador e colagens longas; sem repetidas.
// 3. amostra.json: sorteio estratificado por projeto (semente fixa) para rotular.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const arg = (k, def) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : def }
const DESTINO = arg('destino', join(homedir(), 'agent-code-ambiente-real')).replace(/^~/, homedir())
const AMOSTRA = Number(arg('amostra', 80))
let semente = Number(arg('semente', 3)) >>> 0
const rnd = () => { semente = (semente + 0x6d2b79f5) >>> 0; let t = semente; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }

const HOME = homedir()
const PROJETOS = join(HOME, '.claude', 'projects')
const MEMORIAS_APP = join(HOME, 'Documents', 'agent-code', 'memories')
/** Nome curto do projeto a partir da pasta do Claude Code (slug do caminho). */
function projetoDe(slug) {
  const s = slug.replace(/^-Users-[^-]+-/, '')
  if (/scratch-workspaces/.test(s)) return 'conversa-avulsa'
  if (/agent-code-bateria|agent-code-ambiente|sandbox|private-tmp/.test(s)) return null
  if (/gabarito/i.test(s)) return 'gabarito'
  if (/Documents-agent-code|projetos-agent-code/.test(s)) return 'agent-code'
  const m = /projetos-(.+)$/.exec(s)
  if (m) return m[1]
  return s === '-Users-erickgoncalvescardoso' || s === '' ? 'geral' : s.slice(0, 30)
}

rmSync(DESTINO, { recursive: true, force: true })
const DM = join(DESTINO, 'memorias')
mkdirSync(DM, { recursive: true })

// 1. Memórias
let nMem = 0
const copiar = (de, para) => { mkdirSync(join(para, '..'), { recursive: true }); cpSync(de, para); nMem++ }
if (existsSync(MEMORIAS_APP)) {
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), join(rel, e.name))
      else if (e.name.endsWith('.md') && e.name !== 'MEMORY.md') copiar(join(d, e.name), join(DM, rel, e.name))
    }
  }
  walk(MEMORIAS_APP, '')
}
for (const slug of readdirSync(PROJETOS)) {
  const dir = join(PROJETOS, slug, 'memory')
  const projeto = projetoDe(slug)
  if (!projeto || !existsSync(dir)) continue
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md') || f === 'MEMORY.md') continue
    let destino = join(DM, projeto, f)
    while (existsSync(destino)) destino = destino.replace(/\.md$/, '-2.md')
    copiar(join(dir, f), destino)
  }
}

// 2. Pedidos reais
const RUIDO = /^(<|\[Contexto|\[SYSTEM|Você é o|Caveat:|This session is being continued|\[Request interrupted)/
const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim()
const vistos = new Set()
const pedidos = []
for (const slug of readdirSync(PROJETOS)) {
  const projeto = projetoDe(slug)
  if (!projeto) continue
  const dir = join(PROJETOS, slug)
  if (!statSync(dir).isDirectory()) continue
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    const anteriores = [] // mensagens anteriores do usuário na mesma conversa (contexto do pedido)
    for (const linha of readFileSync(join(dir, f), 'utf8').split('\n')) {
      let e
      try { e = JSON.parse(linha) } catch { continue }
      if (e?.type !== 'user' || typeof e.message?.content !== 'string' || e.isMeta) continue
      const texto = e.message.content.trim()
      if (RUIDO.test(texto)) continue
      const conversa = anteriores.slice(-2).join('\n---\n')
      anteriores.push(texto.slice(0, 400))
      if (texto.length < 8 || texto.length > 500 || texto.split('\n').length > 6) continue
      const chave = norm(texto)
      if (vistos.has(chave)) continue
      vistos.add(chave)
      pedidos.push({ id: `p${pedidos.length + 1}`, projeto, texto, conversa, sessao: basename(f, '.jsonl'), quando: e.timestamp ?? null })
    }
  }
}
writeFileSync(join(DESTINO, 'pedidos.json'), JSON.stringify(pedidos, null, 2))

// 3. Amostra estratificada por projeto (mínimo 4 por projeto com pedidos)
const porProjeto = new Map()
for (const p of pedidos) porProjeto.set(p.projeto, [...(porProjeto.get(p.projeto) ?? []), p])
const embaralhar = (xs) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a }
const cota = new Map([...porProjeto].map(([k, v]) => [k, Math.max(4, Math.round((v.length / pedidos.length) * AMOSTRA))]))
const amostra = [...porProjeto].flatMap(([k, v]) => embaralhar(v).slice(0, cota.get(k)))
writeFileSync(join(DESTINO, 'amostra.json'), JSON.stringify(amostra, null, 2))

console.log(`ambiente real em ${DESTINO}: ${nMem} memórias, ${pedidos.length} pedidos, amostra de ${amostra.length}`)
console.log([...porProjeto].map(([k, v]) => `  ${k}: ${v.length} pedidos (amostra ${Math.min(cota.get(k), v.length)})`).join('\n'))
