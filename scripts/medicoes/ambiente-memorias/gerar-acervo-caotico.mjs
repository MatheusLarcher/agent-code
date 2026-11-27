// Gera um acervo de memórias de MENTIRA no PIOR cenário (bagunçado como o real) e o
// gabarito das perguntas — determinístico pela semente. Nada vai para o repositório.
//
//   node scripts/medicoes/ambiente-memorias/gerar-acervo-caotico.mjs [--destino ~/agent-code-ambiente-caotico] [--semente 7] [--total 600]
//
// Sujeiras de propósito: memória solta na raiz, em pasta genérica ou na pasta ERRADA;
// sem cabeçalho, sem data, data só no texto ou data inválida; título genérico ("anotação");
// erros de digitação e sem acento; repetidas reescritas; contradições (valor novo e data
// mais nova); memórias que misturam dois assuntos; temas parecidos; ruído dentro do tema
// ("ideia solta sobre a padaria") e fora dele. Cada pergunta leva etiquetas para medir onde
// a busca quebra (`analisar-caotico.mjs`).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { GERAIS, RUIDO, TEMAS } from './temas-caoticos.mjs'

const arg = (k, def) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? process.argv[i + 1] : def
}
const DESTINO = (arg('destino', join(homedir(), 'agent-code-ambiente-caotico'))).replace(/^~/, homedir())
const SEMENTE = Number(arg('semente', 7))
const TOTAL = Number(arg('total', 600))
const HOJE = Date.parse('2026-11-26T12:00:00Z')
const DIA = 86_400_000

// ---- aleatório com semente (mulberry32) ----
let s = SEMENTE >>> 0
const rnd = () => {
  s = (s + 0x6d2b79f5) >>> 0
  let t = s
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const chance = (p) => rnd() < p
const pick = (xs) => xs[Math.floor(rnd() * xs.length)]
const semAcento = (x) => x.normalize('NFD').replace(/[̀-ͯ]/g, '')
const slug = (x) => semAcento(x).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
const iso = (t) => new Date(t).toISOString().slice(0, 10)
const br = (t) => { const d = new Date(t); return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()}` }

const PARECIDOS = new Set(['padaria', 'confeitaria', 'horta-app', 'horta-comunitaria', 'clinica-vet', 'petshop'])
const PASTAS_GENERICAS = ['projetos', 'notas', 'misc', 'coisas', 'importante', 'trabalho']
// Nomes de pasta que um humano daria (às vezes ambíguos: "horta" serve aos dois temas).
const APELIDO_PASTA = { 'horta-app': ['horta-app', 'HortaFacil', 'horta'], 'horta-comunitaria': ['horta-comunitaria', 'horta', 'bairro'], 'clinica-vet': ['clinica-vet', 'vet', 'pets'], 'petshop': ['petshop', 'pets'] }
const TITULO_GENERICO = ['anotação', 'importante!!', 'ver isso', 'lembrete', 'nota rápida', 'obs']

/** Estraga o texto como gente com pressa escreve. */
function bagunca(t) {
  let x = t
  if (chance(0.5)) x = semAcento(x)
  if (chance(0.4)) x = x.replace(/\bque\b/g, 'q').replace(/\bvocê\b/gi, 'vc').replace(/\bpara\b/g, 'pra').replace(/\bporque\b/g, 'pq')
  if (chance(0.3)) x = x.toLowerCase()
  if (chance(0.2)) x = x.replace(/(\w{5,})/, (w) => w.slice(0, -2) + w.at(-1) + w.at(-2)) // troca duas letras
  return x
}

/** Reescreve o mesmo fato com outras palavras (repetida). */
const reescrever = (t) => pick([`Obs.: ${t}.`, `Confirmado de novo: ${t.toLowerCase()}`, `${t} (anotei de novo pra não esquecer)`, `Lembrete — ${semAcento(t)}`])

/** Contradição: troca o primeiro número (ou horário) por outro. */
function contradizer(t) {
  const m = /\d+/.exec(t)
  if (!m) return null
  const n = Number(m[0])
  const novo = n >= 10 ? n + Math.max(1, Math.round(n * 0.2)) : n + 1
  return t.replace(m[0], String(novo)) + ' (mudou)'
}

const memorias = [] // { caminho, texto }
const usados = new Set()
function salvar({ tema, texto, titulo, ondeTipo, dataTipo, dataBase, id = true }) {
  let pasta = ''
  if (ondeTipo === 'certa') pasta = pick(APELIDO_PASTA[tema] ?? [tema])
  else if (ondeTipo === 'generica') pasta = pick(PASTAS_GENERICAS)
  else if (ondeTipo === 'errada') pasta = pick(Object.keys(TEMAS).filter((x) => x !== tema))
  let nome = chance(0.15) ? `nota-${Math.floor(rnd() * 9000 + 1000)}` : slug(titulo || texto)
  let caminho = `${pasta ? pasta + '/' : ''}${nome}.md`
  while (usados.has(caminho)) caminho = caminho.replace(/\.md$/, `-${Math.floor(rnd() * 90 + 10)}.md`)
  usados.add(caminho)
  const criada = dataBase - Math.floor(rnd() * 30) * DIA
  let front = ''
  let corpo = texto
  if (dataTipo !== 'sem-cabecalho') {
    const linhas = []
    if (id) linhas.push(`id: mem-${slug(caminho).slice(0, 10)}-${Math.floor(rnd() * 1e6).toString(36)}`)
    linhas.push(`name: ${slug(titulo || texto).slice(0, 30)}`, `description: ${titulo || texto.slice(0, 70)}`)
    if (dataTipo === 'certa') linhas.push(`criada: ${iso(criada)}`, `modificada: ${iso(dataBase)}`)
    if (dataTipo === 'invalida') linhas.push(`criada: ${pick(['ontem', 'semana passada', '31/02/2026', 'TODO'])}`)
    front = `---\n${linhas.join('\n')}\n---\n`
  }
  if (dataTipo === 'texto') corpo += ` (atualizado em ${br(dataBase)})`
  writeFileSync(join(DESTINO, 'memorias', caminho), `${front}${titulo ? `# ${titulo}\n` : ''}${corpo}\n`)
  memorias.push({ caminho, tema })
  return caminho
}

const ondeAleatorio = () => { const r = rnd(); return r < 0.35 ? 'raiz' : r < 0.55 ? 'generica' : r < 0.65 ? 'errada' : 'certa' }
const dataAleatoria = () => { const r = rnd(); return r < 0.15 ? 'sem-cabecalho' : r < 0.45 ? 'sem-data' : r < 0.65 ? 'texto' : r < 0.75 ? 'invalida' : 'certa' }
const quandoAleatorio = () => HOJE - Math.floor(rnd() * 400) * DIA

rmSync(DESTINO, { recursive: true, force: true })
for (const p of ['', ...PASTAS_GENERICAS, ...Object.keys(TEMAS), ...Object.values(APELIDO_PASTA).flat()]) mkdirSync(join(DESTINO, 'memorias', p), { recursive: true })

const casos = []
const estilos = ['d', 'p', 'e']
let nEstilo = 0
const fatos = Object.entries(TEMAS).flatMap(([tema, lista]) => lista.map((f, i) => ({ tema, i, ...f })))
const porFato = new Map()

// 1) Fatos: principal + repetidas + contradição, cada um com sujeira sorteada.
for (const f of fatos) {
  const onde = ondeAleatorio()
  const dataTipo = dataAleatoria()
  const quando = quandoAleatorio()
  const generico = chance(0.15)
  const titulo = generico ? pick(TITULO_GENERICO) : (chance(0.3) ? '' : f.t.split(/[;:,]/)[0])
  const texto = chance(0.35) ? bagunca(f.t) : f.t
  const principal = salvar({ tema: f.tema, texto, titulo, ondeTipo: onde, dataTipo, dataBase: quando, id: chance(0.6) })
  const repetidas = []
  for (let k = 0, n = chance(0.4) ? (chance(0.3) ? 2 : 1) : 0; k < n; k++) {
    repetidas.push(salvar({ tema: f.tema, texto: reescrever(f.t), titulo: '', ondeTipo: ondeAleatorio(), dataTipo: dataAleatoria(), dataBase: quandoAleatorio() }))
  }
  let contra = null
  const tc = chance(0.2) ? contradizer(f.t) : null
  if (tc) contra = salvar({ tema: f.tema, texto: tc, titulo: '', ondeTipo: ondeAleatorio(), dataTipo: 'certa', dataBase: HOJE - Math.floor(rnd() * 20) * DIA })
  porFato.set(`${f.tema}#${f.i}`, { principal, repetidas, contra, onde, dataTipo, generico })
}

// 2) Memórias que misturam dois assuntos de temas diferentes (aceitáveis para os dois).
const mistas = new Map()
for (let k = 0; k < 12; k++) {
  const a = pick(fatos), b = pick(fatos.filter((x) => x.tema !== a.tema))
  const c = salvar({ tema: 'misto', texto: `${a.t}. Também: ${b.t}.`, titulo: pick(TITULO_GENERICO), ondeTipo: chance(0.5) ? 'raiz' : 'generica', dataTipo: dataAleatoria(), dataBase: quandoAleatorio() })
  for (const f of [a, b]) mistas.set(`${f.tema}#${f.i}`, [...(mistas.get(`${f.tema}#${f.i}`) ?? []), c])
}

// 3) Regras gerais (com uma repetida cada).
const gerais = GERAIS.map((g) => [
  salvar({ tema: 'geral', texto: g.t, titulo: g.t, ondeTipo: chance(0.6) ? 'raiz' : 'generica', dataTipo: dataAleatoria(), dataBase: quandoAleatorio() }),
  salvar({ tema: 'geral', texto: reescrever(g.t), titulo: '', ondeTipo: 'raiz', dataTipo: dataAleatoria(), dataBase: quandoAleatorio() })
])

// 4) Ruído até o total: notas soltas e "ideias" dentro dos temas (mesmas palavras, outro assunto).
const temasNomes = Object.keys(TEMAS)
while (memorias.length < TOTAL) {
  if (chance(0.55)) {
    const tema = pick(temasNomes)
    const palavra = pick(TEMAS[tema][0].t.split(' ').filter((w) => w.length > 4))
    salvar({ tema, texto: pick([`Ideia solta sobre ${palavra}: pensar depois`, `${palavra} — rever no mês que vem`, `Perguntar sobre ${palavra} na próxima reunião`, `Rascunho: algo com ${palavra}, não decidido`]), titulo: chance(0.5) ? pick(TITULO_GENERICO) : '', ondeTipo: ondeAleatorio(), dataTipo: dataAleatoria(), dataBase: quandoAleatorio() })
  } else {
    const r = pick(RUIDO)
    salvar({ tema: 'ruido', texto: chance(0.3) ? bagunca(r) : r, titulo: '', ondeTipo: chance(0.6) ? 'raiz' : 'generica', dataTipo: dataAleatoria(), dataBase: quandoAleatorio() })
  }
}

// ---- perguntas com gabarito e etiquetas ----
for (const f of fatos) {
  const m = porFato.get(`${f.tema}#${f.i}`)
  const estilo = estilos[nEstilo++ % 3]
  const grupo = m.repetidas.length ? [{ umaDe: [m.principal, ...m.repetidas] }] : [m.principal]
  const esperadas = m.contra ? [...grupo, m.contra] : grupo
  const tags = [`estilo:${estilo}`, `onde:${m.onde}`, `data:${m.dataTipo}`]
  if (m.repetidas.length) tags.push('repetida')
  if (m.contra) tags.push('contradicao')
  if (m.generico) tags.push('titulo-generico')
  if (PARECIDOS.has(f.tema)) tags.push('tema-parecido')
  casos.push({ id: `${f.tema}-${f.i}-${estilo}`, pedido: f[estilo], esperadas, aceitaveis: mistas.get(`${f.tema}#${f.i}`) ?? [], tags })
}
// Duas coisas no mesmo pedido.
for (let k = 0; k < 6; k++) {
  const a = pick(fatos), b = pick(fatos.filter((x) => x.tema !== a.tema))
  const ma = porFato.get(`${a.tema}#${a.i}`), mb = porFato.get(`${b.tema}#${b.i}`)
  const esp = (m) => (m.repetidas.length ? { umaDe: [m.principal, ...m.repetidas] } : m.principal)
  const aceit = [...new Set([...(mistas.get(`${a.tema}#${a.i}`) ?? []), ...(mistas.get(`${b.tema}#${b.i}`) ?? [])])]
  casos.push({ id: `dois-assuntos-${k}`, pedido: `${a.d} e também ${b.d}`, esperadas: [esp(ma), esp(mb)], aceitaveis: aceit, tags: ['dois-assuntos'] })
}
// Regras gerais.
GERAIS.forEach((g, k) => casos.push({ id: `geral-${k}`, pedido: g.d, esperadas: [{ umaDe: gerais[k] }], aceitaveis: [], tags: ['geral'] }))
// Nada se aplica.
;['bom dia!', 'obrigado, valeu', 'qual a capital da França?', 'me conta uma piada', 'tudo certo por aí?'].forEach((p, k) =>
  casos.push({ id: `nada-${k}`, pedido: p, esperadas: [], aceitaveis: [], tags: ['nada'] })
)

// Conferência: todo caminho do gabarito existe e as aceitáveis não repetem as esperadas.
const existe = new Set(memorias.map((m) => m.caminho))
for (const c of casos) {
  const esp = c.esperadas.flatMap((e) => (typeof e === 'string' ? [e] : e.umaDe))
  for (const p of [...esp, ...c.aceitaveis]) if (!existe.has(p)) throw new Error(`gabarito aponta para memória que não existe: ${p}`)
  c.aceitaveis = c.aceitaveis.filter((p) => !esp.includes(p))
}
writeFileSync(join(DESTINO, 'casos.json'), JSON.stringify({ casos }, null, 2))
const cont = (fn) => memorias.filter(fn).length
console.log(`acervo caótico (semente ${SEMENTE}): ${memorias.length} memórias, ${casos.length} perguntas em ${DESTINO}`)
console.log(`  soltas na raiz: ${cont((m) => !m.caminho.includes('/'))} · ruído: ${cont((m) => m.tema === 'ruido')} · mistas: ${cont((m) => m.tema === 'misto')}`)
