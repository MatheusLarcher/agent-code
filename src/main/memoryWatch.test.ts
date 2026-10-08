// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type InspectorSession,
  type MemoryStats,
  PROFILE_TOP,
  SAMPLING_START_BYTES,
  startMemoryWatch,
  topRetainedPoints
} from './memoryWatch'

const GB = 1024 * 1024 * 1024
const LIMIT = 4 * GB

const dirs: string[] = []
const stops: Array<() => void> = []

async function userData(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'memory-watch-'))
  dirs.push(dir)
  return dir
}

let stats: MemoryStats
const setHeap = (heapUsed: number): void => {
  stats = { heapUsed, heapLimit: LIMIT, rss: heapUsed + 1000, external: 7, arrayBuffers: 3 }
}

interface FakeSession extends InspectorSession {
  calls: string[]
  connected: boolean
}

function fakeSession(opts: { failOn?: string; profile?: unknown } = {}): FakeSession {
  const session: FakeSession = {
    calls: [],
    connected: false,
    connect() {
      session.connected = true
    },
    disconnect() {
      session.connected = false
    },
    post(method, _params, callback) {
      session.calls.push(method)
      if (method === opts.failOn) callback(new Error(`falha em ${method}`))
      else callback(null, method === 'HeapProfiler.stopSampling' ? { profile: opts.profile ?? { head: { selfSize: 0, children: [] } } } : {})
    }
  }
  return session
}

function start(dir: string, session: FakeSession, extra: { maxBytes?: number } = {}): () => void {
  const stop = startMemoryWatch({
    userDataDir: dir,
    ...extra,
    readStats: () => stats,
    createSession: () => session,
    readHeapSpaces: () => [{ space_name: 'old_space', space_used_size: 1 }]
  })
  stops.push(stop)
  return stop
}

const logLines = async (file: string): Promise<Array<Record<string, unknown>>> =>
  (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)

const profiles = async (dir: string): Promise<string[]> =>
  (await readdir(join(dir, 'logs'))).filter((name) => name.startsWith('memoria-perfil-'))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 7, 12, 0, 0)))
  setHeap(700 * 1024 * 1024)
})

afterEach(async () => {
  for (const stop of stops.splice(0)) stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('memoryWatch', () => {
  it('grava a cada 5 s uma linha JSON com at, heapUsed, heapLimit, rss, external e arrayBuffers', async () => {
    const dir = await userData()
    start(dir, fakeSession())
    await vi.advanceTimersByTimeAsync(10_000) // checagens em 1..10 s: grava no 1º e no 6º
    const lines = await logLines(join(dir, 'logs', 'memoria.log'))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toEqual({
      at: '2026-10-07T12:00:01.000Z',
      heapUsed: 700 * 1024 * 1024,
      heapLimit: LIMIT,
      rss: 700 * 1024 * 1024 + 1000,
      external: 7,
      arrayBuffers: 3
    })
    expect(lines[1].at).toBe('2026-10-07T12:00:06.000Z')
  })

  it('gira para memoria.1.log ao passar do limite de tamanho', async () => {
    const dir = await userData()
    start(dir, fakeSession(), { maxBytes: 300 }) // cada linha tem ~110 bytes
    await vi.advanceTimersByTimeAsync(40_000) // 8 linhas
    const current = join(dir, 'logs', 'memoria.log')
    const rotated = join(dir, 'logs', 'memoria.1.log')
    expect((await stat(rotated)).size).toBeGreaterThan(0)
    expect((await stat(current)).size).toBeLessThanOrEqual(300)
    expect((await stat(rotated)).size).toBeLessThanOrEqual(300)
    expect((await logLines(current)).length).toBeGreaterThan(0)
  })

  it('só amostra o heap a partir de 1,5 GB', async () => {
    const dir = await userData()
    const session = fakeSession()
    start(dir, session)
    setHeap(SAMPLING_START_BYTES - 1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(session.calls).toEqual([])
    expect(session.connected).toBe(false)

    setHeap(SAMPLING_START_BYTES)
    await vi.advanceTimersByTimeAsync(3000)
    expect(session.connected).toBe(true)
    expect(session.calls).toEqual(['HeapProfiler.startSampling']) // inicia uma vez só
    expect(await profiles(dir)).toEqual([]) // 1,5 GB ainda está longe de 80% de 4 GB
  })

  it('grava o perfil UMA vez ao cruzar 80% do teto, com os 30 maiores pontos e os espaços do heap', async () => {
    const dir = await userData()
    const children = Array.from({ length: 40 }, (_, i) => ({
      callFrame: { functionName: `fn${i}`, url: `file:///app/mod${i}.js`, lineNumber: i },
      selfSize: 1000 + i,
      children: []
    }))
    // fn5 aparece de novo em outro ramo: os bytes são somados.
    const nested = { callFrame: { functionName: 'pai', url: '', lineNumber: 0 }, selfSize: 0, children: [{ ...children[5] }] }
    const session = fakeSession({
      profile: { head: { callFrame: { functionName: '(root)' }, selfSize: 0, children: [...children, nested] } }
    })
    start(dir, session)

    setHeap(2 * GB)
    await vi.advanceTimersByTimeAsync(2000)
    setHeap(LIMIT * 0.8)
    await vi.advanceTimersByTimeAsync(2000)
    setHeap(LIMIT * 0.95) // continua alto: não grava de novo
    await vi.advanceTimersByTimeAsync(5000)

    const files = await profiles(dir)
    expect(files).toHaveLength(1)
    expect(session.calls).toEqual(['HeapProfiler.startSampling', 'HeapProfiler.stopSampling'])
    expect(session.connected).toBe(false)

    const profile = JSON.parse(await readFile(join(dir, 'logs', files[0]), 'utf8')) as Record<string, any>
    expect(profile.heap_size_limit).toBe(LIMIT)
    expect(profile.amostragem).toBe(true)
    expect(profile.heap_space_statistics).toEqual([{ space_name: 'old_space', space_used_size: 1 }])
    expect(profile.pontos).toHaveLength(PROFILE_TOP)
    expect(profile.pontos[0]).toEqual({ functionName: 'fn5', url: 'file:///app/mod5.js', lineNumber: 5, bytes: 1005 * 2 })
    expect(profile.pontos[1]).toEqual({ functionName: 'fn39', url: 'file:///app/mod39.js', lineNumber: 39, bytes: 1039 })
    const bytes = profile.pontos.map((p: { bytes: number }) => p.bytes)
    expect(bytes).toEqual([...bytes].sort((a, b) => b - a))
  })

  it('erro do inspector não propaga: vira console.warn e o monitor segue gravando o log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = await userData()
    const throwing: InspectorSession = {
      connect() {
        throw new Error('inspector indisponível')
      },
      disconnect() {},
      post() {}
    }
    const stop = startMemoryWatch({ userDataDir: dir, readStats: () => stats, createSession: () => throwing })
    stops.push(stop)
    setHeap(2 * GB)
    await expect(vi.advanceTimersByTimeAsync(7000)).resolves.not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1) // calado depois da 1ª falha
    expect((await logLines(join(dir, 'logs', 'memoria.log'))).length).toBeGreaterThan(0)

    // stopSampling falhando: o perfil sai mesmo assim, sem pontos.
    const failing = fakeSession({ failOn: 'HeapProfiler.stopSampling' })
    const dir2 = await userData()
    start(dir2, failing)
    setHeap(LIMIT * 0.9)
    await vi.advanceTimersByTimeAsync(2000)
    const [file] = await profiles(dir2)
    const profile = JSON.parse(await readFile(join(dir2, 'logs', file), 'utf8')) as Record<string, unknown>
    expect(profile.pontos).toEqual([])
    expect(failing.connected).toBe(false)
  })

  it('parar limpa o timer e encerra a sessão do inspector', async () => {
    const dir = await userData()
    const session = fakeSession()
    const stop = start(dir, session)
    setHeap(2 * GB)
    await vi.advanceTimersByTimeAsync(2000)
    expect(session.connected).toBe(true)
    stop()
    expect(session.connected).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    stop() // idempotente
    const before = (await logLines(join(dir, 'logs', 'memoria.log'))).length
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await logLines(join(dir, 'logs', 'memoria.log'))).length).toBe(before)
  })

  it('nunca lança no boot, mesmo com a pasta de logs impossível', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = await userData()
    // `logs` é um arquivo: mkdir falha em toda gravação.
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'logs'), 'x')
    const stop = start(dir, fakeSession())
    await expect(vi.advanceTimersByTimeAsync(7000)).resolves.not.toThrow()
    expect(warn).toHaveBeenCalled()
    expect(() => stop()).not.toThrow()
  })
})

describe('topRetainedPoints', () => {
  it('árvore ausente ou sem bytes dá lista vazia', () => {
    expect(topRetainedPoints(undefined)).toEqual([])
    expect(topRetainedPoints({ selfSize: 0, children: [{ selfSize: 0 }] })).toEqual([])
  })
})
