// Linha de base dos travamentos: imprime as métricas do card "Critérios de aceite: travamento
// resolvido em números" a partir de cópias dos logs do app.
//
// Uso: node scripts/analisa-travadas.mjs [--de <ISO>] [--ate <ISO>] <arquivo.log>...
//   Arquivos: %APPDATA%\agent-code-desktop\logs\travadas*.log e
//             %APPDATA%\agent-code-desktop\postgres-pool-diagnostics.log (o tipo é detectado
//             por linha, a ordem não importa). Rode sobre CÓPIAS — o app continua escrevendo nelas.
//   --de / --ate: recorta a janela pelo campo "at" (UTC, comparação por prefixo ISO).
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
let from = ''
let until = ''
const files = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--de') from = args[++i] ?? ''
  else if (args[i] === '--ate') until = args[++i] ?? ''
  else files.push(args[i])
}
if (!files.length) {
  console.error('uso: node scripts/analisa-travadas.mjs [--de <ISO>] [--ate <ISO>] <arquivo.log>...')
  process.exit(2)
}

const inWindow = (at) =>
  typeof at === 'string' && (!from || at >= from) && (!until || at.slice(0, until.length) <= until)

const freezes = []
const pool = []
for (const file of files) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue } // linha truncada pelo app ao girar o log
    if (!inWindow(row.at)) continue
    if (row.pool && typeof row.pool === 'object') pool.push(row)
    else if (typeof row.kind === 'string') freezes.push(row)
  }
}

// Mesmo percentil do script da fase de planejamento, para os números serem comparáveis.
const pct = (values, p) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}
const sum = (values) => values.reduce((a, b) => a + b, 0)
const msOf = (rows) => rows.map((r) => (typeof r.ms === 'number' ? r.ms : 0))
const minutes = (ms) => `${(ms / 60000).toFixed(1)} min`
const byDay = (rows) => {
  const days = {}
  for (const r of rows) days[r.at.slice(0, 10)] = (days[r.at.slice(0, 10)] ?? 0) + 1
  return days
}
const span = (rows) => {
  const ats = rows.map((r) => r.at).sort()
  return ats.length ? `${ats[0]} até ${ats.at(-1)}` : 'sem registros'
}

const frames = freezes.filter((r) => r.kind === 'quadro')
const slowFrames = frames.filter((r) => r.ms >= 500)
const phone = msOf(freezes.filter((r) => r.kind === 'trecho' && r.label === 'celular'))
const saving = msOf(freezes.filter((r) => r.kind === 'trecho' && r.label === 'salvamento'))
const switches = msOf(freezes.filter((r) => r.kind === 'troca'))
const waiting = pool.map((r) => (typeof r.pool.waitingCount === 'number' ? r.pool.waitingCount : 0))

console.log(`travadas: ${freezes.length} eventos (${span(freezes)})`)
console.log(`  quadros >= 500 ms ............ ${slowFrames.length}  (meta <= 5)  por dia UTC: ${JSON.stringify(byDay(slowFrames))}`)
console.log(`  p95 dos quadros longos ....... ${pct(msOf(frames), 95)} ms  (meta <= 200 ms)  [${frames.length} quadros]`)
console.log(`  soma trecho:celular .......... ${minutes(sum(phone))}  (meta <= 2 min)  [${phone.length} eventos]`)
console.log(`  soma trecho:salvamento ....... ${(sum(saving) / 1000).toFixed(0)} s = ${minutes(sum(saving))}  (meta <= 20 s)  [${saving.length} eventos]`)
console.log(`  troca de conversa ............ p50 ${pct(switches, 50)} ms, max ${switches.length ? Math.max(...switches) : 0} ms  (meta <= 100 ms)  [${switches.length} eventos]`)
console.log(`pool do Postgres: ${pool.length} registros (${span(pool)})  (meta 0)`)
console.log(`  por dia UTC .................. ${JSON.stringify(byDay(pool))}`)
console.log(`  fila maxima (waitingCount) ... ${waiting.length ? Math.max(...waiting) : 0}`)
