// Junta avaliação de código, revisão às cegas e tempo de todas as rodadas e aplica a
// regra de aprovação do replay (por tarefa, as 3 precisam passar):
//  - novo passa no avaliador de código em TODAS as rodadas (pass^k, k = ROUNDS), pelo menos tanto quanto hoje;
//  - média das notas do novo >= média do hoje em TODOS os critérios.
// Uso: node scripts/replay/report.mjs   (imprime as tabelas em markdown e grava resumo.json)
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { OUT, ORDER, ROUNDS, SIDES, paths } from './config.mjs'
import { codePass } from './evaluate.mjs'
import { CRITERIA } from './review.mjs'

const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null)
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

/** Uma rodada: avaliação de código (com as classes da revisão), notas e tempo. */
export function roundRow(t, side, n) {
  const ev = readJson(path.join(paths.out(t, side, n), 'eval.json'))
  const run = readJson(path.join(paths.out(t, side, n), 'run.json'))
  const review = readJson(paths.reviewResult(t, n))
  const mine = review?.[side]
  const classes = Object.fromEntries((mine?.falhas ?? []).map((f) => [f.id, f.tipo]))
  const timedOut = run?.implementation?.status !== 'done'
  return {
    t, side, n, exists: Boolean(ev), reviewed: Boolean(mine),
    // Teto estrito de 10 min para handoff + implementação: timeout reprova,
    // mesmo com código parcial verde. Estado ausente também não comprova conclusão.
    code: ev ? !timedOut && !run?.error && codePass(ev, classes) : false,
    timedOut, error: run?.error ?? null,
    typecheck: ev?.typecheck.ok ?? null, newFailures: ev?.suite.newFailures.length ?? null,
    ref: ev ? `${ev.reference.passed}/${ev.reference.total}` : '—',
    refBehavior: (mine?.falhas ?? []).filter((f) => f.tipo === 'comportamento').length,
    refName: (mine?.falhas ?? []).filter((f) => f.tipo === 'nome').length,
    notas: mine?.notas ?? null,
    diff: run?.diff ?? null,
    model: run?.implementation ? `${run.implementation.model}@${run.implementation.effort}` : '—',
    secsTotal: run?.time?.totals?.secsTotal ?? null,
    calls: run?.time?.totals?.calls ?? null,
    // O script combinado não conta edição delegada a subagente; aí vale o 1º Edit de qualquer um.
    secsFirstEdit: run?.time?.firstEdit?.secsToFirstEdit ?? run?.time?.totals?.secsToFirstEditAny ?? null,
    callsFirstEdit: run?.time?.firstEdit?.callsToFirstEdit ?? null,
    nudges: run?.implementation?.nudges ?? null
  }
}

/** Veredito de uma tarefa a partir das 6 rodadas. */
export function taskVerdict(rows) {
  const by = (side) => rows.filter((r) => r.side === side)
  const passes = (side) => by(side).filter((r) => r.code).length
  const avg = (side, c) => mean(by(side).filter((r) => r.notas).map((r) => r.notas[c]))
  const criteria = Object.fromEntries(CRITERIA.map((c) => [c, { hoje: avg('hoje', c), novo: avg('novo', c) }]))
  const worse = CRITERIA.filter((c) => criteria[c].novo === null || criteria[c].hoje === null || criteria[c].novo < criteria[c].hoje)
  const passNovo = passes('novo')
  const passHoje = passes('hoje')
  // Sem as 6 avaliações e as 3 revisões não há veredito (uma revisão só não aprova nada).
  const incomplete = rows.filter((r) => !r.exists || !r.reviewed).map((r) => `${r.side} r${r.n}${!r.exists ? ' sem avaliação' : ' sem revisão'}`)
  if (incomplete.length) return { passHoje, passNovo, criteria, approved: false, incomplete: true, reasons: [`incompleta: ${incomplete.join(', ')}`] }
  const reasons = []
  if (passNovo < ROUNDS) reasons.push(`novo passou no avaliador de código em ${passNovo}/${ROUNDS} (precisa ${ROUNDS}/${ROUNDS})`)
  if (passNovo < passHoje) reasons.push(`novo passou menos que hoje no código (${passNovo} × ${passHoje})`)
  for (const c of worse) reasons.push(`nota média de "${c}" do novo abaixo da do hoje`)
  return { passHoje, passNovo, criteria, approved: reasons.length === 0, reasons }
}

export function buildReport() {
  const tasks = {}
  for (const t of ORDER) {
    const rows = []
    for (const side of Object.keys(SIDES)) for (let n = 1; n <= ROUNDS; n++) rows.push(roundRow(t, side, n))
    tasks[t] = { rows, verdict: taskVerdict(rows) }
  }
  const approved = Object.values(tasks).every((x) => x.verdict.approved)
  return { tasks, approved }
}

const fmt = (v, d = 1) => (v === null || v === undefined ? '—' : typeof v === 'number' ? v.toFixed(d).replace(/\.0+$/, '') : String(v))
const mins = (s) => (s === null ? '—' : `${Math.round(s / 60)} min`)

export function markdown(report) {
  const lines = ['| Tarefa | Lado | Rodada | Código | Typecheck | Falhas novas | Ref. (passou) | Ref. comport./nome | Atende | Bugs | Bordas | Regras | Diff | Total | 1º Edit | Chamadas |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|']
  for (const [t, { rows }] of Object.entries(report.tasks)) {
    for (const r of rows) {
      const nt = r.notas ?? {}
      lines.push(`| ${t} | ${r.side} | ${r.n} | ${!r.exists ? 'não rodou' : r.code ? '✅' : '❌'}${r.exists && r.timedOut ? ' ⏱' : ''} | ${r.typecheck === null ? '—' : r.typecheck ? 'ok' : 'erro'} | ${fmt(r.newFailures, 0)} | ${r.ref} | ${r.refBehavior}/${r.refName} | ${fmt(nt.atende, 0)} | ${fmt(nt.bugs, 0)} | ${fmt(nt.bordas, 0)} | ${fmt(nt.regras, 0)} | ${r.diff ? `${r.diff.files} arq. +${r.diff.add}/-${r.diff.del}` : '—'} | ${mins(r.secsTotal)} | ${mins(r.secsFirstEdit)} | ${fmt(r.calls, 0)} |`)
    }
  }
  lines.push('', `| Tarefa | pass^${ROUNDS} hoje | pass^${ROUNDS} novo | Atende (h × n) | Bugs | Bordas | Regras | Veredito |`, '|---|---|---|---|---|---|---|---|')
  for (const [t, { verdict: v }] of Object.entries(report.tasks)) {
    const c = (k) => `${fmt(v.criteria[k].hoje, 2)} × ${fmt(v.criteria[k].novo, 2)}`
    lines.push(`| ${t} | ${v.passHoje}/${ROUNDS} | ${v.passNovo}/${ROUNDS} | ${c('atende')} | ${c('bugs')} | ${c('bordas')} | ${c('regras')} | ${v.approved ? 'aprovada' : `reprovada: ${v.reasons.join('; ')}`} |`)
  }
  const incomplete = Object.values(report.tasks).some((x) => x.verdict.incomplete)
  lines.push('', `**Veredito geral:** ${report.approved ? 'APROVADO — as 3 tarefas passaram' : incomplete ? 'INCOMPLETO — faltam rodadas ou revisões; a implantação fica desligada' : 'REPROVADO — a implantação fica desligada'}`)
  return lines.join('\n')
}

if (process.argv[1]?.endsWith('report.mjs')) {
  const report = buildReport()
  writeFileSync(path.join(OUT, 'resumo.json'), JSON.stringify(report, null, 2))
  console.log(markdown(report))
}
