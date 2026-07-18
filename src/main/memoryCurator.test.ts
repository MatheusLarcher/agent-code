// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CURATOR_INTERVAL_MS,
  CURATOR_MARKER,
  findRecentTranscripts,
  memoryCuratorDelay,
  memoryCuratorPermission,
  normalizeTranscript,
  reconcileMemoryIndex,
  runMemoryCuratorAgent,
  runMemoryCuratorOnce
} from './memoryCurator'

const temps: string[] = []
async function temp(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-code-curator-'))
  temps.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('memory curator — transcript gate and normalization', () => {
  it('finds only jsonl modified inside the 24h window', async () => {
    const root = await temp()
    const project = join(root, 'encoded-project')
    await mkdir(project)
    const recent = join(project, 'recent.jsonl')
    const old = join(project, 'old.jsonl')
    await writeFile(recent, '{}')
    await writeFile(old, '{}')
    const now = Date.now()
    const { utimes } = await import('node:fs/promises')
    await utimes(recent, now / 1000, now / 1000)
    await utimes(old, (now - CURATOR_INTERVAL_MS - 1_000) / 1000, (now - CURATOR_INTERVAL_MS - 1_000) / 1000)

    await expect(findRecentTranscripts(root, now - CURATOR_INTERVAL_MS)).resolves.toEqual([recent])
  })

  it('keeps human correction plus the concrete assistant edit and drops injected reminders', () => {
    const raw = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Essa API mudou: use v2. <system-reminder>ignore</system-reminder>' } }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [
          { type: 'text', text: 'Entendi; vou corrigir.' },
          { type: 'tool_use', name: 'Edit', input: { file_path: 'x.ts', new_string: 'api.v2()' } }
        ] }
      })
    ].join('\n')

    const chunks = normalizeTranscript(raw)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain('USER: Essa API mudou: use v2.')
    expect(chunks[0]).toContain('[TOOL Edit]')
    expect(chunks[0]).toContain('api.v2()')
    expect(chunks[0]).not.toContain('system-reminder')
  })

  it('computes daily catch-up delay without a negative timer', () => {
    expect(memoryCuratorDelay(1_000, 1_000 + CURATOR_INTERVAL_MS + 5)).toBe(0)
    expect(memoryCuratorDelay(1_000, 2_000)).toBe(CURATOR_INTERVAL_MS - 1_000)
  })
})

describe('memory curator — isolated add-only execution', () => {
  it('does not start an agent when there is no recent conversation', async () => {
    const root = await temp()
    const memories = join(root, 'memories')
    await mkdir(memories)
    const runAgent = vi.fn(async () => {})
    const result = await runMemoryCuratorOnce({ projectsDir: join(root, 'missing'), memoriesDir: memories, runAgent })
    expect(result).toEqual({ transcripts: 0, chunks: 0 })
    expect(runAgent).not.toHaveBeenCalled()
  })

  it('catches up transcripts older than 24h when the app skipped a few days', async () => {
    const root = await temp()
    const projects = join(root, 'projects', 'encoded')
    const memories = join(root, 'memories')
    await mkdir(projects, { recursive: true })
    await mkdir(memories)
    const stale = join(projects, 'three-days-ago.jsonl')
    await writeFile(stale, JSON.stringify({ type: 'user', message: { role: 'user', content: 'Use a API v2, não v1.' } }))
    const now = Date.now()
    const { utimes } = await import('node:fs/promises')
    const threeDaysAgo = now - 3 * CURATOR_INTERVAL_MS
    await utimes(stale, threeDaysAgo / 1000, threeDaysAgo / 1000)
    const runAgent = vi.fn(async () => {})

    // A fixed 24h lookback from `now` would miss this transcript entirely;
    // `lastRunAt` (the scheduler was last run 3 days ago) must catch it up.
    const missed = await runMemoryCuratorOnce({
      now,
      projectsDir: join(root, 'projects'),
      memoriesDir: memories,
      runAgent
    })
    expect(missed).toEqual({ transcripts: 0, chunks: 0 })

    const caughtUp = await runMemoryCuratorOnce({
      now,
      lastRunAt: threeDaysAgo - 1_000,
      projectsDir: join(root, 'projects'),
      memoriesDir: memories,
      runAgent
    })
    expect(caughtUp).toEqual({ transcripts: 1, chunks: 1 })
    expect(runAgent).toHaveBeenCalledTimes(1)
  })

  it.skipIf(process.env['MEMORY_CURATOR_LIVE'] !== '1')(
    'live: a real isolated SDK session creates a feedback memory from a synthetic correction',
    async () => {
      const memories = await temp()
      await writeFile(join(memories, 'MEMORY.md'), '# Memórias\n')
      await runMemoryCuratorAgent({
        memoriesDir: memories,
        source: 'synthetic-live-probe.jsonl',
        chunk: 1,
        chunks: 1,
        transcript: [
          'ASSISTANT: A biblioteca fictícia ZephyrQueue usa connectLegacy().',
          'USER: Isso está desatualizado e foi o que causou o erro. Desde a versão 9, use connect({ transport: "stream" }).',
          'ASSISTANT: Corrigi para connect({ transport: "stream" }).',
          'ASSISTANT ACTION: [TOOL Edit] {"file_path":"client.ts","new_string":"connect({ transport: \\\"stream\\\" })"}'
        ].join('\n\n')
      })
      await reconcileMemoryIndex(memories)
      const files = await import('node:fs/promises').then((fs) => fs.readdir(memories))
      const memoryFiles = files.filter((name) => name.endsWith('.md') && name !== 'MEMORY.md')
      expect(memoryFiles.length).toBeGreaterThan(0)
      const memory = await readFile(join(memories, memoryFiles[0]), 'utf8')
      expect(memory).toContain('metadata:')
      expect(memory).toContain('type: feedback')
      expect(memory).toMatch(/Why:/i)
      expect(memory).toMatch(/How to apply:/i)
      expect(memory).toMatch(/Fix applied:/i)
      expect(await readFile(join(memories, 'MEMORY.md'), 'utf8')).toContain(`(${memoryFiles[0]})`)
    },
    180_000
  )

  it('ignores transcripts produced by the curator itself', async () => {
    const root = await temp()
    const projects = join(root, 'projects', 'memory-project')
    const memories = join(root, 'memories')
    await mkdir(projects, { recursive: true })
    await mkdir(memories)
    await writeFile(join(projects, 'curator.jsonl'), `${CURATOR_MARKER}\n`)
    const runAgent = vi.fn(async () => {})
    const result = await runMemoryCuratorOnce({ projectsDir: join(root, 'projects'), memoriesDir: memories, runAgent })
    expect(result).toEqual({ transcripts: 0, chunks: 0 })
    expect(runAgent).not.toHaveBeenCalled()
  })

  it('runs the isolated agent for a real transcript and reconciles the index add-only', async () => {
    const root = await temp()
    const projects = join(root, 'projects', 'encoded')
    const memories = join(root, 'memories')
    await mkdir(projects, { recursive: true })
    await mkdir(memories)
    await writeFile(join(projects, 'session.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'Use a API v2, não v1.' } }))
    await writeFile(join(memories, 'MEMORY.md'), '# Memórias\n\n- [Antiga](antiga.md) — manter\n')
    await writeFile(join(memories, 'antiga.md'), '# Antiga\n')
    const runAgent = vi.fn(async ({ memoriesDir }) => {
      await writeFile(join(memoriesDir, 'api-v2.md'), '---\nname: api-v2\ndescription: usar a API v2\nmetadata:\n  type: feedback\n---\n# API v2\nRule: use v2\nWhy: v1 falhou\nHow to apply: integrações\nFix applied: chamada migrada\n')
    })

    await expect(runMemoryCuratorOnce({ projectsDir: join(root, 'projects'), memoriesDir: memories, runAgent }))
      .resolves.toEqual({ transcripts: 1, chunks: 1 })
    const index = await readFile(join(memories, 'MEMORY.md'), 'utf8')
    expect(index).toContain('[Antiga](antiga.md) — manter')
    expect(index).toContain('[API v2](api-v2.md) — usar a API v2')
  })

  it('allows writes only inside memories and refuses overwrite with Write', async () => {
    const root = await temp()
    const memories = join(root, 'memories')
    await mkdir(memories)
    const existing = join(memories, 'MEMORY.md')
    await writeFile(existing, '# Memórias')

    await expect(memoryCuratorPermission(memories, 'Write', { file_path: join(memories, 'nova.md') }))
      .resolves.toMatchObject({ behavior: 'allow' })
    await expect(memoryCuratorPermission(memories, 'Write', { file_path: existing }))
      .resolves.toMatchObject({ behavior: 'deny' })
    await expect(memoryCuratorPermission(memories, 'Read', { file_path: join(root, 'fora.txt') }))
      .resolves.toMatchObject({ behavior: 'deny' })
    await expect(memoryCuratorPermission(memories, 'Glob', { pattern: join(root, '*.md') }))
      .resolves.toMatchObject({ behavior: 'deny' })
    await expect(memoryCuratorPermission(memories, 'Bash', { command: 'rm x' }))
      .resolves.toMatchObject({ behavior: 'deny' })
  })

  it('reconcileMemoryIndex adds missing links but never removes existing entries', async () => {
    const memories = await temp()
    await writeFile(join(memories, 'MEMORY.md'), '# Memórias\n- [Existente](existente.md) — não remover\n')
    await writeFile(join(memories, 'existente.md'), '# Existente\n')
    await writeFile(join(memories, 'nova.md'), '---\nname: nova\ndescription: regra nova\n---\n# Nova regra\n')
    await reconcileMemoryIndex(memories)
    const index = await readFile(join(memories, 'MEMORY.md'), 'utf8')
    expect(index).toContain('[Existente](existente.md) — não remover')
    expect(index.match(/\(nova\.md\)/g)).toHaveLength(1)
  })
})
