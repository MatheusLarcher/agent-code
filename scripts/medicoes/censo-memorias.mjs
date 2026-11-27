// Censo aproximado de uma pasta de memórias: sem cabeçalho, descrição cortada/vaga
// e grupos de memórias parecidas (repetição provável) por semelhança de palavras.
// Só lê. Uso: node scripts/medicoes/censo-memorias.mjs <pasta> [limiar=0.35]
// ponytail: Jaccard de palavras (nome + descrição + início do texto); troque por
// embeddings se precisar pegar repetição com palavras diferentes.
import fs from 'node:fs'
import p from 'node:path'

const pasta = process.argv[2]
const limiar = Number(process.argv[3] ?? 0.35)
if (!pasta) throw new Error('uso: node censo-memorias.mjs <pasta> [limiar]')

const files = []
;(function andar(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = p.join(d, e.name)
    if (e.isDirectory()) andar(f)
    else if (e.name.endsWith('.md') && e.name !== 'MEMORY.md') files.push(f)
  }
})(pasta)

const vazias = new Set('a o e de da do das dos em no na nos nas um uma para por com sem que se ao os as the and to of in nao mais quando ser sempre usuario agent code'.split(' '))
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const docs = files.map((f) => {
  const t = fs.readFileSync(f, 'utf8')
  const head = t.startsWith('---')
  const fm = head ? t.split('---')[1] ?? '' : ''
  const desc = (fm.match(/description:\s*(.*)/) ?? [])[1] ?? ''
  const corpo = t.replace(/^---[\s\S]*?---/, '')
  const texto = norm(`${p.basename(f, '.md').replace(/-/g, ' ')} ${desc} ${corpo.slice(0, 600)}`)
  const toks = new Set((texto.match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !vazias.has(w)))
  return { f: p.relative(pasta, f).split(p.sep).join('/'), head, desc, toks }
})

const n = docs.length
const pc = (x) => `${((100 * x) / n).toFixed(1)}%`
const semCab = docs.filter((d) => !d.head).length
const cortada = docs.filter((d) => d.head && /(…|\.\.\.)\s*$/.test(d.desc)).length
const vaga = docs.filter((d) => d.head && /^(ao |quando )?(mexer|editar|trabalhar|alterar)/.test(norm(d.desc))).length

const jaccard = (a, b) => {
  let i = 0
  for (const x of a) if (b.has(x)) i++
  return i / (a.size + b.size - i || 1)
}
// --sentido: semelhança de sentido (embeddings locais, transformers.js; baixa um
// modelo público na 1ª vez, o texto das memórias não sai do PC).
let semelhanca = (i, j) => jaccard(docs[i].toks, docs[j].toks)
if (process.argv.includes('--sentido')) {
  const { pipeline } = await import('@huggingface/transformers')
  const emb = await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2')
  const vec = []
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8').replace(/^---\s*\n/, '').slice(0, 1200)
    vec.push(Array.from((await emb(t, { pooling: 'mean', normalize: true })).data))
  }
  semelhanca = (i, j) => vec[i].reduce((s, x, k) => s + x * vec[j][k], 0)
}
const pai = [...Array(n).keys()]
const raiz = (x) => (pai[x] === x ? x : (pai[x] = raiz(pai[x])))
let pares = 0
for (let i = 0; i < n; i++)
  for (let j = i + 1; j < n; j++)
    if (semelhanca(i, j) >= limiar) {
      pares++
      pai[raiz(i)] = raiz(j)
    }
const grupos = {}
for (let i = 0; i < n; i++) (grupos[raiz(i)] ??= []).push(docs[i].f)
const gs = Object.values(grupos).filter((g) => g.length > 1).sort((a, b) => b.length - a.length)
const emGrupos = gs.reduce((s, g) => s + g.length, 0)
const sobra = gs.reduce((s, g) => s + g.length - 1, 0)

console.log(`total: ${n}`)
console.log(`sem cabeçalho: ${semCab} (${pc(semCab)})`)
console.log(`descrição cortada: ${cortada} (${pc(cortada)})`)
console.log(`descrição vaga ("ao mexer em..."): ${vaga} (${pc(vaga)})`)
console.log(`pares parecidos (limiar ${limiar}): ${pares}`)
console.log(`grupos de parecidas: ${gs.length} · memórias em grupos: ${emGrupos} (${pc(emGrupos)}) · sobrariam se juntasse: ${sobra} (${pc(sobra)})`)
for (const g of gs.slice(0, 8)) console.log(`  ${g.length} → ${g.slice(0, 4).join(' | ')}${g.length > 4 ? ' …' : ''}`)
