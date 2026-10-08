import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
import {
  getSessionInfo,
  getSessionMessages,
  importSessionToStore,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry
} from '@anthropic-ai/claude-agent-sdk'
import { hashJson, normalizeJson } from './hashes'
import { sessionKeyId } from './replayDedup'
import { StorageError, type PersistenceRepository } from './types'

/** Mesmo lote padrão do `importSessionToStore` do SDK. */
const BATCH_SIZE = 500
/** Teto de bytes por lote, para uma linha gigante (imagem colada) não virar um
 *  INSERT enorme junto de outras 499. */
const BATCH_BYTES = 4 * 1024 * 1024
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ReplayTarget {
  /** Pasta do projeto (cwd da sessão). */
  cwd: string
  /** `CLAUDE_CONFIG_DIR` com que o CLI da sessão rodou; `undefined` = o do app. */
  configDir?: string
}

/**
 * Reenvia o transcript LOCAL da sessão (e dos subagentes) ao store. É o reparo
 * de um lote que o SDK descartou (mirror_error): o transcript local é durável —
 * o SDK só espelha depois de gravá-lo.
 *
 * Com a pasta de config do próprio app usa o `importSessionToStore` do SDK. Com
 * outra (conta Claude extra, GPT, Ollama) o SDK não serve: ele resolve a pasta
 * pelo `CLAUDE_CONFIG_DIR` do processo, e trocar essa variável no processo
 * principal vazaria para as outras sessões. Aí o arquivo é lido direto, no mesmo
 * formato que o SDK lê (uma entrada JSON por linha, subagentes em
 * `<sessão>/subagents/**.jsonl` com o sidecar `.meta.json`).
 *
 * O `store` precisa ser o de replay (sem duplicar entrada sem uuid).
 */
export async function replayLocalTranscript(sessionId: string, store: SessionStore, target: ReplayTarget): Promise<void> {
  if (!UUID_RE.test(sessionId)) throw new Error(`Id de sessão inválido: ${sessionId}`)
  const configDir = target.configDir?.trim()
  if (!configDir || configDir === process.env['CLAUDE_CONFIG_DIR']?.trim()) {
    await importSessionToStore(sessionId, store, { dir: target.cwd, includeSubagents: true, batchSize: BATCH_SIZE })
    return
  }
  const file = await findSessionFile(configDir, sessionId)
  if (!file) throw new Error(`Transcript local da sessão ${sessionId} não encontrado em ${configDir}.`)
  const key: SessionKey = { projectKey: target.cwd, sessionId }
  await appendJsonl(file, key, store)
  const sessionDir = file.replace(/\.jsonl$/, '')
  for (const agentFile of await listJsonl(join(sessionDir, 'subagents'))) {
    const parts = relative(sessionDir, agentFile).split(sep)
    parts[parts.length - 1] = parts[parts.length - 1].replace(/\.jsonl$/, '')
    const agentKey: SessionKey = { ...key, subpath: parts.join('/') }
    await appendJsonl(agentFile, agentKey, store)
    const sidecar = await readFile(agentFile.replace(/\.jsonl$/, '.meta.json'), 'utf8').catch(() => null)
    if (sidecar === null) continue
    try {
      const meta = JSON.parse(sidecar) as Record<string, unknown>
      await store.append(agentKey, [{ type: 'agent_metadata', ...meta }])
    } catch (error) {
      console.warn(`[mirror-repair] sidecar ilegível ignorado ${agentFile}:`, error)
    }
  }
}

/** O id é um UUID: procurar em todas as pastas de projeto evita reimplementar
 *  a regra do SDK que transforma o cwd no nome da pasta. */
async function findSessionFile(configDir: string, sessionId: string): Promise<string | null> {
  const projects = join(configDir, 'projects')
  const dirs = await readdir(projects, { withFileTypes: true }).catch(() => [])
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const candidate = join(projects, dir.name, `${sessionId}.jsonl`)
    const info = await stat(candidate).catch(() => null)
    if (info?.isFile() && info.size > 0) return candidate
  }
  return null
}

async function listJsonl(dir: string): Promise<string[]> {
  const found: string[] = []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await listJsonl(path)))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(path)
  }
  return found
}

async function appendJsonl(file: string, key: SessionKey, store: SessionStore): Promise<void> {
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  let batch: SessionStoreEntry[] = []
  let bytes = 0
  for await (const line of lines) {
    if (!line.trim()) continue
    try {
      batch.push(JSON.parse(line) as SessionStoreEntry)
    } catch {
      // Última linha ainda sendo escrita, ou corrompida: o SDK também pula.
      continue
    }
    bytes += line.length
    if (batch.length >= BATCH_SIZE || bytes >= BATCH_BYTES) {
      await store.append(key, batch)
      batch = []
      bytes = 0
    }
  }
  if (batch.length) await store.append(key, batch)
}

/**
 * O store com `load` memorizado por sessão + subpath (o `projectKey` os stores
 * do app já ignoram: a conversa vem do próprio store). A verificação lê a MESMA
 * sessão em três chamadas — getSessionInfo, a conferência e getSessionMessages —
 * e uma sessão com screenshots em base64 passa de 100 MB: eram três downloads
 * dela inteira. Só para as leituras de uma verificação, depois dos appends.
 */
export function loadOnce(store: SessionStore): SessionStore {
  const loads = new Map<string, Promise<SessionStoreEntry[] | null>>()
  return {
    ...store,
    load(key) {
      const id = sessionKeyId(key)
      let pending = loads.get(id)
      if (!pending) {
        pending = store.load(key)
        loads.set(id, pending)
      }
      return pending
    }
  }
}

type VerifyRepository = Pick<PersistenceRepository, 'markSessionResumeReady'>

/**
 * A verificação que libera a retomada: o SDK consegue ler a sessão PELO store e
 * o conteúdo não está vazio. Só então `resume_ready = true` com o hash do que
 * foi verificado. Compartilhada pelo fim de turno e pelo reparo do espelho —
 * o reparo nunca marca pronto por outro caminho.
 */
export async function verifyMirroredSession(
  repository: VerifyRepository,
  store: SessionStore,
  conversationId: string,
  sessionId: string,
  cwd: string
): Promise<void> {
  const reader = loadOnce(store)
  const [info, entries] = await Promise.all([
    getSessionInfo(sessionId, { dir: cwd, sessionStore: reader }),
    reader.load({ projectKey: conversationId, sessionId })
  ])
  if (!info || !entries?.length) {
    throw new StorageError('SESSION_HANDOFF_INCOMPLETE', 'O transcript espelhado não passou na verificação.')
  }
  // Antes de getSessionMessages, que recebe as mesmas entradas: o hash é do que o banco devolveu.
  const verifiedHash = hashJson(normalizeJson(entries))
  await getSessionMessages(sessionId, { dir: cwd, sessionStore: reader })
  await repository.markSessionResumeReady(conversationId, sessionId, true, verifiedHash)
}
