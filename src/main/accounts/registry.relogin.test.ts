// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAccountRegistry } from './registry'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relogin-default-'))
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'machine'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

it('renova a conta padrão na pasta herdada e relê o status em cache', async () => {
  let loggedIn = false
  const machine = join(root, 'machine')
  const registry = createAccountRegistry({
    localDir: () => root,
    readKv: async () => null,
    writeKv: async () => undefined,
    authStatus: async () => ({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none', email: 'eu@example.com' }),
    login: async (dir) => {
      // A conta padrão deve herdar o ambiente, sem mudar onde .claude.json fica.
      if (dir !== undefined) return false
      mkdirSync(machine)
      writeFileSync(join(machine, '.credentials.json'), JSON.stringify({
        claudeAiOauth: { accessToken: 'test-only', expiresAt: Date.now() + 3600_000 }
      }))
      loggedIn = true
      return true
    },
    loginBusy: () => false
  })
  expect((await registry.list())[0].status).toBe('logged-out')
  expect(await registry.relogin('default')).toBe(true)
  expect((await registry.list())[0]).toMatchObject({ status: 'connected', email: 'eu@example.com' })
  registry.dispose()
})
