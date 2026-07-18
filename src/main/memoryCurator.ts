import { query, type Options, type PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { appendFile, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { getCacheInfo, kvGet, kvSet } from './store'

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

Para cada correção realmente relevante:
1. Leia MEMORY.md e a memória do mesmo tópico, se houver. Atualize/complemente a existente; não
   duplique. Nunca apague arquivo, regra, linha de índice nem marque conteúdo como obsoleto.
2. Memória nova: um fato por <slug-kebab>.md, com este formato:
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
3. MEMORY.md deve ter exatamente uma entrada por tópico no formato
   - [Título](arquivo.md) — gancho curto
   Mantenha cada linha perto de 150 caracteres. Atualize a entrada do tópico ao complementar.

Se não houver correção qualificada, não toque em nenhum arquivo. Use apenas Read/Glob/Grep para
inspecionar e Write (só arquivo novo) ou Edit (arquivo existente) dentro da pasta de memórias.`

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

function inside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function realPathInside(root: string, candidate: string): boolean {
  if (!inside(root, candidate)) return false
  try {
    const existing = existsSync(candidate) ? candidate : dirname(candidate)
    return inside(realpathSync(root), realpathSync(existing))
  } catch {
    return false
  }
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

  const rawPath = input.file_path
  if (!['Read', 'Write', 'Edit'].includes(toolName) || typeof rawPath !== 'string') {
    return deny('Ferramenta indisponível no job add-only de memórias.')
  }
  const target = resolve(memoriesDir, rawPath)
  if (!realPathInside(memoriesDir, target)) {
    return deny('O curador só pode acessar arquivos dentro da pasta de memórias.')
  }
  if (toolName === 'Write' && existsSync(target)) {
    return deny('Arquivo existente não pode ser sobrescrito; use Edit para complementar.')
  }
  if (toolName === 'Edit' && !existsSync(target)) {
    return deny('Edit exige uma memória existente; use Write para criar uma nova.')
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
  const options: Options = {
    cwd: args.memoriesDir,
    executable: 'node',
    maxTurns: 12,
    permissionMode: 'default',
    settingSources: [],
    additionalDirectories: [args.memoriesDir],
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit'],
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

function indexTargets(markdown: string): Set<string> {
  const targets = new Set<string>()
  for (const match of markdown.matchAll(/^- \[[^\]]+\]\(([^)]+\.md)\)/gm)) targets.add(match[1])
  return targets
}

function memorySummary(markdown: string, filename: string): { title: string; hook: string } {
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() || filename.replace(/\.md$/i, '').replace(/-/g, ' ')
  const hook = /^description:\s*(.+)$/m.exec(markdown)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || 'Feedback aprendido com o usuário'
  return { title, hook }
}

/** Add missing index links deterministically; never rewrites or removes existing lines. */
export async function reconcileMemoryIndex(memoriesDir: string): Promise<void> {
  const indexPath = join(memoriesDir, 'MEMORY.md')
  const current = existsSync(indexPath) ? await readFile(indexPath, 'utf8') : '# Memórias\n'
  const targets = indexTargets(current)
  const files = (await readdir(memoriesDir)).filter((name) => name.endsWith('.md') && name !== 'MEMORY.md')
  const additions: string[] = []
  for (const filename of files.sort()) {
    if (targets.has(filename)) continue
    const summary = memorySummary(await readFile(join(memoriesDir, filename), 'utf8'), filename)
    const prefix = `- [${summary.title}](${filename}) — `
    additions.push(prefix + summary.hook.slice(0, Math.max(20, 155 - prefix.length)))
  }
  if (!existsSync(indexPath)) await writeFile(indexPath, current, 'utf8')
  if (additions.length) {
    const separator = current.endsWith('\n') ? '' : '\n'
    await appendFile(indexPath, `${separator}${additions.join('\n')}\n`, 'utf8')
  }
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
  if (chunkCount > 0) await reconcileMemoryIndex(memoriesDir)
  return { transcripts: transcriptCount, chunks: chunkCount }
}

/** Daily in-process scheduler. It catches up after app startup without creating
 *  an OS task and never emits anything into a user's chat. */
export function startMemoryCuratorScheduler(): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  let saved = 0
  try {
    saved = Number(kvGet(CURATOR_STATE_KEY) ?? 0)
  } catch {
    /* store unavailable: run the cheap mtime gate now */
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
    const since = lastRunAt
    try {
      await runMemoryCuratorOnce({ lastRunAt: since })
    } catch (error) {
      console.warn('[memory-curator] daily job failed:', error)
    } finally {
      const finishedAt = Date.now()
      lastRunAt = finishedAt
      try {
        kvSet(CURATOR_STATE_KEY, String(finishedAt))
      } catch (error) {
        console.warn('[memory-curator] could not persist last run:', error)
      }
      schedule(CURATOR_INTERVAL_MS)
    }
  }

  const dueIn = memoryCuratorDelay(saved, Date.now())
  schedule(dueIn)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
