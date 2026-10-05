/**
 * Perfil rolante do JS Self-Profiling, para dizer QUAL função travou a tela.
 *
 * O long-animation-frame só atribui scripts da mesma origem; o renderer
 * instalado é file:// (origem opaca) e os quadros chegam com `scripts: []`. O
 * main acrescenta `Document-Policy: js-profiling` no index.html
 * (main/jsProfilingPolicy.ts) e aqui um `Profiler` amostra a pilha a cada
 * SAMPLE_MS. O detector (freezeWatch.ts) gira o profiler quando tem quadro
 * esperando atribuição e cruza as amostras do intervalo do quadro.
 *
 * Sem `Profiler` (jsdom, dev por http, sem o cabeçalho) nada disto liga. Custo:
 * nada roda por evento; a atribuição só roda com quadro longo e é O(amostras).
 */
import type { FreezeScript } from '@shared/ipc'

export const SAMPLE_MS = 10
/** Amostras no buffer: ~100 s a 10 ms, folga sobre o giro de IDLE_ROTATE_MS. */
export const PROFILER_BUFFER = 10_000
/** Sem quadro esperando, gira no máximo a cada tanto (o trace é descartado). */
export const IDLE_ROTATE_MS = 30_000
const TOP_SCRIPTS = 3
/** Teto do peso de uma amostra (um buraco longo no trace não vira travada inventada). */
const MAX_SAMPLE_WEIGHT_MS = 100
const STACK_DEPTH = 6
const MAX_STACK = 120
const MAX_FUNCTION = 80
const ANONYMOUS = '(anônima)'

/** O formato do trace do JS Self-Profiling (timestamps na base de performance.now()). */
export interface ProfilerFrame {
  name: string
  resourceId?: number
  line?: number
  column?: number
}
export interface ProfilerTrace {
  resources: string[]
  frames: ProfilerFrame[]
  stacks: Array<{ frameId: number; parentId?: number }>
  samples: Array<{ timestamp: number; stackId?: number }>
}
interface ProfilerLike {
  readonly sampleInterval?: number
  stop(): Promise<ProfilerTrace>
}
type ProfilerCtor = new (options: { sampleInterval: number; maxBufferSize: number }) => ProfilerLike

/** Um trace parado e o intervalo real de amostragem dele. */
export interface SampledTrace {
  trace: ProfilerTrace
  interval: number
}

let current: ProfilerLike | null = null
let currentInterval = SAMPLE_MS
/** O trace do giro anterior: cobre o quadro que chegou logo depois de um giro. */
let previous: SampledTrace | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

/** Só o nome do arquivo de uma URL de script: sem pasta, query nem hash. */
export function scriptFileName(url: string | undefined): string | undefined {
  if (!url) return undefined
  return url.split(/[?#]/)[0].split(/[\\/]/).pop() || undefined
}

function create(): ProfilerLike | null {
  const ctor = (globalThis as { Profiler?: unknown }).Profiler
  if (typeof ctor !== 'function') return null
  try {
    const profiler = new (ctor as ProfilerCtor)({ sampleInterval: SAMPLE_MS, maxBufferSize: PROFILER_BUFFER })
    const real = profiler.sampleInterval
    currentInterval = typeof real === 'number' && real > 0 ? real : SAMPLE_MS
    return profiler
  } catch {
    // Sem o Document-Policy: "JS profiling is disabled by Document Policy".
    return null
  }
}

function clearIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

function armIdle(): void {
  clearIdle()
  idleTimer = setTimeout(() => void rotateJsProfiler(), IDLE_ROTATE_MS)
}

function stopQuietly(profiler: ProfilerLike): void {
  try {
    profiler.stop().catch(() => undefined)
  } catch {
    /* nunca lança */
  }
}

/** Liga o profiler rolante se o ambiente deixar. Devolve se está ligado. */
export function startJsProfiler(): boolean {
  if (current) return true
  current = create()
  if (current) armIdle()
  return current !== null
}

export function jsProfilerActive(): boolean {
  return current !== null
}

/** Desliga e esquece os traces. Nunca lança. */
export function stopJsProfiler(): void {
  clearIdle()
  const old = current
  current = null
  previous = null
  if (old) stopQuietly(old)
}

/**
 * Gira: inicia o novo ANTES de parar o antigo (sem buraco na amostragem) e
 * devolve os traces que cobrem o passado recente — o do giro anterior e o
 * recém-parado. Sem profiler ou com erro, devolve o que tiver (talvez []).
 */
export async function rotateJsProfiler(): Promise<SampledTrace[]> {
  const old = current
  if (!old) return []
  const oldInterval = currentInterval
  const next = create()
  current = next
  if (next) armIdle()
  else clearIdle()
  const before = previous
  try {
    const stopped: SampledTrace = { trace: await old.stop(), interval: oldInterval }
    // Desligado no meio do caminho: não guarda nada.
    if (current === next && next) previous = stopped
    return before ? [before, stopped] : [stopped]
  } catch {
    return before ? [before] : []
  }
}

interface Leaf {
  frame: ProfilerFrame
  resource?: string
  ms: number
  stacks: Map<string, { trace: ProfilerTrace; stackId: number; n: number }>
}

const frameName = (frame: ProfilerFrame | undefined): string => frame?.name || ANONYMOUS
const position = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0

/** Nomes da pilha mais comum dessa folha, da folha para cima. */
function commonStack(leaf: Leaf): string {
  let best: { trace: ProfilerTrace; stackId: number; n: number } | null = null
  for (const stack of leaf.stacks.values()) if (!best || stack.n > best.n) best = stack
  if (!best) return ''
  const names: string[] = []
  let id: number | undefined = best.stackId
  while (id !== undefined && names.length < STACK_DEPTH) {
    const stack: { frameId: number; parentId?: number } | undefined = best.trace.stacks[id]
    if (!stack) break
    names.push(frameName(best.trace.frames[stack.frameId]))
    id = stack.parentId
  }
  return names.join(' < ').slice(0, MAX_STACK)
}

function toScript(leaf: Leaf): FreezeScript {
  const out: FreezeScript = {
    ms: Math.round(leaf.ms),
    invoker: 'perfil',
    invokerType: 'amostragem',
    sourceFunctionName: frameName(leaf.frame).slice(0, MAX_FUNCTION)
  }
  const file = scriptFileName(leaf.resource)
  if (file) out.sourceFile = file.slice(0, 120)
  if (position(leaf.frame.line)) out.sourceLine = leaf.frame.line
  if (position(leaf.frame.column)) out.sourceColumn = leaf.frame.column
  const stack = commonStack(leaf)
  if (stack) out.stack = stack
  return out
}

/**
 * Atribui um quadro [start, end] (base performance.now()): até 3 funções por
 * tempo próprio (folha da pilha) e o JS total amostrado. null quando nenhum
 * trace tem amostra no intervalo (não dá para dizer nada).
 */
export function attributeFrame(
  traces: readonly SampledTrace[],
  start: number,
  end: number
): { scripts: FreezeScript[]; jsMs: number } | null {
  const leaves = new Map<string, Leaf>()
  let seen = 0
  let jsMs = 0
  traces.forEach(({ trace, interval }, t) => {
    trace.samples.forEach((sample, i) => {
      // Cada amostra vale o trecho até a próxima, recortado ao quadro: no Windows
      // o espaçamento real (~28 ms) passa do intervalo informado (16 ms), e
      // "amostras × intervalo" subestimaria a travada pela metade.
      const next = trace.samples[i + 1]?.timestamp ?? sample.timestamp + interval
      const weight = Math.min(next, sample.timestamp + MAX_SAMPLE_WEIGHT_MS, end) - Math.max(sample.timestamp, start)
      if (!(weight > 0)) return
      seen++
      if (sample.stackId === undefined) return
      jsMs += weight
      const stack = trace.stacks[sample.stackId]
      const frame = stack ? trace.frames[stack.frameId] : undefined
      if (!frame) return
      const resource = frame.resourceId === undefined ? undefined : trace.resources[frame.resourceId]
      const key = `${frame.name}|${resource ?? ''}|${frame.line ?? ''}|${frame.column ?? ''}`
      let leaf = leaves.get(key)
      if (!leaf) {
        leaf = { frame, resource, ms: 0, stacks: new Map() }
        leaves.set(key, leaf)
      }
      leaf.ms += weight
      const stackKey = `${t}:${sample.stackId}`
      const counted = leaf.stacks.get(stackKey)
      if (counted) counted.n++
      else leaf.stacks.set(stackKey, { trace, stackId: sample.stackId, n: 1 })
    })
  })
  if (!seen) return null
  const scripts = [...leaves.values()]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, TOP_SCRIPTS)
    .map(toScript)
  return { scripts, jsMs: Math.round(jsMs) }
}
