// @vitest-environment node
//
// LIVE end-to-end check of the economy mode: a REAL Agent SDK session (no query()
// mock), real model, real skills on disk, real rtk binary. Proves that with the
// toggle on the model (1) loads the caveman + rtk skills without any permission
// modal, and (2) actually prefixes its Bash command with `rtk`.
//
// Costs real tokens and needs a logged-in Claude, so it only runs on demand:
//   LIVE_AGENT=1 npx vitest run src/main/agentSession.live.test.ts
import { describe, it, expect, vi } from 'vitest'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const LIVE = process.env.LIVE_AGENT === '1'

// Real cache dir from the app's pointer file, so the real skills/memories are used.
const cacheState = vi.hoisted(() => {
  // vi.hoisted runs before the ES imports above are initialised, so use require.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  let dir = ''
  try {
    dir = JSON.parse(fs.readFileSync(path.join(home, '.agent-code', 'location.json'), 'utf8')).cacheDir
  } catch {
    dir = path.join(home, 'Documents', 'agent-code')
  }
  return { dir, memoriesDir: path.join(dir, 'memories'), skillsDir: path.join(dir, 'skills') }
})
vi.mock('./store', () => ({ getCacheInfo: () => ({ ...cacheState }) }))
vi.mock('./config', () => ({
  loadConfig: () => ({ windowsControlEnabled: false, ollama: { enabled: false, apiKey: '' } })
}))

import { AgentSession } from './agentSession'
import type { BrowserController } from './browserController'
import type { ChatEvent, PermissionRequest } from '../shared/ipc'

describe.skipIf(!LIVE)('LIVE — modo econômico usa caveman + rtk de verdade', () => {
  it(
    'carrega as duas skills sem modal e prefixa o Bash com rtk',
    async () => {
      const events: ChatEvent[] = []
      const asked: string[] = []
      let session: AgentSession | null = null

      const ask = (req: PermissionRequest): void => {
        asked.push(req.toolName)
        // Approve anything that reaches the modal (Bash etc.) so the turn runs.
        // handlePermission calls askPermission BEFORE registerPending, so a
        // synchronous answer would find no pending entry — the real renderer
        // is always async; mirror that.
        setTimeout(() => session?.resolvePermission({ id: req.id, behavior: 'allow' }), 0)
      }

      session = new AgentSession(
        {
          convId: 'live-economy',
          cwd: resolve(__dirname, '..', '..'),
          model: 'claude-haiku-4-5-20251001',
          economyMode: true
        },
        {} as BrowserController,
        (e) => {
          events.push(e)
          if (e.kind === 'tool-use' || e.kind === 'error' || e.kind === 'result' || e.kind === 'system') {
            // eslint-disable-next-line no-console
            console.log('[live:event]', e.kind, e.kind === 'tool-use' ? `${e.name} ${JSON.stringify(e.input).slice(0, 120)}` : e.kind === 'error' ? e.text : '')
          }
        },
        ask,
        () => {},
        undefined,
        undefined,
        { appRoot: resolve(__dirname, '..', '..'), userHome: homedir() }
      )

      // Capture every message handed to the SDK (the queue empties as the SDK pulls).
      const captured: string[] = []
      const inputQueue = (session as unknown as { input: { push(v: unknown): void } }).input
      const originalPush = inputQueue.push.bind(inputQueue)
      inputQueue.push = (v: unknown): void => {
        const content = (v as { message?: { content?: unknown } }).message?.content
        captured.push(typeof content === 'string' ? content : JSON.stringify(content))
        originalPush(v)
      }

      const started = await session.start()
      expect(started).toBe(true)

      // Diagnostic: what does the SDK's native skill registry actually contain?
      const q = (session as unknown as { q: { reloadSkills(): Promise<{ skills: Array<{ name: string; path?: string }> }> } }).q
      const reg = await q.reloadSkills()
      // eslint-disable-next-line no-console
      console.log('[live:registry]', JSON.stringify(reg.skills.map((s) => ({ name: s.name, path: (s as { path?: string }).path })), null, 0))

      const done = new Promise<void>((res) => {
        const check = setInterval(() => {
          if (events.some((e) => e.kind === 'result' || e.kind === 'error')) {
            clearInterval(check)
            res()
          }
        }, 200)
      })
      await session.send('Rode `git status` no projeto e me diga em UMA linha se a árvore está limpa.')
      await done
      // Diagnostic: what did the model actually receive?
      const dispatched = captured.at(-1) ?? ''
      // eslint-disable-next-line no-console
      console.log('[live:dispatched has caveman in catalog]', /\/caveman/.test(dispatched), '| has rtk:', /\/rtk\b/.test(dispatched), '| len:', dispatched.length)
      // eslint-disable-next-line no-console
      console.log('[live:dispatched tail]', dispatched.slice(-600))
      session.dispose()

      const toolUses = events.filter((e) => e.kind === 'tool-use') as Array<
        Extract<ChatEvent, { kind: 'tool-use' }>
      >
      const skills = toolUses
        .filter((t) => t.name === 'Skill')
        .map((t) => String((t.input as { skill?: string }).skill ?? ''))
      const bashCmds = toolUses
        .filter((t) => t.name === 'Bash')
        .map((t) => String((t.input as { command?: string }).command ?? ''))
      const errors = events.filter((e) => e.kind === 'error')

      // eslint-disable-next-line no-console
      console.log('[live] skills:', skills, '| bash:', bashCmds, '| asked:', asked, '| errors:', errors)

      expect(errors).toEqual([])
      expect(skills).toContain('caveman')
      expect(skills).toContain('rtk')
      // The toggle is the grant: neither skill may have gone through the modal.
      expect(asked.filter((n) => n === 'Skill')).toEqual([])
      // At least one Bash call went through the rtk proxy.
      expect(bashCmds.some((c) => /^\s*rtk\s+git\b/.test(c))).toBe(true)
    },
    240_000
  )
})
