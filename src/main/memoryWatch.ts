// Monitor de memória do processo PRINCIPAL. O app morria sem aviso (o V8 estoura o
// teto de heap e derruba o main) e não havia como saber QUEM acumulava. Duas coisas:
//   1. <userData>/logs/memoria.log — uma linha JSON a cada 5 s com a memória do main;
//      é a curva que mostra quando e quão rápido a memória sobe.
//   2. Perfil de amostragem do heap (HeapProfiler via node:inspector): começa a
//      amostrar quando o heap passa de 1,5 GB e, ao chegar a 80% do teto, UMA vez por
//      processo, grava <userData>/logs/memoria-perfil-<data>.json com os pontos de
//      código que retêm mais memória naquele instante.
//
// Mesmas regras do freezeLog.ts: nunca lança nem trava o boot (erro vira console.warn),
// timer com unref. Diferença deliberada: a escrita é SÍNCRONA — o processo pode morrer a
// qualquer segundo, e uma escrita em fila ainda pendente morreria junto. São poucos
// bytes a cada 5 s, então o custo no main é desprezível.
import { appendFileSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getHeapSpaceStatistics, getHeapStatistics } from 'node:v8'
import { Session } from 'node:inspector'

/** Acima disto o arquivo vira `memoria.1.log` (o anterior é sobrescrito). */
export const MEMORY_LOG_MAX_BYTES = 5 * 1024 * 1024
/** Heap usado a partir do qual a amostragem do HeapProfiler é ligada. */
export const SAMPLING_START_BYTES = 1.5 * 1024 * 1024 * 1024
/** Fração do teto de heap em que o perfil é parado e gravado. */
export const PROFILE_AT_FRACTION = 0.8
/** Quantos pontos de código entram no perfil. */
export const PROFILE_TOP = 30

const CHECK_EVERY_MS = 1000
const LOG_EVERY_TICKS = 5

export interface MemoryStats {
  heapUsed: number
  heapLimit: number
  rss: number
  external: number
  arrayBuffers: number
}

/** O pedaço do `inspector.Session` que usamos (injetável nos testes). */
export interface InspectorSession {
  connect(): void
  disconnect(): void
  post(method: string, params: object | undefined, callback: (error: Error | null, result?: unknown) => void): void
}

export interface MemoryWatchOptions {
  /** `app.getPath('userData')`; os arquivos ficam em `<userData>/logs`. */
  userDataDir: string
  maxBytes?: number
  /** Só para teste. */
  readStats?: () => MemoryStats
  createSession?: () => InspectorSession
  readHeapSpaces?: () => unknown
}

interface ProfileNode {
  callFrame?: { functionName?: string; url?: string; lineNumber?: number }
  selfSize?: number
  children?: ProfileNode[]
}

export interface RetainedPoint {
  functionName: string
  url: string
  lineNumber: number
  bytes: number
}

function defaultStats(): MemoryStats {
  const heap = getHeapStatistics()
  const mem = process.memoryUsage()
  return {
    heapUsed: heap.used_heap_size,
    heapLimit: heap.heap_size_limit,
    rss: mem.rss,
    external: heap.external_memory,
    arrayBuffers: mem.arrayBuffers
  }
}

/** Soma `selfSize` por (função, arquivo, linha) e devolve os `top` maiores.
 *  Iterativo: a árvore de chamadas pode ser funda. `lineNumber` é o do V8 (base 0). */
export function topRetainedPoints(root: ProfileNode | undefined, top = PROFILE_TOP): RetainedPoint[] {
  const sums = new Map<string, RetainedPoint>()
  const pending: ProfileNode[] = root ? [root] : []
  while (pending.length) {
    const node = pending.pop() as ProfileNode
    const bytes = node.selfSize ?? 0
    if (bytes > 0) {
      const functionName = node.callFrame?.functionName ?? ''
      const url = node.callFrame?.url ?? ''
      const lineNumber = node.callFrame?.lineNumber ?? -1
      const key = `${functionName}\u0000${url}\u0000${lineNumber}`
      const point = sums.get(key)
      if (point) point.bytes += bytes
      else sums.set(key, { functionName, url, lineNumber, bytes })
    }
    if (node.children) pending.push(...node.children)
  }
  return [...sums.values()].sort((a, b) => b.bytes - a.bytes).slice(0, top)
}

function post(session: InspectorSession, method: string, params?: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    session.post(method, params, (error, result) => (error ? reject(error) : resolve(result)))
  })
}

/** Liga o monitor. Devolve a função que o desliga (idempotente, nunca lança). */
export function startMemoryWatch(opts: MemoryWatchOptions): () => void {
  const noop = (): void => {}
  try {
    const dir = join(opts.userDataDir, 'logs')
    const file = join(dir, 'memoria.log')
    const rotated = join(dir, 'memoria.1.log')
    const maxBytes = opts.maxBytes ?? MEMORY_LOG_MAX_BYTES
    const readStats = opts.readStats ?? defaultStats
    const createSession = opts.createSession ?? ((): InspectorSession => new Session() as unknown as InspectorSession)
    const readHeapSpaces = opts.readHeapSpaces ?? getHeapSpaceStatistics

    let session: InspectorSession | null = null
    let samplingTried = false // uma tentativa só: erro não vira nova tentativa a cada segundo
    let profiled = false // uma única vez por processo
    let stopped = false
    let tick = 0
    const warned = new Set<string>()
    const warn = (what: string, error: unknown): void => {
      if (warned.has(what)) return
      warned.add(what)
      console.warn(`[memoria] ${what} (as próximas falhas iguais ficam caladas):`, error)
    }

    const appendLog = (stats: MemoryStats): void => {
      const line = `${JSON.stringify({ at: new Date().toISOString(), ...stats })}\n`
      mkdirSync(dir, { recursive: true })
      let size = 0
      try {
        size = statSync(file).size
      } catch {
        /* arquivo ainda não existe */
      }
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) renameSync(file, rotated)
      appendFileSync(file, line, 'utf8')
    }

    const closeSession = (): void => {
      const current = session
      session = null
      try {
        current?.disconnect()
      } catch (error) {
        warn('falha ao encerrar a sessão do inspector', error)
      }
    }

    const startSampling = (): void => {
      samplingTried = true
      try {
        session = createSession()
        session.connect()
        session.post('HeapProfiler.startSampling', undefined, (error) => {
          if (error) warn('HeapProfiler.startSampling falhou', error)
        })
      } catch (error) {
        warn('não foi possível iniciar a amostragem do heap', error)
        closeSession()
      }
    }

    const writeProfile = async (stats: MemoryStats): Promise<void> => {
      let points: RetainedPoint[] = []
      const active = session
      try {
        if (active) {
          const result = (await post(active, 'HeapProfiler.stopSampling')) as { profile?: { head?: ProfileNode } } | undefined
          points = topRetainedPoints(result?.profile?.head)
        }
      } catch (error) {
        warn('HeapProfiler.stopSampling falhou', error)
      } finally {
        closeSession()
      }
      try {
        const at = new Date()
        mkdirSync(dir, { recursive: true })
        const target = join(dir, `memoria-perfil-${at.toISOString().replace(/[:.]/g, '-')}.json`)
        const profile = {
          at: at.toISOString(),
          heap_size_limit: stats.heapLimit,
          heapUsed: stats.heapUsed,
          amostragem: active !== null,
          heap_space_statistics: readHeapSpaces(),
          pontos: points
        }
        writeFileSync(target, JSON.stringify(profile, null, 2), 'utf8')
        console.warn(`[memoria] heap em ${Math.round(stats.heapUsed / 1048576)} MB (teto ${Math.round(stats.heapLimit / 1048576)} MB); perfil gravado em ${target}`)
      } catch (error) {
        warn('falha ao gravar o perfil de heap', error)
      }
    }

    const check = (): void => {
      if (stopped) return
      try {
        const stats = readStats()
        if (tick++ % LOG_EVERY_TICKS === 0) {
          try {
            appendLog(stats)
          } catch (error) {
            warn('falha ao gravar memoria.log', error)
          }
        }
        if (!samplingTried && stats.heapUsed >= SAMPLING_START_BYTES) startSampling()
        if (!profiled && stats.heapUsed >= stats.heapLimit * PROFILE_AT_FRACTION) {
          profiled = true
          void writeProfile(stats).catch((error: unknown) => warn('falha ao gerar o perfil de heap', error))
        }
      } catch (error) {
        warn('falha na checagem de memória', error)
      }
    }

    const timer = setInterval(check, CHECK_EVERY_MS)
    timer.unref()

    return () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      try {
        if (session) session.post('HeapProfiler.stopSampling', undefined, () => {})
      } catch {
        /* a sessão é fechada logo abaixo de qualquer jeito */
      }
      closeSession()
    }
  } catch (error) {
    console.warn('[memoria] monitor não iniciado:', error)
    return noop
  }
}
