/**
 * Bench da sincronização de skills (src/main/skills/skillSync.ts).
 *
 *   npm run build   # gera out/main/skillSyncWorker.js
 *   npx tsx scripts/bench/skill-sync-bench.mts [quantas-skills] [pasta-temporária]
 *
 * Monta ~250 skills sintéticas num app falso (`.agents/skills`) e roda a mesma
 * sequência duas vezes — pelo worker do build e no próprio thread (inline):
 * 1 completa fria (cache vazio), 3 completas quentes e 10 exposições (a
 * assinatura do chamador muda a cada uma, para furar o TTL). Durante cada uma,
 * `monitorEventLoopDelay` no thread que chama mede o maior bloqueio do loop.
 * Sai com código 1 se, pelo worker, o maior bloqueio passar de 50 ms.
 * A pasta temporária (padrão: os.tmpdir()) pode apontar para o OneDrive, onde o
 * custo real aparece. Tudo é apagado no fim.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import {
  inlineSkillSyncRunner,
  SkillSyncCoordinator,
  workerSkillSyncRunner,
  type SkillSyncRunner
} from '../../src/main/skills/skillSync'

const COUNT = Number(process.argv[2] ?? 250)
const BASE = process.argv[3] ?? tmpdir()
const LOOP_LIMIT_MS = 50
const WORKER = resolve('out/main/skillSyncWorker.js')

if (!existsSync(WORKER)) {
  console.error(`sem ${WORKER}: rode "npm run build" antes.`)
  process.exit(2)
}

const root = mkdtempSync(join(BASE, 'skill-sync-bench-'))
const appRoot = join(root, 'app')
for (let i = 0; i < COUNT; i++) {
  const name = `skill-${String(i).padStart(3, '0')}`
  const dir = join(appRoot, '.agents', 'skills', name)
  mkdirSync(join(dir, 'references'), { recursive: true })
  const body = `Instruções da ${name}.\n`.repeat(80)
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: skill sintética ${i}\n---\n${body}`)
  // Skills reais trazem referências e scripts ao lado do SKILL.md.
  for (let f = 0; f < 4; f++) writeFileSync(join(dir, 'references', `ref-${f}.md`), `# ${name} ${f}\n${body}`)
}

interface Measure {
  phase: string
  wallMs: number
  maxBlockMs: number
  errors: number
}

async function measure(phase: string, fn: () => Promise<{ errors: number }>): Promise<Measure> {
  const histogram = monitorEventLoopDelay({ resolution: 1 })
  histogram.enable()
  const start = performance.now()
  // Um tique do timer do monitor antes e depois: o atraso é medido nele.
  await new Promise((r) => setTimeout(r, 5))
  const { errors } = await fn()
  await new Promise((r) => setTimeout(r, 5))
  const wallMs = performance.now() - start
  histogram.disable()
  return { phase, wallMs, maxBlockMs: histogram.max / 1e6, errors }
}

async function run(label: string, runner: () => SkillSyncRunner): Promise<Measure[]> {
  const cacheDir = join(root, `cache-${label}`)
  const home = join(root, `home-${label}`)
  mkdirSync(cacheDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  const target = { appRoot, cacheDir, userHome: home, kits: [] }
  const sync = new SkillSyncCoordinator({ runner, machine: 'bench' })
  const results: Measure[] = []
  // Aquece o worker (subida do thread) fora da medida.
  if (label === 'worker') await sync.syncManaged({ ...target, cacheDir: join(root, 'warmup') }, { scope: 'w', fingerprint: () => 'w' })
  results.push(await measure('completa fria', async () => ({ errors: (await sync.syncAll(target)).errors.length })))
  for (let i = 1; i <= 3; i++) {
    results.push(await measure(`completa quente ${i}`, async () => ({ errors: (await sync.syncAll(target)).errors.length })))
  }
  for (let i = 1; i <= 10; i++) {
    results.push(
      await measure(`exposição ${i}`, async () => {
        const response = await sync.syncManaged(target, { scope: '/projeto', fingerprint: () => `fp-${i}` })
        return { errors: response.result.errors.length }
      })
    )
  }
  sync.dispose()
  return results
}

function report(label: string, results: Measure[]): number {
  console.log(`\n== ${label} (${COUNT} skills) ==`)
  for (const r of results) {
    console.log(
      `${r.phase.padEnd(18)} parede ${r.wallMs.toFixed(1).padStart(8)} ms   maior bloqueio ${r.maxBlockMs.toFixed(1).padStart(8)} ms` +
        (r.errors ? `   erros ${r.errors}` : '')
    )
  }
  const max = Math.max(...results.map((r) => r.maxBlockMs))
  console.log(`maior bloqueio do loop: ${max.toFixed(1)} ms`)
  return max
}

try {
  const worker = await run('worker', () => workerSkillSyncRunner(WORKER))
  const inline = await run('inline', () => inlineSkillSyncRunner)
  const workerMax = report('worker', worker)
  const inlineMax = report('inline (thread principal)', inline)
  const ok = workerMax < LOOP_LIMIT_MS
  console.log(
    `\nworker ${workerMax.toFixed(1)} ms vs inline ${inlineMax.toFixed(1)} ms — limite ${LOOP_LIMIT_MS} ms: ${ok ? 'OK' : 'ESTOUROU'}`
  )
  process.exitCode = ok ? 0 : 1
} finally {
  rmSync(root, { recursive: true, force: true })
}
