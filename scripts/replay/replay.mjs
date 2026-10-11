// Arnês do replay: refaz 3 tarefas reais do agent-code com os interruptores
// desligados (hoje) e ligados (novo), numa instância isolada, e avalia o resultado.
// Uso (uma rodada por vez — a máquina do usuário já travou com coisa em paralelo):
//   node scripts/replay/replay.mjs prepare <t>              cópia no commit pai + node_modules em dia
//   node scripts/replay/replay.mjs baseline <t>             linha de base do commit pai + testes da referência
//   node scripts/replay/replay.mjs plan <t>                 cria (uma vez) o plano congelado a partir do pedido original
//   node scripts/replay/replay.mjs round <t> <hoje|novo> <n> uma rodada: handoff → implementação → diff → avaliação → tempo
//   node scripts/replay/replay.mjs batch <t>                as rodadas da tarefa, em série e intercaladas
//   node scripts/replay/replay.mjs publish <t>              depois das revisões: saídas privadas → docs/validation
//   node scripts/replay/replay.mjs retire <t>               tarefa terminada: apaga a cópia (ordem em config.mjs)
//   node scripts/replay/replay.mjs status                   o que já foi feito
// Detalhes de cada passo em README.md desta pasta.
import { execSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MANAGER, OUT, PLAN_TIMEOUT_MS, PRIVATE, PROTECTED, REPO, ROOT, ROUNDS, TASKS, USER_SKILLS, outOf, paths, referenceSpecOf, roundTimeoutOf, sidesOf } from './config.mjs'
import { roundAutonomy } from './baseline-sessao.mjs'
import { driveUntilDone, pendingBackground, quietSince } from './drive.mjs'
import { evaluateRound, stableFailures, typecheck, vitest } from './evaluate.mjs'
import { configure, freeCommitGb, launch, openProject, seedDataDir, shutdown, waitForMemory } from './instance.mjs'
import { claudeProjectSlug, collectTranscripts, implementationTotals, parseFirstEdit, runMedirExploracao } from './measure.mjs'
import { forbiddenRoots, writeFence } from './fence.mjs'
import { askManagerForHandoff, releaseHeldHandoff, reopenPlan, sendToImplementation, waitHandoffWritten } from './planningUi.mjs'
import { applyCommitFiles, assertNoReference, collectDiff, ensureStandaloneRepo, git, referenceTestFiles, resetWorktree } from './worktree.mjs'

/** Memória comprometida livre (GB): para abrir uma rodada (pico ~4–5 GB), para avaliar, e o piso que aborta a rodada. */
const MIN_FREE_GB = 6
const MIN_FREE_EVAL_GB = 4
const ABORT_BELOW_GB = 0.5
const PLAN_NUDGE ='Pode seguir com as opções que você recomenda. Feche o roteiro e os cards; o handoff eu peço depois.'
const samePath = (a, b) => path.resolve(String(a ?? '')).toLowerCase() === path.resolve(String(b ?? '')).toLowerCase()
/** O handoff consome o mesmo teto da implementação; orçamento esgotado não ganha tempo. */
export const remainingRoundMs = (timeoutMs, startedAt, now = Date.now()) => Math.max(0, timeoutMs - (now - startedAt))
/** O commit pai da tarefa: `parent` quando a entrega foi uma faixa de commits; senão o pai da referência. */
const parentOf = (t) => git(REPO, ['rev-parse', TASKS[t].parent ?? `${TASKS[t].reference}^`]).trim()
const writeJson = (file, data) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2))
}

function logger(file) {
  mkdirSync(path.dirname(file), { recursive: true })
  return (...a) => {
    const line = `${new Date().toISOString()} ${a.join(' ')}`
    console.log(line)
    appendFileSync(file, line + '\n')
  }
}

/** Pasta dos transcripts da cópia (a instância usa o ~/.claude real para o login). */
const transcriptsDir = (worktree) => path.join(os.homedir(), '.claude', 'projects', claudeProjectSlug(worktree))
/** Transcripts de execução anterior (interrompida) misturariam a medição. */
const clearStaleTranscripts = (worktree) => rmSync(transcriptsDir(worktree), { recursive: true, force: true })

/**
 * Prepara a cópia da tarefa para uma execução: repositório recriado no commit pai (sem o
 * commit de referência, sem resto de rodada anterior) e a cerca de leitura gravada.
 * Gravável: a cópia, o perfil isolado e o cache da instância (plano, memórias, skills).
 * Proibido, além do que está fora da rodada: os dados do próprio app da instância
 * (userData, localappdata) — os logs dele são do build ATUAL, que já tem as soluções.
 */
function prepareRun(t, runData) {
  const wt = paths.worktree(t)
  const parent = parentOf(t)
  ensureStandaloneRepo(REPO, wt, parent)
  assertNoReference(wt, TASKS[t].reference)
  clearStaleTranscripts(wt)
  const real = { appData: process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), localAppData: process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local') }
  const forbidden = [
    ...forbiddenRoots({ worktree: wt, runData, root: ROOT, repo: REPO, ...real, home: os.homedir(), oneDrive: 'D:\\OneDrive' }),
    path.join(runData, 'userData'),
    path.join(runData, 'localappdata'),
    path.join(runData, 'projects')
  ]
  writeFence(wt, forbidden)
  const writable = [path.join(runData, 'perfil'), path.join(runData, 'agent-code')]
  return { wt, parent, ctx: { answered: new Set(), events: [], policy: { worktree: wt, writable, protectedPaths: PROTECTED, forbidden } } }
}

/**
 * Cópia pronta para a tarefa: repositório no commit pai e node_modules em dia com o lockfile
 * dele. `install` (não `ci`) aproveita o node_modules que já está na pasta. Sem scripts: o
 * projeto não tem módulo nativo, e o postinstall (playwright install chromium) já travou e
 * não serve às rodadas.
 */
function cmdPrepare(t) {
  const wt = paths.worktree(t)
  const parent = parentOf(t)
  ensureStandaloneRepo(REPO, wt, parent)
  execSync('npm install --no-audit --no-fund --ignore-scripts', { cwd: wt, stdio: 'inherit' })
  resetWorktree(wt, parent)
  console.log(`[${t}] cópia pronta em ${wt} (pai ${parent.slice(0, 7)})`)
}

/** Linha de base: o commit pai (typecheck + suíte) e os testes da referência no pai e na própria referência. */
async function cmdBaseline(t) {
  const wt = paths.worktree(t)
  const parent = parentOf(t)
  ensureStandaloneRepo(REPO, wt, parent)
  resetWorktree(wt, parent)
  const refTests = referenceTestFiles(REPO, referenceSpecOf(t))
  const testFiles = refTests.filter((f) => /\.test\./.test(f))
  const log = logger(path.join(outOf(t), t, 'baseline.log'))
  await waitForMemory(MIN_FREE_EVAL_GB, { log })
  log(`[${t}] typecheck do pai ${parent.slice(0, 7)}`)
  const tc = typecheck(wt)
  log(`[${t}] suíte do pai`)
  const suite = vitest(wt)
  const stable = stableFailures(wt, suite)
  log(`[${t}] testes da referência no pai (devem falhar: mostram que discriminam)`)
  applyCommitFiles(REPO, wt, referenceSpecOf(t), refTests)
  const refAtParent = vitest(wt, testFiles, 20 * 60_000)
  resetWorktree(wt, parent)
  log(`[${t}] testes da referência na própria referência (teto)`)
  // Pai + todos os arquivos que o commit mudou = a árvore da referência (que não existe na cópia).
  applyCommitFiles(REPO, wt, referenceSpecOf(t))
  const refAtReference = vitest(wt, testFiles, 20 * 60_000)
  resetWorktree(wt, parent)
  const brief = (r) => ({ total: r.total, passed: r.passed ?? 0, failed: r.failed.map((f) => f.id), crashed: r.crashed })
  // passedIds: para achar, na rodada, os testes que passavam no pai e sumiram.
  const data = { parent, typecheck: { ok: tc.ok, errors: tc.errors, tail: tc.ok ? '' : tc.tail }, suite: { ...brief(suite), stable: stable.map((f) => f.id), passedIds: suite.passedIds ?? [] }, refTests, refAtParent: brief(refAtParent), refAtReference: brief(refAtReference) }
  writeJson(paths.baseline(t), data)
  log(`[${t}] base: typecheck ${tc.ok ? 'ok' : `${tc.errors} erros`} | suíte ${suite.total} testes, ${suite.failed.length} falhas (${stable.length} persistem sozinhas) | referência no pai ${data.refAtParent.passed}/${data.refAtParent.total} | na referência ${data.refAtReference.passed}/${data.refAtReference.total}`)
}

/**
 * Plano da tarefa 2: cópia do plano original restrita ao escopo do handoff 1 — sem as
 * etapas/cards/seções do handoff 2 (UI).
 */
function prepareCopiedPlan(t) {
  const spec = TASKS[t].plan
  const dest = paths.frozenPlan(t)
  rmSync(dest, { recursive: true, force: true })
  cpSync(spec.from, dest, { recursive: true, filter: (src) => !/[\\/](_handoff|_sandbox)([\\/]|$)/.test(src) })
  const roteiroFile = path.join(dest, '_roteiro.md')
  // Os status ficam como no original: "concluida" no roteiro = etapa ESPECIFICADA
  // (regra do Manager), que é o estado de um plano pronto para handoff.
  const roteiro = readFileSync(roteiroFile, 'utf8')
    .split('\n')
    .filter((line) => !spec.semEtapas.some((id) => line.includes(`] ${id}:`) || line.includes(`est ${id}:`)))
    .join('\n')
  writeFileSync(roteiroFile, roteiro)
  const cardsDir = path.join(dest, 'cards')
  const removed = []
  for (const file of readdirSync(cardsDir)) {
    const text = readFileSync(path.join(cardsDir, file), 'utf8')
    const etapa = /^etapa:\s*"?([\w-]+)"?/m.exec(text)?.[1]
    if (!spec.semEtapas.includes(etapa)) continue
    removed.push(/^id:\s*"?([\w-]+)"?/m.exec(text)?.[1])
    rmSync(path.join(cardsDir, file))
  }
  // Links para os cards tirados ficariam órfãos no cabeçalho dos que ficaram.
  for (const file of readdirSync(cardsDir)) {
    const f = path.join(cardsDir, file)
    const text = readFileSync(f, 'utf8').replace(/^links:\s*\[(.*)\]$/m, (_, list) => `links: [${list.split(',').filter((x) => !removed.includes(x.trim().replace(/"/g, ''))).join(',')}]`)
    writeFileSync(f, text)
  }
  for (const [file, heading] of Object.entries(spec.semSecoes ?? {})) {
    const f = path.join(cardsDir, file)
    const text = readFileSync(f, 'utf8')
    const start = text.indexOf(heading)
    const next = text.indexOf('\n**', start + heading.length)
    if (start >= 0) writeFileSync(f, text.slice(0, start) + (next >= 0 ? text.slice(next + 1) : ''))
  }
  writeJson(path.join(dest, '..', `${t}.json`), { slug: spec.slug, origem: spec.from })
  console.log(`[${t}] plano copiado para ${dest}\n${roteiro}`)
}

/** Plano congelado das tarefas 1 e 3: o Manager planeja UMA vez, com os interruptores desligados. */
async function cmdPlan(t) {
  if (TASKS[t].plan.kind === 'copy') return prepareCopiedPlan(t)
  const runData = path.join(ROOT, 'runs', `${t}-plan`)
  rmSync(runData, { recursive: true, force: true })
  const { wt, parent, ctx } = prepareRun(t, runData)
  seedDataDir(runData, { userSkillsDir: USER_SKILLS })
  const log = logger(path.join(outOf(t), t, 'plan.log'))
  const pedido = readFileSync(path.join(OUT, 'pedidos', `${t}.md`), 'utf8')
  await waitForMemory(MIN_FREE_GB, { log })
  const { app, page, bridge } = await launch(runData, { log })
  let slug = null
  try {
    await configure(page, { side: Object.values(sidesOf(t))[0], manager: MANAGER })
    await openProject(app, page, wt)
    const created = await bridge.createPlan(wt, pedido)
    if (!created.ok) throw new Error(`não criou o planejamento: ${JSON.stringify(created)}`)
    log(`[${t}] planejamento criado na conversa ${created.convId}`)
    const res = await driveUntilDone(bridge, ctx, { pick: (s) => s.conversations.find((c) => c.id === created.convId), timeoutMs: PLAN_TIMEOUT_MS, idleMs: 60_000, maxNudges: 3, nudgeText: PLAN_NUDGE, log })
    slug = res.convId ? (await bridge.state()).conversations.find((c) => c.id === created.convId)?.planningSlug : null
    log(`[${t}] Manager terminou: ${res.status}, ${res.nudges} insistências, slug ${slug}`)
    writeJson(path.join(outOf(t), t, 'plan-events.json'), { res, events: ctx.events })
  } finally {
    await shutdown(app, runData, { log })
  }
  if (!slug) throw new Error('slug do plano não encontrado')
  const src = path.join(runData, 'agent-code', 'planning', 'agent-code', slug)
  const dest = paths.frozenPlan(t)
  rmSync(dest, { recursive: true, force: true })
  cpSync(src, dest, { recursive: true, filter: (p) => !/[\\/](_handoff|_sandbox)([\\/]|$)/.test(p) })
  writeJson(path.join(dest, '..', `${t}.json`), { slug, criadoEm: new Date().toISOString() })
  cpSync(dest, path.join(outOf(t), t, 'plano-congelado'), { recursive: true })
  collectTranscripts(wt, runData)
  resetWorktree(wt, parent)
  log(`[${t}] plano congelado em ${dest}`)
}

/** Uma rodada: plano congelado → handoff (com os interruptores do lado) → implementação → avaliação. */
async function cmdRound(t, side, n, smoke = false) {
  const sides = sidesOf(t)
  if (!sides[side] || !(n >= 1 && n <= ROUNDS)) throw new Error(`uso: round <t> <${Object.keys(sides).join('|')}> <1..${ROUNDS}> [--smoke]`)
  // Fumaça: mesma rodada com teto curto, gravada à parte (não conta no resultado).
  const out = smoke ? path.join(PRIVATE, 'fumaca', `${t}-${side}`) : paths.out(t, side, n)
  const runData = smoke ? path.join(ROOT, 'runs', `fumaca-${t}-${side}`) : paths.runData(t, side, n)
  const timeoutMs = smoke ? 8 * 60_000 : roundTimeoutOf(t)
  const meta = JSON.parse(readFileSync(path.join(paths.frozenPlan(t), '..', `${t}.json`), 'utf8'))
  const baseline = JSON.parse(readFileSync(paths.baseline(t), 'utf8'))
  rmSync(runData, { recursive: true, force: true })
  rmSync(out, { recursive: true, force: true })
  const { wt, parent, ctx } = prepareRun(t, runData)
  seedDataDir(runData, { userSkillsDir: USER_SKILLS, plan: { from: paths.frozenPlan(t), projectKey: 'agent-code', slug: meta.slug } })
  const log = logger(path.join(out, 'run.log'))
  writeJson(path.join(out, 'cerca.json'), ctx.policy.forbidden)
  const run = { task: t, side, round: n, switches: sides[side], manager: MANAGER, timeoutMs, startedAt: new Date().toISOString() }
  run.memoryBefore = await waitForMemory(MIN_FREE_GB, { log })
  const { app, page, bridge } = await launch(runData, { log })
  try {
    run.config = await configure(page, { side: sides[side], manager: MANAGER })
    await openProject(app, page, wt)
    await reopenPlan(page, meta.slug)
    const managerPick = (s) => s.conversations.find((c) => c.mode === 'planning' && c.planningSlug === meta.slug)
    // O teto (handoff + implementação) começa no pedido de handoff.
    const h0 = Date.now()
    await askManagerForHandoff(page)
    run.handoff = await waitHandoffWritten(page, bridge, ctx, { managerPick, timeoutMs: remainingRoundMs(timeoutMs, h0), log })
    if (remainingRoundMs(timeoutMs, h0) === 0) throw new Error('orçamento da rodada esgotado no handoff')
    const prompts = await sendToImplementation(page)
    run.handoff.secs = Math.round((Date.now() - h0) / 1000)
    writeFileSync(path.join(out, 'handoff.md'), prompts.map((p, i) => `<!-- prompt ${i + 1} -->\n${p}`).join('\n\n'))
    log(`[${t} ${side} r${n}] handoff com ${prompts.length} prompt(s) em ${run.handoff.secs}s; implementação começa`)
    const implPick = (s) => s.conversations.find((c) => c.mode !== 'planning' && samePath(c.cwd, wt) && /^Implementação/.test(c.title ?? ''))
    run.implementationStarted = true
    let lowTicks = 0
    let lastMemCheck = 0
    const onTick = async () => {
      await releaseHeldHandoff(page)
      if (Date.now() - lastMemCheck < 60_000) return
      lastMemCheck = Date.now()
      // Memória do PC no fim: aborta a rodada antes de derrubar processos do usuário.
      lowTicks = freeCommitGb() < ABORT_BELOW_GB ? lowTicks + 1 : 0
      if (lowTicks >= 2) throw new Error('memória esgotada no PC durante a rodada')
    }
    const remainingMs = remainingRoundMs(timeoutMs, h0)
    const res = remainingMs === 0
      ? { status: 'timeout', stage: 'handoff', ms: 0, nudges: 0 }
      : await driveUntilDone(bridge, ctx, { pick: implPick, timeoutMs: remainingMs, idleMs: 60_000, prompts, quietMs: () => quietSince(transcriptsDir(wt)), pendingBackground: () => pendingBackground(transcriptsDir(wt)), onTick, log })
    const impl = implPick(await bridge.state())
    run.implementation = { ...res, model: impl?.model, effort: impl?.effort, fastMode: impl?.fastMode, finalText: res.finalText?.slice(-3000) }
    log(`[${t} ${side} r${n}] implementação: ${res.status} em ${Math.round(res.ms / 60000)} min, ${res.nudges} insistências (${impl?.model}@${impl?.effort})`)
  } catch (err) {
    run.error = String(err?.stack ?? err)
    // Erro do arnês antes de a implementação começar, ou memória do PC esgotada, não é da
    // qualidade: a rodada é repetida. Handoff que estourou o teto é da qualidade (não terminou).
    const handoffLate = /não gravou o handoff a tempo|orçamento da rodada esgotado/.test(String(err?.message))
    run.infraError = (!run.implementationStarted && !handoffLate) || /memória esgotada/.test(String(err?.message))
    if (handoffLate) run.implementation = { status: 'timeout', stage: 'handoff' }
    log(`[${t} ${side} r${n}] ERRO${run.infraError ? ' (infraestrutura, antes da implementação)' : ''}: ${err?.message ?? err}`)
  } finally {
    await shutdown(app, runData, { log })
  }
  run.endedAt = new Date().toISOString()
  try {
    run.diff = collectDiff(wt, parent, path.join(out, 'diff.patch'))
    writeJson(path.join(out, 'events.json'), ctx.events)
    log(`[${t} ${side} r${n}] diff: ${run.diff.files} arquivos, +${run.diff.add} -${run.diff.del}, ${run.diff.tests.length} de teste${run.diff.outside.stash || run.diff.outside.worktrees ? ` (ATENÇÃO fora do diff: ${JSON.stringify(run.diff.outside)})` : ''}; avaliando`)
    if (!run.infraError) {
      run.memoryBeforeEval = await waitForMemory(MIN_FREE_EVAL_GB, { log })
      const evaluation = evaluateRound(wt, { repo: REPO, reference: referenceSpecOf(t), refTests: baseline.refTests, baselineFailed: baseline.suite.stable, baselinePassed: baseline.suite.passedIds })
      writeJson(path.join(out, 'eval.json'), evaluation)
      log(`[${t} ${side} r${n}] fim: typecheck ${evaluation.typecheck.ok ? 'ok' : 'FALHOU'}, falhas novas na suíte ${evaluation.suite.newFailures.length}, testes sumidos ${evaluation.suite.missingFromParent.length}, referência ${evaluation.reference.passed}/${evaluation.reference.total}`)
    }
    const tr = collectTranscripts(wt, runData)
    if (tr.files) {
      const medir = runMedirExploracao(tr.dir)
      writeFileSync(path.join(out, 'medir-exploracao.txt'), medir)
      run.time = { firstEdit: parseFirstEdit(medir), totals: implementationTotals(tr.dir) }
      // Os contadores da sessão base (baseline-sessao.mjs) sobre a conversa de implementação da rodada.
      run.autonomy = roundAutonomy(tr.dir, run.time.totals?.file ?? null)
    }
  } catch (err) {
    run.evalError = String(err?.stack ?? err)
    log(`[${t} ${side} r${n}] ERRO na avaliação: ${err?.message ?? err}`)
  } finally {
    writeJson(path.join(out, 'run.json'), run)
    resetWorktree(wt, parent)
  }
  return run
}

/**
 * As 6 rodadas de uma tarefa, em série e intercaladas (hoje r1, novo r1, hoje r2…),
 * para que horário/estado da conta não favoreçam um lado. Pula as que já têm avaliação.
 * Rodada com erro de infraestrutura (antes da implementação) é repetida uma vez.
 */
async function cmdBatch(t) {
  for (let n = 1; n <= ROUNDS; n++) {
    for (const side of Object.keys(sidesOf(t))) {
      for (let attempt = 1; attempt <= 5; attempt++) {
        if (existsSync(path.join(paths.out(t, side, n), 'eval.json'))) break
        try {
          const run = await cmdRound(t, side, n)
          if (!run?.infraError) break
        } catch (err) {
          console.error(`[${t} ${side} r${n}] rodada abortada: ${err?.stack ?? err}`)
        }
      }
    }
  }
}

/** Recalcula o tempo de todas as rodadas da tarefa a partir dos transcripts guardados (antes do retire). */
function cmdMeasure(t) {
  for (const side of Object.keys(sidesOf(t))) {
    for (let n = 1; n <= ROUNDS; n++) {
      const runFile = path.join(paths.out(t, side, n), 'run.json')
      const projects = path.join(paths.runData(t, side, n), 'projects')
      if (!existsSync(runFile) || !existsSync(projects)) continue
      const run = JSON.parse(readFileSync(runFile, 'utf8'))
      const medir = runMedirExploracao(projects)
      writeFileSync(path.join(paths.out(t, side, n), 'medir-exploracao.txt'), medir)
      run.time = { firstEdit: parseFirstEdit(medir), totals: implementationTotals(projects) }
      run.autonomy = roundAutonomy(projects, run.time.totals?.file ?? null)
      writeJson(runFile, run)
      console.log(`[${t} ${side} r${n}] ${JSON.stringify({ ...run.time.totals, tools: undefined })}`)
    }
  }
}

/** Tarefa terminada (6 rodadas e revisões): apaga a cópia e os dados das execuções dela. */
function cmdRetire(t) {
  const wt = paths.worktree(t)
  rmSync(path.dirname(wt), { recursive: true, force: true })
  for (const side of Object.keys(sidesOf(t))) for (let n = 1; n <= ROUNDS; n++) rmSync(paths.runData(t, side, n), { recursive: true, force: true })
  rmSync(path.join(ROOT, 'runs', `${t}-plan`), { recursive: true, force: true })
  console.log(`[${t}] cópia e dados das execuções apagados`)
}

/** Depois das revisões às cegas: copia as saídas privadas para docs/validation (repositório). */
function cmdPublish(t) {
  for (const side of Object.keys(sidesOf(t))) {
    for (let n = 1; n <= ROUNDS; n++) if (existsSync(paths.out(t, side, n))) cpSync(paths.out(t, side, n), paths.published(t, side, n), { recursive: true })
  }
  const reviews = path.join(PRIVATE, t, 'revisao')
  if (existsSync(reviews)) cpSync(reviews, path.join(outOf(t), t, 'revisao'), { recursive: true })
  for (let n = 1; n <= ROUNDS; n++) if (existsSync(paths.map(t, n))) cpSync(paths.map(t, n), path.join(outOf(t), t, 'revisao', `mapa-par-${n}.json`))
  console.log(`[${t}] saídas publicadas em ${path.join(outOf(t), t)}`)
}

function cmdStatus() {
  for (const t of Object.keys(TASKS)) {
    const row = [t, existsSync(paths.baseline(t)) ? 'base✓' : 'base·', existsSync(path.join(paths.frozenPlan(t), '..', `${t}.json`)) ? 'plano✓' : 'plano·']
    for (const side of Object.keys(sidesOf(t))) for (let n = 1; n <= ROUNDS; n++) row.push(`${side[0]}${n}${existsSync(path.join(paths.out(t, side, n), 'eval.json')) ? '✓' : '·'}`)
    console.log(row.join(' '))
  }
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  const [cmd, ...args] = process.argv.slice(2)
  const commands = {
    prepare: () => cmdPrepare(args[0]),
    baseline: () => cmdBaseline(args[0]),
    plan: () => cmdPlan(args[0]),
    round: () => cmdRound(args[0], args[1], Number(args[2]), args.includes('--smoke')),
    batch: () => cmdBatch(args[0]),
    retire: () => cmdRetire(args[0]),
    measure: () => cmdMeasure(args[0]),
    publish: () => cmdPublish(args[0]),
    status: cmdStatus
  }
  if (!commands[cmd] || (cmd !== 'status' && !TASKS[args[0]])) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 10).join('\n'))
    process.exit(cmd ? 1 : 0)
  }
  await commands[cmd]()
}
