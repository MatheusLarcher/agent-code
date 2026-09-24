import { query, type Options, type PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { getCacheInfo } from './store'
import { readPersistedKv, writePersistedKv } from './persistence/kvFacade'
import { realPathInside } from './memory/memoryPaths'
import { createMemoryMcpServer } from './memory/memoryTools'
import { memoryService, secretSink, secretVaultEnabled } from './memory/memoryRuntime'

export const CURATOR_MARKER = 'AGENT_CODE_MEMORY_CURATOR_V1'
export const CURATOR_STATE_KEY = 'memory-curator:last-run-at'
export const CURATOR_INTERVAL_MS = 24 * 60 * 60_000
const TRANSCRIPT_CHUNK_CHARS = 180_000

export const MEMORY_CURATOR_INSTRUCTIONS = `${CURATOR_MARKER}
Você é o curador diário de memórias do agent-code. Trabalha fora da conversa normal do usuário.

Analise SOMENTE correções ou ensinamentos explícitos feitos pelo usuário ao LLM que o LLM não
teria acertado sozinho: API/documentação que mudou, comportamento real que contradisse o modelo,
convenção não derivável do código/git ou tentativa que falhou e cujo caminho correto o usuário
ensinou. Ignore debug resolvido pelo próprio LLM, decisões triviais, preferências óbvias e fatos
já deriváveis do repositório.

Você NÃO escreve arquivos. Para salvar, use a ferramenta memory_propose; ela grava o arquivo e
regenera o índice. Use memory_list para achar o tópico existente e a revisão dele.

Para cada correção realmente relevante:
1. Procure a memória do mesmo tópico (memory_list / Read). Existindo, use op "update" com o
   expected_revision devolvido, complementando o texto. Nunca apague conteúdo nem marque como
   obsoleto; op "retire" só quando o fato virou falso.
2. Memória nova: op "create", um fato por <slug-kebab>.md, com este corpo:
---
name: slug-kebab
description: gancho curto e específico
metadata:
  type: feedback
---
# Título claro
Rule: regra aprendida.
Why: erro/tentativa que motivou a correção.
How to apply: quando e como usar a regra.
Fix applied: correção concreta que o LLM fez depois do feedback.
3. O índice MEMORY.md é gerado pelo app a partir do title e do hook que você passar — não tente
   editá-lo. Escreva o hook curto e específico, perto de 150 caracteres.
4. A pasta pode ter subpastas de agrupamento (ex.: "2D/"). O nome da subpasta é contexto: memória
   sobre aquele assunto usa rel_path "2D/arquivo.md". Ao procurar o tópico existente, olhe também
   dentro das subpastas.
5. Se o trecho contiver uma credencial (chave, token, senha), passe-a em secrets: [{name, value}];
   o valor vai para o cofre cifrado e o texto guarda só o marcador.

Se não houver correção qualificada, não proponha nada. Use apenas Read/Glob/Grep para inspecionar.`

type AgentRunner = (args: {
  memoriesDir: string
  transcript: string
  source: string
  chunk: number
  chunks: number
}) => Promise<void>

export interface CuratorRunOptions {
  now?: number
  /** Timestamp (ms) of the last successful run. Transcripts are scanned since
   *  this point, not just the last 24h, so a gap in app usage (closed for
   *  several days) is caught up in full instead of silently skipped. Omit
   *  on the very first run ever (no prior state to catch up from). */
  lastRunAt?: number
  projectsDir?: string
  memoriesDir?: string
  runAgent?: AgentRunner
}

export interface CuratorRunResult {
  transcripts: number
  chunks: number
}

export function memoryCuratorDelay(lastRunAt: number, now: number): number {
  return Number.isFinite(lastRunAt) ? Math.max(0, lastRunAt + CURATOR_INTERVAL_MS - now) : 0
}

/** Auto-approval gate with no renderer prompt and no write access outside memories. */
export function memoryCuratorPermission(
  memoriesDir: string,
  toolName: string,
  input: Record<string, unknown>
): Promise<PermissionResult> {
  const allow = (): Promise<PermissionResult> =>
    Promise.resolve({ behavior: 'allow', updatedInput: input })
  const deny = (message: string): Promise<PermissionResult> =>
    Promise.resolve({ behavior: 'deny', message })

  if (toolName === 'Glob') {
    const base = typeof input.path === 'string' ? input.path : memoriesDir
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    return realPathInside(memoriesDir, resolve(memoriesDir, base)) && !isAbsolute(pattern) && !pattern.includes('..')
      ? allow()
      : deny('O curador só pode listar a pasta de memórias.')
  }
  if (toolName === 'Grep') {
    const base = typeof input.path === 'string' ? input.path : memoriesDir
    return realPathInside(memoriesDir, resolve(memoriesDir, base))
      ? allow()
      : deny('O curador só pode pesquisar a pasta de memórias.')
  }

  // Saving goes through the memory service, exactly like a chat session: the
  // curator no longer writes the .md or the index itself.
  if (toolName.startsWith('mcp__memory__')) return allow()
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    return deny('O curador não escreve arquivos; use memory_propose (create/update/retire).')
  }

  const rawPath = input.file_path
  if (toolName !== 'Read' || typeof rawPath !== 'string') {
    return deny('Ferramenta indisponível no job de memórias.')
  }
  if (!realPathInside(memoriesDir, resolve(memoriesDir, rawPath))) {
    return deny('O curador só pode acessar arquivos dentro da pasta de memórias.')
  }
  return allow()
}

function stripInjectedText(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, '')
    .trim()
}

function blockText(block: unknown): { human?: string; tool?: string } {
  if (!block || typeof block !== 'object') return {}
  const item = block as Record<string, unknown>
  if (item.type === 'text' && typeof item.text === 'string') {
    const text = stripInjectedText(item.text)
    return text ? { human: text } : {}
  }
  if (item.type === 'tool_use') {
    return { tool: `[TOOL ${String(item.name ?? '')}] ${JSON.stringify(item.input ?? {})}` }
  }
  if (item.type === 'tool_result') {
    const content = typeof item.content === 'string' ? item.content : JSON.stringify(item.content ?? '')
    return { tool: `[TOOL RESULT ${String(item.tool_use_id ?? '')}] ${content}` }
  }
  return {}
}

function transcriptEntry(line: string): string[] {
  let record: Record<string, unknown>
  try {
    record = JSON.parse(line) as Record<string, unknown>
  } catch {
    return []
  }
  if (record.type !== 'user' && record.type !== 'assistant') return []
  if (record.isSidechain === true) return []
  const message = record.message as Record<string, unknown> | undefined
  const role = message?.role
  if (role !== 'user' && role !== 'assistant') return []
  const content = message?.content
  if (typeof content === 'string') {
    const clean = stripInjectedText(content)
    return clean ? [`${role === 'user' ? 'USER' : 'ASSISTANT'}: ${clean.slice(0, 30_000)}`] : []
  }
  if (!Array.isArray(content)) return []
  const human: string[] = []
  const tools: string[] = []
  for (const block of content) {
    const part = blockText(block)
    if (part.human) human.push(part.human)
    if (part.tool) tools.push(part.tool.slice(0, 20_000))
  }
  const out: string[] = []
  if (human.length) out.push(`${role === 'user' ? 'USER' : 'ASSISTANT'}: ${human.join('\n').slice(0, 30_000)}`)
  if (tools.length) {
    out.push(`${role === 'user' ? 'TOOL OUTPUT' : 'ASSISTANT ACTION'}: ${tools.join('\n').slice(0, 60_000)}`)
  }
  return out
}

/** Parse JSONL into bounded chronological chunks while preserving role labels. */
export function normalizeTranscript(raw: string): string[] {
  const entries = raw.split(/\r?\n/).flatMap(transcriptEntry)
  const chunks: string[] = []
  let current: string[] = []
  for (const entry of entries) {
    const next = [...current, entry].join('\n\n')
    if (current.length && next.length > TRANSCRIPT_CHUNK_CHARS) {
      chunks.push(current.join('\n\n'))
      // Keep the immediately preceding exchange so a correction and its
      // concrete fix cannot be split across two independent agent sessions.
      current = current.slice(-2)
      while (current.length && [...current, entry].join('\n\n').length > TRANSCRIPT_CHUNK_CHARS) {
        current.shift()
      }
    }
    current.push(entry)
  }
  if (current.length) chunks.push(current.join('\n\n'))
  return chunks
}

async function walkJsonl(root: string): Promise<string[]> {
  const found: string[] = []
  const pending = [root]
  while (pending.length) {
    const dir = pending.shift()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(path)
    }
  }
  return found
}

export async function findRecentTranscripts(projectsDir: string, since: number): Promise<string[]> {
  const files = await walkJsonl(projectsDir)
  const recent: Array<{ path: string; mtime: number }> = []
  for (const path of files) {
    try {
      const info = await stat(path)
      if (info.mtimeMs >= since) recent.push({ path, mtime: info.mtimeMs })
    } catch {
      /* vanished during scan */
    }
  }
  recent.sort((a, b) => a.mtime - b.mtime)
  return recent.map((item) => item.path)
}

export async function runMemoryCuratorAgent(args: Parameters<AgentRunner>[0]): Promise<void> {
  const service = memoryService()
  if (!service) {
    // Storage offline or not bound yet. Skipping is the honest outcome: the old
    // direct-write path would put the files out of sync with the database.
    throw new Error('Serviço de memória indisponível; curadoria adiada.')
  }
  const options: Options = {
    cwd: args.memoriesDir,
    executable: 'node',
    maxTurns: 12,
    permissionMode: 'default',
    settingSources: [],
    // A única pasta de memória é a da pasta de dados (Configurações); a
    // auto-memória do CLI poria ~/.claude/projects/<cwd>/memory no prompt.
    settings: { autoMemoryEnabled: false },
    additionalDirectories: [args.memoriesDir],
    tools: ['Read', 'Glob', 'Grep', 'mcp__memory__memory_propose', 'mcp__memory__memory_list'],
    mcpServers: {
      memory: createMemoryMcpServer({
        service,
        vault: secretSink(),
        secretVaultEnabled,
        // The curator reads transcripts in bulk; it may STORE a secret it finds,
        // but it has no reason to read one back out of the vault.
        readSecret: null,
        conversationId: 'curator',
        agent: 'curator'
      })
    },
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: `${MEMORY_CURATOR_INSTRUCTIONS}\n\nA pasta de memórias autorizada nesta execução é EXATAMENTE:\n${args.memoriesDir}\nNão use o diretório automático ~/.claude/projects/.../memory do Claude Code.`
    },
    canUseTool: (toolName, input) => memoryCuratorPermission(args.memoriesDir, toolName, input)
  }
  const prompt = `${CURATOR_MARKER}\nPasta de memórias: ${args.memoriesDir}\nFonte: ${args.source}\nTrecho ${args.chunk}/${args.chunks}\n\n${args.transcript}`
  let failure = ''
  for await (const message of query({ prompt, options })) {
    if (message.type === 'result' && message.is_error) failure = message.subtype
  }
  if (failure) throw new Error(failure)
}


export async function runMemoryCuratorOnce(options: CuratorRunOptions = {}): Promise<CuratorRunResult> {
  const now = options.now ?? Date.now()
  const projectsDir = options.projectsDir ?? join(homedir(), '.claude', 'projects')
  const memoriesDir = options.memoriesDir ?? getCacheInfo().memoriesDir
  const runAgent = options.runAgent ?? runMemoryCuratorAgent
  // Catch up from the last successful run, not a fixed 24h lookback: the app
  // isn't always open daily, and a fixed window would silently drop any day
  // the scheduler missed (its transcripts age out of "last 24h" and never
  // come back into a future window).
  const since =
    options.lastRunAt !== undefined && Number.isFinite(options.lastRunAt)
      ? options.lastRunAt
      : now - CURATOR_INTERVAL_MS
  const paths = await findRecentTranscripts(projectsDir, since)
  let transcriptCount = 0
  let chunkCount = 0
  for (const path of paths) {
    const raw = await readFile(path, 'utf8')
    // Never curate the curators: their prompt embeds old transcripts and would
    // recursively manufacture duplicate feedback on the next daily pass.
    if (raw.includes(CURATOR_MARKER)) continue
    const chunks = normalizeTranscript(raw)
    if (!chunks.length) continue
    transcriptCount++
    for (let index = 0; index < chunks.length; index++) {
      await runAgent({
        memoriesDir,
        transcript: chunks[index],
        source: path,
        chunk: index + 1,
        chunks: chunks.length
      })
      chunkCount++
    }
  }
  // MEMORY.md is now generated from the database, so the old add-only patcher
  // would fight it. Reconciling re-projects whatever a crash left behind.
  if (chunkCount > 0) await memoryService()?.reconcile()
  return { transcripts: transcriptCount, chunks: chunkCount }
}

export interface CuratorSchedulerOptions {
  now?: () => number
  runOnce?: (options: CuratorRunOptions) => Promise<CuratorRunResult>
  readCheckpoint?: () => Promise<string | null>
  writeCheckpoint?: (value: string) => Promise<void>
}

/** Daily in-process scheduler. It catches up after app startup without creating
 *  an OS task and never emits anything into a user's chat. */
export async function startMemoryCuratorScheduler(options: CuratorSchedulerOptions = {}): Promise<() => void> {
  const now = options.now ?? Date.now
  const runOnce = options.runOnce ?? runMemoryCuratorOnce
  const readCheckpoint = options.readCheckpoint ?? (() => readPersistedKv(CURATOR_STATE_KEY))
  const writeCheckpoint = options.writeCheckpoint ?? ((value: string) => writePersistedKv(CURATOR_STATE_KEY, value))
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  let saved = 0
  let checkpointLoaded = false
  const loadCheckpoint = async (): Promise<number> => {
    const raw = await readCheckpoint()
    const value = raw === null ? 0 : Number(raw)
    if (!Number.isFinite(value) || value < 0 || (raw !== null && !raw.trim())) {
      throw new Error('Invalid memory curator checkpoint')
    }
    return value
  }
  try {
    saved = await loadCheckpoint()
    checkpointLoaded = true
  } catch (error) {
    console.warn('[memory-curator] checkpoint unavailable; scan deferred:', error)
  }
  // Carried across runs so a scan can catch up since the last successful
  // completion instead of only the last 24h (see runMemoryCuratorOnce).
  let lastRunAt: number | undefined = Number.isFinite(saved) && saved > 0 ? saved : undefined

  const schedule = (delay: number): void => {
    if (stopped) return
    timer = setTimeout(() => void run(), delay)
  }
  const run = async (): Promise<void> => {
    if (stopped) return
    try {
      if (!checkpointLoaded) {
        saved = await loadCheckpoint()
        lastRunAt = saved > 0 ? saved : undefined
        checkpointLoaded = true
        if (memoryCuratorDelay(saved, now()) > 0) return
      }
      if (stopped) return
      const since = lastRunAt
      const runStartedAt = now()
      await runOnce({ lastRunAt: since, now: runStartedAt })
      // Persist before advancing the in-memory cursor. Either failure leaves
      // the previous window intact; changes during the scan belong to the next run.
      await writeCheckpoint(String(runStartedAt))
      lastRunAt = runStartedAt
    } catch (error) {
      console.warn('[memory-curator] daily job or checkpoint failed:', error)
    } finally {
      schedule(CURATOR_INTERVAL_MS)
    }
  }

  const dueIn = memoryCuratorDelay(saved, now())
  schedule(dueIn)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
