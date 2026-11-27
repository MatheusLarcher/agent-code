// Onde a busca quebra no acervo caótico: nota, cobertura e precisão por seletor e por
// etiqueta da pergunta (estilo, onde a memória estava, data, repetida, contradição…).
//
//   node scripts/medicoes/ambiente-memorias/analisar-caotico.mjs <pasta-da-rodada> [casos.json]
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const [rodada, casosArq = join(homedir(), 'agent-code-ambiente-caotico', 'casos.json')] = process.argv.slice(2)
if (!rodada) throw new Error('uso: analisar-caotico.mjs <pasta-da-rodada> [casos.json]')
const r = JSON.parse(readFileSync(join(rodada, 'resultado.json'), 'utf8'))
const tags = new Map(JSON.parse(readFileSync(casosArq, 'utf8')).casos.map((c) => [c.id, c.tags ?? []]))

const NOMES = {
  'estilo:d': 'pergunta direta', 'estilo:p': 'com outras palavras', 'estilo:e': 'com erro de digitação',
  'onde:raiz': 'memória solta na raiz', 'onde:generica': 'em pasta genérica', 'onde:errada': 'na pasta errada', 'onde:certa': 'na pasta certa',
  'data:sem-cabecalho': 'sem cabeçalho', 'data:sem-data': 'sem data', 'data:texto': 'data só no texto', 'data:invalida': 'data inválida', 'data:certa': 'data certa',
  repetida: 'tem repetidas', contradicao: 'tem contradição', 'titulo-generico': 'título genérico', 'tema-parecido': 'tema parecido com outro',
  'dois-assuntos': 'dois assuntos no pedido', geral: 'regra geral', nada: 'nada se aplica (não precisava de memória)', precisa: 'precisava de memória'
}
const pct = (x) => (x === null || Number.isNaN(x) ? '—' : `${Math.round(x * 100)}%`)
const media = (xs) => { const v = xs.filter((x) => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }

const seletores = [...new Set(r.execucoes.map((e) => e.seletor))]
const todas = [...new Set([...tags.values()].flat())].sort((a, b) => Object.keys(NOMES).indexOf(a) - Object.keys(NOMES).indexOf(b))
console.log(`| Cenário | n | ${seletores.map((s) => `${s} nota / cobertura / precisão`).join(' | ')} |`)
console.log(`|---|---|${seletores.map(() => '---').join('|')}|`)
const linha = (nome, filtro) => {
  const n = new Set(r.execucoes.filter(filtro).map((e) => e.caso)).size
  const cols = seletores.map((s) => {
    const es = r.execucoes.filter((e) => e.seletor === s && !e.falhou && filtro(e))
    return `${pct(media(es.map((e) => e.nota)))} / ${pct(media(es.map((e) => e.cobertura)))} / ${pct(media(es.map((e) => e.precisao)))}`
  })
  console.log(`| ${nome} | ${n} | ${cols.join(' | ')} |`)
}
linha('**TODAS**', () => true)
for (const t of todas) linha(NOMES[t] ?? t, (e) => (tags.get(e.caso) ?? []).includes(t))
const ms = seletores.map((s) => `${s}: ${Math.round(media(r.execucoes.filter((e) => e.seletor === s).map((e) => e.msOrdenador ?? e.ms)) ?? 0)} ms`)
console.log(`\nTempo médio por pedido — ${ms.join(' · ')}`)
