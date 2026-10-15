/**
 * Sincronização de skills do app inteiro, fora do thread principal.
 *
 * O profile de um envio lento mostrou ~90% das amostras em
 * syncCacheSkills/exposeCacheSkills (digests, cpSync e rmSync de ~250 skills num
 * cache no OneDrive, onde o renameSync dá EPERM e cai na cópia). Aqui:
 * - o trabalho de disco roda no worker `skillSyncWorker.js` (pedidos numerados,
 *   recriado se morrer); sem o bundle dele (testes), no próprio thread;
 * - uma execução por vez no app; chamadas simultâneas do mesmo alvo partilham a
 *   que está em voo quando ela cobre o que pedem;
 * - sem mudança de origem, a exposição roda no máximo 1x a cada 30 s por alvo,
 *   salvo quando a assinatura barata do chamador (skillCatalogFilesystemVersion)
 *   mudou; a versão da origem é conferida em toda chamada, no worker;
 * - com erro, a versão fica registrada mesmo assim e a nova tentativa completa só
 *   vem depois de 60 s.
 */
import { existsSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { SkillSyncResult } from '../skillManager'
import type { SkillKitId } from '../skillKits'
import { runSkillSync, type SkillSyncMode, type SkillSyncRequest, type SkillSyncResponse } from './skillSyncTask'

export type { SkillSyncResponse as SkillSyncOutcome } from './skillSyncTask'

/** Quem executa o pedido: o worker no app, a própria função nos testes. */
export interface SkillSyncRunner {
  run(request: SkillSyncRequest): Promise<SkillSyncResponse>
  dispose(): void
}

/** Resposta de um pedido que nem chegou a rodar: a versão conhecida fica, o erro vai junto. */
function failedResponse(request: SkillSyncRequest, error: unknown): SkillSyncResponse {
  const message = error instanceof Error ? error.message : String(error)
  return {
    version: request.knownVersion,
    full: request.mode === 'full',
    ran: true,
    result: { skillsDir: request.skillsDir, available: [], errors: [`Sincronização de skills falhou: ${message}`] }
  }
}

/** Resposta torta (módulo simulado nos testes devolvendo undefined) vira resposta válida. */
function normalizeResponse(request: SkillSyncRequest, response: SkillSyncResponse | undefined): SkillSyncResponse {
  if (!response || typeof response !== 'object') return failedResponse(request, 'resposta vazia')
  const result = response.result as Partial<SkillSyncResult> | undefined
  return {
    version: typeof response.version === 'string' ? response.version : request.knownVersion,
    full: response.full === true,
    ran: response.ran !== false,
    result: {
      skillsDir: typeof result?.skillsDir === 'string' ? result.skillsDir : request.skillsDir,
      available: Array.isArray(result?.available) ? result.available : [],
      errors: Array.isArray(result?.errors) ? result.errors.map(String) : []
    }
  }
}

export const inlineSkillSyncRunner: SkillSyncRunner = {
  run: async (request) => {
    try {
      return normalizeResponse(request, runSkillSync(request))
    } catch (error) {
      return failedResponse(request, error)
    }
  },
  dispose: () => undefined
}

const WORKER_FILE = 'skillSyncWorker.js'

/** O bundle do worker, irmão do index.js do main (ou um nível acima de um chunk). */
function workerPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  return [join(here, WORKER_FILE), join(here, '..', WORKER_FILE)].find((path) => existsSync(path)) ?? null
}

interface Pending {
  resolve: (response: SkillSyncResponse) => void
  reject: (error: Error) => void
}

interface WorkerReply {
  id: number
  ok: boolean
  response?: SkillSyncResponse
  error?: string
}

/**
 * Um worker, pedidos numerados. Worker que morre recusa os pedidos em voo e é
 * recriado no próximo; sem o bundle (testes, build sem ele), roda no próprio
 * thread — trava o envio, mas sincroniza igual.
 */
export function workerSkillSyncRunner(path: string | null = workerPath()): SkillSyncRunner {
  if (!path) return inlineSkillSyncRunner
  const file = path
  let worker: Worker | null = null
  let nextId = 1
  const pending = new Map<number, Pending>()

  const failAll = (error: Error): void => {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }
  const spawn = (): Worker => {
    const created = new Worker(file)
    created.unref()
    created.on('message', (reply: WorkerReply) => {
      const entry = pending.get(reply.id)
      if (!entry) return
      pending.delete(reply.id)
      if (reply.ok && reply.response) entry.resolve(reply.response)
      else entry.reject(new Error(reply.error ?? 'O worker de skills não devolveu resultado.'))
    })
    const lost = (reason: string): void => {
      if (worker === created) worker = null
      failAll(new Error(`O worker de skills parou (${reason}).`))
    }
    created.on('error', (error) => lost(error.message))
    created.on('exit', (code) => lost(`código ${code}`))
    return created
  }

  return {
    run(request) {
      worker ??= spawn()
      const id = nextId++
      return new Promise<SkillSyncResponse>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        worker!.postMessage({ id, request })
      })
    },
    dispose() {
      const current = worker
      worker = null
      failAll(new Error('Sincronização de skills encerrada.'))
      void current?.terminate()
    }
  }
}

export interface SkillSyncTarget {
  appRoot: string
  cacheDir: string
  /** `<cacheDir>/skills` quando omitido. */
  skillsDir?: string
  /** Home do usuário (a do dev já resolvida); `homedir()` quando omitida. */
  userHome?: string
  kits: readonly SkillKitId[]
}

export interface ManagedSyncOptions {
  /** Quem chama (a pasta da sessão): cada um tem a sua assinatura barata. */
  scope: string
  /** Assinatura barata do que o chamador vê (só metadados); mudou = expõe já. */
  fingerprint: () => string
}

export interface SkillSyncCoordinatorOptions {
  runner?: () => SkillSyncRunner
  now?: () => number
  machine?: string
  exposeTtlMs?: number
  errorBackoffMs?: number
}

export const EXPOSE_TTL_MS = 30_000
export const ERROR_BACKOFF_MS = 60_000
const MODE_RANK: Record<SkillSyncMode, number> = { check: 0, expose: 1, full: 2 }

interface TargetState {
  /** Versão da origem já levada a este cache (registrada mesmo com erro). */
  syncedVersion: string
  /** Última vez que um pedido tocou no disco; null = nunca. */
  lastRunAt: number | null
  lastFailed: boolean
  /** Depois de uma completa com erro: quando a próxima completa pode vir (0 = nenhuma pendente). */
  retryFullAt: number
  fingerprints: Map<string, string>
  inflight: { mode: SkillSyncMode; promise: Promise<SkillSyncResponse> } | null
}

function readFingerprint(options: ManagedSyncOptions): string {
  try {
    return options.fingerprint()
  } catch {
    return ''
  }
}

export class SkillSyncCoordinator {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly states = new Map<string, TargetState>()
  private runnerInstance: SkillSyncRunner | null = null

  constructor(private readonly options: SkillSyncCoordinatorOptions = {}) {}

  /** Sincronização completa (subida do app, troca de cache, kits ligados/desligados). */
  async syncAll(target: SkillSyncTarget): Promise<SkillSyncResult> {
    return (await this.schedule(target, 'full')).result
  }

  /** Antes de cada envio: completa se a origem mudou; senão expõe, respeitando o TTL. */
  syncManaged(target: SkillSyncTarget, options: ManagedSyncOptions): Promise<SkillSyncResponse> {
    const state = this.state(target)
    const now = this.now()
    const fingerprint = readFingerprint(options)
    const ttl = state.lastFailed ? this.backoffMs : this.ttlMs
    let mode: SkillSyncMode =
      state.lastRunAt === null || state.fingerprints.get(options.scope) !== fingerprint || now - state.lastRunAt >= ttl
        ? 'expose'
        : 'check'
    if (state.retryFullAt > 0 && now >= state.retryFullAt) mode = 'full'
    return this.schedule(target, mode, options)
  }

  dispose(): void {
    this.runnerInstance?.dispose()
    this.runnerInstance = null
  }

  private get ttlMs(): number {
    return this.options.exposeTtlMs ?? EXPOSE_TTL_MS
  }

  private get backoffMs(): number {
    return this.options.errorBackoffMs ?? ERROR_BACKOFF_MS
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private runner(): SkillSyncRunner {
    return (this.runnerInstance ??= (this.options.runner ?? workerSkillSyncRunner)())
  }

  private resolved(target: SkillSyncTarget): Required<SkillSyncTarget> {
    return {
      appRoot: target.appRoot,
      cacheDir: target.cacheDir,
      skillsDir: target.skillsDir ?? join(target.cacheDir, 'skills'),
      userHome: target.userHome ?? homedir(),
      kits: [...target.kits].sort()
    }
  }

  private state(target: SkillSyncTarget): TargetState {
    const t = this.resolved(target)
    const key = JSON.stringify([t.appRoot, t.cacheDir, t.skillsDir, t.userHome, t.kits])
    let state = this.states.get(key)
    if (!state) {
      state = { syncedVersion: '', lastRunAt: null, lastFailed: false, retryFullAt: 0, fingerprints: new Map(), inflight: null }
      this.states.set(key, state)
    }
    return state
  }

  private schedule(target: SkillSyncTarget, mode: SkillSyncMode, options?: ManagedSyncOptions): Promise<SkillSyncResponse> {
    const state = this.state(target)
    const current = state.inflight
    if (current && MODE_RANK[current.mode] >= MODE_RANK[mode]) {
      // Partilha a execução em voo; a assinatura deste chamador vale o pós-execução dela.
      return current.promise.then((response) => {
        if (options && response.ran) state.fingerprints.set(options.scope, readFingerprint(options))
        return response
      })
    }
    const promise = this.tail.then(() => this.execute(target, state, mode, options))
    this.tail = promise.catch(() => undefined)
    state.inflight = { mode, promise }
    return promise
  }

  private async execute(
    target: SkillSyncTarget,
    state: TargetState,
    mode: SkillSyncMode,
    options?: ManagedSyncOptions
  ): Promise<SkillSyncResponse> {
    const t = this.resolved(target)
    const request: SkillSyncRequest = {
      mode,
      appRoot: t.appRoot,
      cacheDir: t.cacheDir,
      skillsDir: t.skillsDir,
      userHome: t.userHome,
      machine: this.options.machine ?? hostname(),
      kits: [...t.kits],
      // Lida na hora de rodar: um pedido na fila depois de uma completa já vê a versão nova.
      knownVersion: state.syncedVersion
    }
    let response: SkillSyncResponse
    try {
      response = normalizeResponse(request, await this.runner().run(request))
    } catch (error) {
      response = failedResponse(request, error)
    } finally {
      if (state.inflight?.mode === mode) state.inflight = null
    }
    if (response.ran) {
      const now = this.now()
      const failed = response.result.errors.length > 0
      // A versão fica registrada mesmo com erro: sem isso, cada envio repetia a completa.
      state.syncedVersion = response.version
      state.lastRunAt = now
      state.lastFailed = failed
      if (response.full) state.retryFullAt = failed ? now + this.backoffMs : 0
      if (options) state.fingerprints.set(options.scope, readFingerprint(options))
    }
    return response
  }
}

let shared: SkillSyncCoordinator | null = null

/** O coordenador do app (um worker, uma fila). */
export function skillSync(): SkillSyncCoordinator {
  return (shared ??= new SkillSyncCoordinator())
}
