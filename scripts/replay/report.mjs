// Junta avaliação de código, revisão às cegas e tempo de todas as rodadas e aplica a
// regra de aprovação do replay (por tarefa, as 3 precisam passar):
//  - novo passa no avaliador de código em TODAS as rodadas (pass^k, k = ROUNDS), pelo menos tanto quanto hoje;
//  - média das notas do novo >= média do hoje em TODOS os critérios.
// Uso: node scripts/replay/report.mjs   (imprime as tabelas em markdown e grava resumo.json)
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { AUTONOMY_TASKS, OUT, ORDER, ROUNDS, SIDES, outOf, paths, sidesOf } from './config.mjs'
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

// ---------------------------------------------------------------------------
// Validação da autonomia do handoff (plano-20261010-0616): sessão real × novo build
// ---------------------------------------------------------------------------

/** Os eventos do condutor que a autonomia tem de zerar (drive.mjs). */
export const AUTONOMY_EVENTS = ['pergunta', 'insistencia', 'proximo-prompt', 'primeiro-prompt-forcado']
/** Parada média depois de um turno que perguntou (medição de 09/10): base da PROJEÇÃO de parede. */
export const STOP_AFTER_QUESTION_MIN = 14

export function eventCounts(events) {
  const out = Object.fromEntries(AUTONOMY_EVENTS.map((k) => [k, 0]))
  for (const e of Array.isArray(events) ? events : []) if (e?.kind in out) out[e.kind]++
  return out
}

/** Uma rodada da validação: eventos, contadores da conversa (os da sessão base), avaliação e revisão × referência. */
export function autonomyRow(t, side, n) {
  const dir = paths.out(t, side, n)
  const run = readJson(path.join(dir, 'run.json'))
  const ev = readJson(path.join(dir, 'eval.json'))
  const events = readJson(path.join(dir, 'events.json'))
  const review = readJson(paths.reviewResult(t, n))
  const classes = Object.fromEntries((review?.[side]?.falhas ?? []).map((f) => [f.id, f.tipo]))
  const a = run?.autonomy ?? null
  return {
    t, side, n, exists: Boolean(run && ev && events),
    status: run?.implementation?.status ?? null, error: run?.error ?? null,
    events: eventCounts(events),
    activeSecs: a?.activeSecs ?? null, calls: a?.calls ?? null, avgContextTokens: a?.avgContextTokens ?? null,
    askUserQuestion: a?.askUserQuestion ?? null, turnsEndingInQuestion: a?.turnsEndingInQuestion ?? null,
    atencao: a?.atencaoLines ?? null, desvio: a?.desvioLines ?? null,
    typecheck: ev?.typecheck.ok ?? null, newFailures: ev?.suite.newFailures.length ?? null,
    missing: ev?.suite.missingFromParent?.length ?? null,
    ref: ev ? `${ev.reference.passed}/${ev.reference.total}` : '—',
    refOk: ev ? codePass(ev, classes) : false,
    review: review ? { novo: review[side]?.notas ?? null, referencia: review.referencia?.notas ?? null } : null
  }
}

/**
 * O veredito por meta (as metas do card não se ajustam para passar). Rodada que falta
 * deixa a meta INCOMPLETA, que não aprova. A revisão "sem regressão" é estrita: o novo
 * não fica abaixo da referência em nenhum critério.
 */
export function autonomyVerdict(base, rows) {
  const all = (pred) => rows.length > 0 && rows.every((r) => r.exists && pred(r))
  const missing = rows.filter((r) => !r.exists).map((r) => `r${r.n}`)
  const meta = (id, texto, ok, detalhe) => ({ id, texto, ok: missing.length ? null : ok, detalhe })
  const metas = [
    meta('pergunta', 'nenhuma pergunta não destrutiva chega ao usuário (pergunta = 0)', all((r) => r.events.pergunta === 0), rows.map((r) => r.events.pergunta).join(' / ')),
    meta('insistencia', 'nenhum turno termina perguntando (insistência = 0)', all((r) => r.events.insistencia === 0), rows.map((r) => r.events.insistencia).join(' / ')),
    meta('proximo-prompt', 'a fila solta os prompts 2..N sozinha (próximo-prompt = 0)', all((r) => r.events['proximo-prompt'] === 0), rows.map((r) => r.events['proximo-prompt']).join(' / ')),
    meta('primeiro-prompt-forcado', 'o 1º prompt sai sem o condutor forçar (= 0)', all((r) => r.events['primeiro-prompt-forcado'] === 0), rows.map((r) => r.events['primeiro-prompt-forcado']).join(' / ')),
    meta('tempo-ativo', `tempo ativo ≤ base (${base.activeSecs} s)`, all((r) => r.activeSecs !== null && r.activeSecs <= base.activeSecs), rows.map((r) => r.activeSecs ?? '—').join(' / ')),
    meta('chamadas', `chamadas ≤ base (${base.calls})`, all((r) => r.calls !== null && r.calls <= base.calls), rows.map((r) => r.calls ?? '—').join(' / ')),
    meta('contexto', `contexto médio ≤ base (${base.avgContextTokens})`, all((r) => r.avgContextTokens !== null && r.avgContextTokens <= base.avgContextTokens), rows.map((r) => r.avgContextTokens ?? '—').join(' / ')),
    meta('concluiu', 'implementação terminou dentro do teto', all((r) => r.status === 'done' && !r.error), rows.map((r) => r.status ?? '—').join(' / ')),
    meta('testes', 'typecheck verde, sem falha nova nem teste sumido', all((r) => r.typecheck === true && r.newFailures === 0 && r.missing === 0), rows.map((r) => `${r.typecheck ? 'ok' : 'erro'}, ${r.newFailures ?? '—'} novas, ${r.missing ?? '—'} sumidos`).join(' / ')),
    meta('referencia', 'testes de referência passando (falha só de nome não conta)', all((r) => r.refOk), rows.map((r) => r.ref).join(' / ')),
    meta('revisao', 'revisão às cegas sem regressão contra o diff original', all((r) => Boolean(r.review?.novo && r.review?.referencia) && CRITERIA.every((c) => r.review.novo[c] >= r.review.referencia[c])), rows.map((r) => (r.review?.novo ? CRITERIA.map((c) => `${c} ${r.review.novo[c]}×${r.review.referencia?.[c]}`).join(', ') : 'sem revisão')).join(' / '))
  ]
  const failed = metas.filter((m) => m.ok === false).map((m) => m.id)
  const incomplete = missing.length > 0 || metas.some((m) => m.ok === null)
  return { metas, approved: !incomplete && failed.length === 0, incomplete, failed, missing }
}

/** PROJEÇÃO (não medição) do tempo de parede poupado: turnos que deixaram de perguntar × parada média medida. */
export function wallProjection(base, rows) {
  const done = rows.filter((r) => r.exists && r.turnsEndingInQuestion !== null)
  if (!done.length) return null
  const after = mean(done.map((r) => r.turnsEndingInQuestion))
  const turns = Math.max(0, base.turnsEndingInQuestion - after)
  return { turnsSaved: turns, minutesSaved: Math.round(turns * STOP_AFTER_QUESTION_MIN), basis: `${STOP_AFTER_QUESTION_MIN} min de parada média por turno que perguntava (medição de 09/10)` }
}

export function autonomyMarkdown(base, rows, verdict) {
  const cols = ['Métrica', 'Base (sessão real)', ...rows.map((r) => `${r.side}-r${r.n}`)]
  const line = (label, b, f) => `| ${label} | ${b} | ${rows.map((r) => (r.exists ? f(r) : 'não rodou')).join(' | ')} |`
  const lines = [`| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`]
  lines.push(line('pergunta (chegou ao usuário)', `${base.askUserQuestion} AskUserQuestion, ${base.expired7min} expirada(s) em 7 min`, (r) => r.events.pergunta))
  lines.push(line('insistência (turno terminou perguntando)', `${base.turnsEndingInQuestion} turno(s)`, (r) => r.events.insistencia))
  lines.push(line('próximo-prompt (fila não soltou)', `${base.lateHandoffPrompts}`, (r) => r.events['proximo-prompt']))
  lines.push(line('primeiro-prompt-forcado', '—', (r) => r.events['primeiro-prompt-forcado']))
  lines.push(line('AskUserQuestion no transcript', base.askUserQuestion, (r) => fmt(r.askUserQuestion, 0)))
  lines.push(line('tempo ativo', mins(base.activeSecs), (r) => mins(r.activeSecs)))
  lines.push(line('chamadas ao modelo', base.calls, (r) => fmt(r.calls, 0)))
  lines.push(line('contexto médio por chamada (tokens)', base.avgContextTokens, (r) => fmt(r.avgContextTokens, 0)))
  lines.push(line('implementação', 'concluída', (r) => r.status ?? '—'))
  lines.push(line('typecheck / falhas novas / sumidos', '—', (r) => `${r.typecheck ? 'ok' : 'erro'} / ${fmt(r.newFailures, 0)} / ${fmt(r.missing, 0)}`))
  lines.push(line('testes de referência', 'todos', (r) => r.ref))
  lines.push(line('linhas ATENÇÃO / DESVIO DO PLANO (não é meta)', `${base.atencaoLines} / ${base.desvioLines}`, (r) => `${fmt(r.atencao, 0)} / ${fmt(r.desvio, 0)}`))
  lines.push('', '| Meta | Resultado | Valores por rodada |', '|---|---|---|')
  for (const m of verdict.metas) lines.push(`| ${m.texto} | ${m.ok === null ? 'incompleta' : m.ok ? '✅' : '❌'} | ${m.detalhe} |`)
  const proj = wallProjection(base, rows)
  if (proj) lines.push('', `**Tempo de parede (PROJEÇÃO, não medição):** ${proj.turnsSaved} turno(s) a menos terminando em pergunta × ${proj.basis} ≈ ${proj.minutesSaved} min de parede poupados por envio.`)
  lines.push('', `**Veredito:** ${verdict.approved ? 'APROVADO — todas as metas atendidas' : verdict.incomplete ? `INCOMPLETO — ${verdict.missing.length ? `rodadas sem resultado: ${verdict.missing.join(', ')}` : 'meta sem dado'}` : `REPROVADO — metas não atendidas: ${verdict.failed.join(', ')}`}`)
  return lines.join('\n')
}

if (process.argv[1]?.endsWith('report.mjs')) {
  const report = buildReport()
  writeFileSync(path.join(OUT, 'resumo.json'), JSON.stringify(report, null, 2))
  console.log(markdown(report))
  for (const t of AUTONOMY_TASKS) {
    const base = readJson(path.join(outOf(t), 'baseline-sessao.json'))
    if (!base) continue
    const rows = Array.from({ length: ROUNDS }, (_, i) => autonomyRow(t, Object.keys(sidesOf(t))[0], i + 1))
    const verdict = autonomyVerdict(base, rows)
    writeFileSync(path.join(outOf(t), 'resumo-autonomia.json'), JSON.stringify({ base, rows, verdict }, null, 2))
    console.log(`\n## Validação da autonomia — ${t}\n\n${autonomyMarkdown(base, rows, verdict)}`)
  }
}
