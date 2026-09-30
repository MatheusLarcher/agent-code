/**
 * Main-process side of the voice worker: spawns it lazily, routes requests by
 * id, forwards progress, and rejects everything in flight if it dies (the
 * next request respawns it).
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { VoiceProgress, WorkerRequest, WorkerResponse } from './protocol'

export const WORKER_FILE = 'voiceWorker.js'

export class VoiceWorkerError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
  }
}

interface Pending {
  resolve(v: unknown): void
  reject(e: Error): void
  onProgress?: (p: VoiceProgress) => void
}

/** One spawned worker. Its pending map dies with it, so a late `exit` from an
 *  old worker can never reject requests sent to its replacement. */
interface Channel {
  pending: Map<number, Pending>
  post(msg: WorkerRequest): void
  kill(): void
  /** Keep a plain-Node process alive only while requests are in flight. */
  hold(active: boolean): void
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never
export type Request = DistributiveOmit<WorkerRequest, 'id'>

let channel: Promise<Channel> | null = null
let cacheDir: string | null = null
let nextId = 1

/** Where the built worker lives: next to this bundle, or one level up from a shared chunk. */
export function resolveWorkerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const p of [join(here, WORKER_FILE), join(here, '..', WORKER_FILE)]) if (existsSync(p)) return p
  throw new VoiceWorkerError(`${WORKER_FILE} não encontrado junto do bundle do main (${here})`)
}

function onMessage(pending: Map<number, Pending>, msg: WorkerResponse): void {
  const p = pending.get(msg.id)
  if (!p) return
  if (msg.type === 'progress') {
    try {
      p.onProgress?.(msg.progress)
    } catch {
      /* a broken progress listener must not kill the request */
    }
    return
  }
  pending.delete(msg.id)
  if (msg.type === 'result') p.resolve(msg.result)
  else p.reject(new VoiceWorkerError(msg.message, msg.code))
}

function failAll(pending: Map<number, Pending>, reason: string): void {
  const err = new VoiceWorkerError(`motor de voz encerrou: ${reason}`)
  for (const p of pending.values()) p.reject(err)
  pending.clear()
}

async function spawn(): Promise<Channel> {
  const path = resolveWorkerPath()
  const pending = new Map<number, Pending>()
  let self: Promise<Channel> | null = null
  const exited = (reason: string): void => {
    if (channel === self) channel = null
    failAll(pending, reason)
  }
  let ch: Channel
  if (process.versions.electron && (process as { type?: string }).type === 'browser') {
    const { utilityProcess } = await import('electron')
    const child = utilityProcess.fork(path, [], { serviceName: 'Agent Code Voice', stdio: 'inherit' })
    child.on('message', (m: WorkerResponse) => onMessage(pending, m))
    child.on('exit', (code) => exited(`código ${code}`))
    ch = { pending, post: (m) => child.postMessage(m), kill: () => void child.kill(), hold: () => undefined }
  } else {
    const { Worker } = await import('node:worker_threads')
    const worker = new Worker(path)
    worker.on('message', (m: WorkerResponse) => onMessage(pending, m))
    worker.on('error', (e) => exited(e.message))
    worker.on('exit', (code) => exited(`código ${code}`))
    worker.unref()
    ch = {
      pending,
      post: (m) => worker.postMessage(m),
      kill: () => void worker.terminate(),
      hold: (active) => (active ? worker.ref() : worker.unref())
    }
  }
  self = channel
  return ch
}

async function getChannel(): Promise<Channel> {
  if (!channel) {
    const dir = cacheDir
    if (!dir) throw new VoiceWorkerError('pasta de cache dos modelos de voz não definida (setVoiceCacheDir)')
    const created = spawn().then((ch) => {
      void send(ch, { op: 'config', cacheDir: dir }).catch(() => undefined)
      return ch
    })
    channel = created
    created.catch(() => {
      if (channel === created) channel = null
    })
  }
  return channel
}

function send(ch: Channel, req: Request, onProgress?: (p: VoiceProgress) => void): Promise<unknown> {
  const id = nextId++
  return new Promise<unknown>((resolve, reject) => {
    ch.pending.set(id, { resolve, reject, onProgress })
    ch.hold(true)
    ch.post({ ...req, id } as WorkerRequest)
  }).finally(() => {
    if (ch.pending.size === 0) ch.hold(false)
  })
}

export async function request(req: Request, onProgress?: (p: VoiceProgress) => void): Promise<unknown> {
  const ch = await getChannel()
  return send(ch, req, onProgress)
}

export function setCacheDir(dir: string): void {
  cacheDir = dir
  // A running worker only needs to know where future downloads go.
  if (channel) void channel.then((ch) => send(ch, { op: 'config', cacheDir: dir })).catch(() => undefined)
}

export async function stop(): Promise<void> {
  const current = channel
  if (!current) return
  channel = null
  let ch: Channel
  try {
    ch = await current
  } catch {
    return // never started
  }
  ch.kill()
  failAll(ch.pending, 'parado')
}
