// Placar de uma ou mais rodadas da bateria (lado a lado para comparar antes × depois).
//   node scripts/bateria/placar.mjs <rodada> [<rodada> ...]     (sem argumento: a mais recente)
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const DIR = path.join(import.meta.dirname, '..', '..', 'docs', 'bateria', 'resultados')
const rodadas = process.argv.slice(2)
if (!rodadas.length && existsSync(DIR)) rodadas.push(readdirSync(DIR).sort().at(-1))
if (!rodadas[0]) throw new Error('nenhuma rodada em docs/bateria/resultados')

// Resposta (app): soma do `result` de cada turno no turn-timing (o relógio do executor olha a cada 3 s).
const s = (ms) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)} s` : '—')
const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

for (const rodada of rodadas) {
  const pasta = path.join(DIR, rodada)
  const rs = readdirSync(pasta).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(pasta, f), 'utf8')))
  console.log(`\n## ${rodada}${rs[0]?.modelo ? ` — ${rs[0].modelo} ${rs[0].esforco}` : ''}\n`)
  console.log('| Tarefa | Status | Nota | Resposta (app) | Até o CLI receber | 1º texto | Chamadas | Contexto | Cache lido / criado | Saída | Ferramentas | Perguntas | Falhou em |')
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  let soma = 0, n = 0
  for (const r of rs) {
    if (r.status === 'erro') { console.log(`| ${r.tarefa} | erro | — | | | | | | | | | | ${r.erro.slice(0, 60)} |`); continue }
    const t = r.tempos?.[0] ?? {}
    const c = r.contagem
    const falhas = r.itens.filter((i) => i.ok === false).map((i) => i.nome).join('; ') || '—'
    if (r.nota !== null) { soma += r.nota; n++ }
    console.log(`| ${r.tarefa} | ${r.status} | ${r.nota === null ? '—' : Math.round(r.nota * 100) + '%'} | ${s((r.tempos ?? []).reduce((soma, x) => soma + (x.result ?? 0), 0) || r.msTrabalho)} | ${s(t.enqueued)} | ${s(t.firstDelta)} | ${c.chamadas} | ${k(c.tokens.cacheLido + c.tokens.cacheCriado + c.tokens.entrada)} | ${k(c.tokens.cacheLido)} / ${k(c.tokens.cacheCriado)} | ${k(c.tokens.saida)} | ${c.ferramentas} | ${c.perguntas} | ${falhas} |`)
  }
  if (n) console.log(`\n**Nota média:** ${Math.round((soma / n) * 100)}% em ${n} tarefa(s).`)
  resumoRepeticoes(rs)
}

/** Com --repeticoes: uma linha por tarefa (média e faixa da nota, tempo mediano). Uma rodada só não prova nada. */
function resumoRepeticoes(rs) {
  const porTarefa = new Map()
  for (const r of rs) if (r.status !== 'erro' && r.nota !== null) porTarefa.set(r.tarefa, [...(porTarefa.get(r.tarefa) ?? []), r])
  if (![...porTarefa.values()].some((l) => l.length > 1)) return
  const mediana = (xs) => { const o = [...xs].sort((a, b) => a - b); return o[Math.floor(o.length / 2)] }
  console.log('\n| Tarefa | Rodadas | Nota média | Nota mín–máx | Tempo mediano | Perguntou (rodadas) |')
  console.log('|---|---|---|---|---|---|')
  for (const [tarefa, l] of porTarefa) {
    const notas = l.map((r) => r.nota)
    const tempo = mediana(l.map((r) => (r.tempos ?? []).reduce((soma, x) => soma + (x.result ?? 0), 0) || r.msTrabalho))
    console.log(`| ${tarefa} | ${l.length} | ${Math.round((notas.reduce((a, b) => a + b, 0) / l.length) * 100)}% | ${Math.round(Math.min(...notas) * 100)}–${Math.round(Math.max(...notas) * 100)}% | ${s(tempo)} | ${l.filter((r) => r.contagem.perguntas > 0).length}/${l.length} |`)
  }
}
