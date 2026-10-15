/**
 * Bench do índice de memórias (src/main/memory/memoryFileCache.ts).
 *
 *   npx tsx scripts/bench/memory-cache-bench.mts <pasta-de-memórias> [consulta]
 *
 * SÓ LEITURA: nada é gravado na pasta. Mede:
 * 1. o aquecimento assíncrono (`warmMemoryFileCache`), com `monitorEventLoopDelay`
 *    para provar que ele não trava o loop (max < 50 ms);
 * 2. o índice quente: `listMemoryFiles` + `memoryCatalogFilesystemVersion` +
 *    `rankMemoriesByQuery` somados (< 30 ms);
 * 3. para referência, a leitura síncrona fria (primeira consulta sem índice).
 * Sai com código 1 se um dos limites estourar.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { disposeMemoryFileCache, memoryFileIndex, warmMemoryFileCache } from '../../src/main/memory/memoryFileCache'
import { listMemoryFiles, memoryCatalogFilesystemVersion, rankMemoriesByQuery } from '../../src/main/memoryIndex'

const dir = process.argv[2]
const query = process.argv[3] ?? 'como configurar o servidor do erp da 2d e o deploy do app'
if (!dir) {
  console.error('uso: npx tsx scripts/bench/memory-cache-bench.mts <pasta-de-memórias> [consulta]')
  process.exit(2)
}

const HOT_LIMIT_MS = 30
const LOOP_LIMIT_MS = 50
const ROUNDS = 20

const ms = (ns: number): string => (ns / 1e6).toFixed(1)

function time<T>(fn: () => T): [T, number] {
  const start = performance.now()
  const value = fn()
  return [value, performance.now() - start]
}

// 1. Aquecimento assíncrono sob o monitor do loop.
const histogram = monitorEventLoopDelay({ resolution: 1 })
histogram.enable()
const warmStart = performance.now()
const warmed = await warmMemoryFileCache(dir)
const warmMs = performance.now() - warmStart
histogram.disable()
const loopMaxMs = histogram.max / 1e6
console.log(`aquecimento assíncrono: ${warmed.files.length} arquivos em ${warmMs.toFixed(1)} ms; atraso do loop max ${ms(histogram.max)} ms, p99 ${ms(histogram.percentile(99))} ms, média ${ms(histogram.mean)} ms`)
if (!warmed.watched) console.log(`(árvore com até ${warmed.files.length} arquivos: modo pequeno, cada consulta revarre)`)

// 2. Índice quente: as três funções do envio, somadas.
const totals: number[] = []
let listed = 0
let ranked = 0
for (let round = 0; round < ROUNDS; round++) {
  const [files, listMs] = time(() => listMemoryFiles(dir))
  const [, versionMs] = time(() => memoryCatalogFilesystemVersion(dir))
  const [rank, rankMs] = time(() => rankMemoriesByQuery(dir, query, files))
  listed = files.length
  ranked = rank.length
  totals.push(listMs + versionMs + rankMs)
  if (round === 0 || round === ROUNDS - 1) {
    console.log(`quente #${round + 1}: list ${listMs.toFixed(2)} + version ${versionMs.toFixed(2)} + rank ${rankMs.toFixed(2)} = ${(listMs + versionMs + rankMs).toFixed(2)} ms`)
  }
}
const sorted = [...totals].sort((a, b) => a - b)
const hotMax = sorted[sorted.length - 1]!
const hotMedian = sorted[Math.floor(sorted.length / 2)]!
console.log(`quente (${ROUNDS} rodadas): mediana ${hotMedian.toFixed(2)} ms, max ${hotMax.toFixed(2)} ms; ${listed} memórias listadas, ${ranked} pontuadas para "${query}"`)

// 3. Referência: a primeira consulta síncrona sem índice (o que o aquecimento evita).
disposeMemoryFileCache(dir)
const [, coldMs] = time(() => memoryFileIndex(dir))
console.log(`frio (leitura síncrona única, sem aquecer): ${coldMs.toFixed(1)} ms`)
disposeMemoryFileCache()

const failures: string[] = []
if (hotMax >= HOT_LIMIT_MS) failures.push(`índice quente ${hotMax.toFixed(2)} ms >= ${HOT_LIMIT_MS} ms`)
if (loopMaxMs >= LOOP_LIMIT_MS) failures.push(`atraso do loop ${loopMaxMs.toFixed(1)} ms >= ${LOOP_LIMIT_MS} ms`)
if (failures.length) {
  console.error(`FALHOU: ${failures.join('; ')}`)
  process.exit(1)
}
console.log(`OK: quente max ${hotMax.toFixed(2)} ms < ${HOT_LIMIT_MS} ms; loop max ${loopMaxMs.toFixed(1)} ms < ${LOOP_LIMIT_MS} ms`)
