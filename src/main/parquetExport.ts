import { existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { dailyParquetPath, exportConversationsParquet } from './conversationParquet'
import type { ConversationRecord } from './projectStore'

/** O que o worker recebe: o snapshot já lido do banco e onde gravar. */
export interface ParquetExportRequest {
  cacheDir: string
  memoryDir: string
  conversations: ConversationRecord[]
  source: { backend: 'sqlite' | 'postgres'; watermark: string }
  now: number
}

export interface ParquetExportDeps {
  cacheDir: string
  memoryDir: string
  readSnapshot(): Promise<{ conversations: ConversationRecord[]; backend: 'sqlite' | 'postgres'; watermark: string }>
  log(line: string): void
  /** Bundle do worker; `null` = codifica no próprio thread (testes, build sem ele). */
  workerFile?: string | null
}

export interface ParquetExportHandle {
  /** O arquivo gravado; `null` quando cancelado. Nunca rejeita (a falha vai ao log). */
  readonly done: Promise<string | null>
  /** Fechar o app não espera o export: termina o worker e apaga o temporário. */
  cancel(): void
}

const WORKER_FILE = 'parquetExportWorker.js'

/** O bundle do worker, irmão do index.js do main (ou um nível acima de um chunk). */
function defaultWorkerFile(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  return [join(here, WORKER_FILE), join(here, '..', WORKER_FILE)].find((path) => existsSync(path)) ?? null
}

/** Temporários de exports interrompidos (worker terminado no meio da gravação). */
export function removeParquetTemps(cacheDir: string, now = new Date()): void {
  const target = dailyParquetPath(cacheDir, now)
  const dir = dirname(target)
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.includes('.parquet.tmp-')) continue
    try {
      rmSync(join(dir, name), { force: true })
    } catch {
      /* em uso: o próximo export tenta de novo */
    }
  }
}

function runInWorker(file: string, request: ParquetExportRequest, onWorker: (worker: Worker) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(file)
    onWorker(worker)
    worker.once('message', (reply: { ok: boolean; path?: string; error?: string }) => {
      void worker.terminate()
      if (reply.ok && reply.path) resolve(reply.path)
      else reject(new Error(reply.error ?? 'O export em parquet falhou.'))
    })
    worker.once('error', reject)
    worker.once('exit', (code) => reject(new Error(`O worker do parquet saiu (código ${code}).`)))
    worker.postMessage(request)
  })
}

/**
 * O export diário: lê o snapshot do banco no main (E/S) e codifica/grava o
 * parquet num worker_thread. Mede leitura e codificação no log. O fechamento do
 * app chama `cancel()` em vez de esperar.
 */
export function startDailyParquetExport(deps: ParquetExportDeps): ParquetExportHandle {
  const started = Date.now()
  let cancelled = false
  let finished = false
  let worker: Worker | null = null
  const done = (async (): Promise<string | null> => {
    removeParquetTemps(deps.cacheDir)
    const snapshot = await deps.readSnapshot()
    const readMs = Date.now() - started
    if (cancelled) return null
    const request: ParquetExportRequest = {
      cacheDir: deps.cacheDir,
      memoryDir: deps.memoryDir,
      conversations: snapshot.conversations,
      source: { backend: snapshot.backend, watermark: snapshot.watermark },
      now: Date.now()
    }
    const file = deps.workerFile === undefined ? defaultWorkerFile() : deps.workerFile
    const encodeStarted = Date.now()
    const path = file
      ? await runInWorker(file, request, (created) => (worker = created))
      : await exportConversationsParquet(request.cacheDir, request.conversations, request.memoryDir, request.source, new Date(request.now))
    deps.log(
      `parquet: ${snapshot.conversations.length} conversas exportadas em ${Date.now() - started} ms ` +
        `(leitura ${readMs} ms, codificação ${Date.now() - encodeStarted} ms${file ? ', worker' : ', no thread principal'})`
    )
    return path
  })().catch((error: unknown) => {
    if (cancelled) return null
    deps.log(`parquet: export falhou depois de ${Date.now() - started} ms: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }).finally(() => {
    finished = true
  })
  return {
    done,
    cancel() {
      if (cancelled || finished) return
      cancelled = true
      deps.log(`parquet: export cancelado no fechamento depois de ${Date.now() - started} ms (${worker ? 'codificando' : 'lendo o banco'})`)
      const running = worker
      worker = null
      if (running) void running.terminate().finally(() => removeParquetTemps(deps.cacheDir))
    }
  }
}
