// Avaliador de código do replay (modelo do eval-harness do ECC): typecheck, suíte
// do projeto (comparada com a linha de base do commit pai) e os testes do commit
// de referência trazidos para a worktree da rodada.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { VITEST_WORKERS } from './instance.mjs'
import { applyCommitFiles, assertReplayWorktree } from './worktree.mjs'

const tail = (s, n = 4000) => (s.length > n ? s.slice(-n) : s)

function run(cwd, args, timeoutMs) {
  const t0 = Date.now()
  // Mesmo limite de workers das rodadas (instance.mjs): o padrão (1 por núcleo) esgota a memória do PC.
  const env = { ...process.env, VITEST_MAX_WORKERS: VITEST_WORKERS }
  const r = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs })
  return { code: r.status ?? (r.signal ? 124 : 1), out: `${r.stdout ?? ''}${r.stderr ?? ''}`, ms: Date.now() - t0 }
}

/** `npm run typecheck` sem o npm (os tsconfig do script do commit, chamados direto). */
export function typecheck(dir) {
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const projects = [...String(pkg.scripts?.typecheck ?? '').matchAll(/-p\s+(\S+)/g)].map((m) => m[1])
  const tsc = path.join(dir, 'node_modules', 'typescript', 'bin', 'tsc')
  let errors = 0
  let out = ''
  let ms = 0
  for (const p of projects) {
    const r = run(dir, [tsc, '--noEmit', '-p', p], 15 * 60_000)
    errors += (r.out.match(/error TS\d+/g) ?? []).length + (r.code !== 0 && !/error TS/.test(r.out) ? 1 : 0)
    out += r.out
    ms += r.ms
  }
  return { ok: errors === 0, errors, ms, tail: tail(out) }
}

/** Roda o vitest (arquivos ou a suíte inteira) com saída JSON e devolve os testes que falharam. */
export function vitest(dir, files = [], timeoutMs = 45 * 60_000) {
  const report = path.join(dir, '.replay-vitest.json')
  rmSync(report, { force: true })
  const bin = path.join(dir, 'node_modules', 'vitest', 'vitest.mjs')
  const r = run(dir, [bin, 'run', '--reporter=json', `--outputFile=${report}`, ...files], timeoutMs)
  if (!existsSync(report)) return { ok: false, crashed: true, total: 0, failed: [], ms: r.ms, tail: tail(r.out) }
  const j = JSON.parse(readFileSync(report, 'utf8'))
  rmSync(report, { force: true })
  const failed = []
  const passedIds = []
  for (const file of j.testResults ?? []) {
    const rel = path.relative(dir, file.name).replace(/\\/g, '/')
    const asserts = file.assertionResults ?? []
    for (const a of asserts) {
      if (a.status === 'failed') failed.push({ id: `${rel} > ${a.fullName}`, message: tail(String(a.failureMessages?.[0] ?? ''), 600) })
      else if (a.status === 'passed') passedIds.push(`${rel} > ${a.fullName}`)
    }
    // Arquivo que nem carrega (erro de import/compilação) não tem asserts: conta como falha do arquivo.
    if (file.status === 'failed' && !asserts.some((a) => a.status === 'failed')) failed.push({ id: `${rel} > (arquivo não carregou)`, message: tail(String(file.message ?? ''), 600) })
  }
  return { ok: failed.length === 0, crashed: false, total: j.numTotalTests ?? 0, passed: j.numPassedTests ?? 0, failed, passedIds, ms: r.ms }
}

/**
 * Arquivos pesados caem por carga na suíte inteira (visto na linha de base: passam
 * sozinhos). Roda de novo, sozinhos, os arquivos que falharam; só o que persiste conta.
 */
export function stableFailures(dir, suite) {
  if (suite.crashed || !suite.failed.length) return suite.failed
  // Duas re-execuções isoladas: só conta o que falha nas duas (instável sob carga sai).
  let failing = suite.failed
  for (let i = 0; i < 2 && failing.length; i++) {
    const files = [...new Set(failing.map((f) => f.id.split(' > ')[0]).filter((f) => /\.test\./.test(f)))]
    const rerun = vitest(dir, files, 20 * 60_000)
    if (rerun.crashed) return failing
    // Mesmo teste — ou qualquer teste de um arquivo que nem tinha carregado na suíte inteira.
    const fileOf = (id) => id.split(' > ')[0]
    failing = rerun.failed.filter((f) => failing.some((x) => x.id === f.id || (x.id.endsWith('(arquivo não carregou)') && fileOf(x.id) === fileOf(f.id))))
  }
  return failing
}

/** Falhas novas: as que não estavam na linha de base do commit pai (falhas de ambiente). */
export function newFailures(result, baselineIds) {
  const base = new Set(baselineIds)
  return result.failed.filter((f) => !base.has(f.id))
}

/**
 * Avaliação completa de uma rodada (a worktree já com o diff salvo):
 * 1. typecheck; 2. suíte inteira × linha de base; 3. testes do commit de referência.
 * O passo 3 sobrescreve os testes da rodada com os da referência — por isso vem por último.
 */
export function evaluateRound(dir, { repo, reference, refTests, baselineFailed, baselinePassed = [] }) {
  assertReplayWorktree(dir)
  const tc = typecheck(dir)
  const suite = vitest(dir)
  const stable = stableFailures(dir, suite)
  const fresh = suite.crashed ? [{ id: '(suíte não rodou)', message: suite.tail }] : newFailures({ failed: stable }, baselineFailed)
  const flaky = suite.failed.filter((f) => !stable.some((x) => x.id === f.id)).map((f) => f.id)
  // Testes que passavam no pai e sumiram (apagados, pulados, renomeados): vão para a revisão.
  const seen = new Set([...(suite.passedIds ?? []), ...suite.failed.map((f) => f.id)])
  const missing = suite.crashed ? [] : baselinePassed.filter((id) => !seen.has(id))
  applyCommitFiles(repo, dir, reference, refTests)
  const ref = vitest(dir, refTests.filter((f) => /\.test\./.test(f)), 20 * 60_000)
  return {
    typecheck: { ok: tc.ok, errors: tc.errors, ms: tc.ms, tail: tc.ok ? '' : tc.tail },
    suite: { total: suite.total, failedTotal: suite.failed.length, newFailures: fresh, flakyOnlyUnderLoad: flaky, missingFromParent: missing, ms: suite.ms },
    reference: { total: ref.total, passed: ref.passed ?? 0, failed: ref.failed, crashed: ref.crashed, ms: ref.ms },
    // Parte automática do avaliador de código: compila e não quebra nada que já passava.
    // O "passou" final (codePass) também exige que nenhuma falha dos testes de
    // referência seja de comportamento — essa classificação sai da revisão às cegas.
    corePass: tc.ok && !suite.crashed && fresh.length === 0
  }
}

/**
 * "Passou" final do avaliador de código: parte automática verde e nenhuma falha
 * de referência classificada como comportamento (falha por nome/forma não conta).
 * `classes` = { [idDoTeste]: 'nome' | 'comportamento' } vindo da revisão.
 */
export function codePass(evaluation, classes = {}) {
  if (!evaluation?.corePass) return false
  if (evaluation.reference.crashed) return false
  return evaluation.reference.failed.every((f) => classes[f.id] === 'nome')
}
