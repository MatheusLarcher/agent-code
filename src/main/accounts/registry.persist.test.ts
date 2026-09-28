// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAuthStatus } from '../auth'
import { CLAUDE_ACCOUNTS_KV_KEY, createAccountRegistry, DEFAULT_ACCOUNT_ID } from './registry'

/**
 * A 2ª conta da lista sumia. Reprodução do caminho real do boot: a janela sobe
 * ANTES do banco (index.ts: `configureKvRepositoryOffline()` → `createWindow`
 * → só depois `storageLifecycle.initialize`), o renderer já pede a lista de
 * contas, a leitura do KV lança "Storage autoritativo offline." e o registro
 * guardava para sempre a lista SÓ com a conta padrão. A primeira gravação
 * seguinte (leitura de consumo, e-mail, interruptor) sobrescrevia o banco.
 */

let root: string
let machine: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'contas-persist-'))
  machine = join(root, 'maquina')
  mkdirSync(machine, { recursive: true })
  writeFileSync(
    join(machine, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 } })
  )
  vi.stubEnv('CLAUDE_CONFIG_DIR', machine)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

const SAVED = JSON.stringify({
  accounts: [
    { id: DEFAULT_ACCOUNT_ID, label: '', email: 'eu@exemplo.com', plan: 'max', rateLimitTier: null, usage: null },
    { id: 'conta2abc', label: 'Trabalho', email: 'dois@exemplo.com', plan: 'max', rateLimitTier: null, usage: null }
  ],
  autoSwitch: false
})

function bootingRegistry() {
  const kv = new Map<string, string>([[CLAUDE_ACCOUNTS_KV_KEY, SAVED]])
  const state = { online: false }
  const registry = createAccountRegistry({
    localDir: () => join(root, 'agent-code-local'),
    readKv: async (key) => {
      if (!state.online) throw new Error('Storage autoritativo offline.')
      return kv.get(key) ?? null
    },
    writeKv: async (key, value) => {
      if (!state.online) throw new Error('Storage autoritativo offline.')
      kv.set(key, value)
    },
    authStatus: async (): Promise<ClaudeAuthStatus> => ({ loggedIn: true, authMethod: 'claude.ai', email: 'eu@exemplo.com' }),
    login: async () => false,
    loginBusy: () => false
  })
  return { registry, kv, state }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('lista de contas com o banco ainda subindo', () => {
  it('uma leitura com o banco offline não apaga a 2ª conta do banco', async () => {
    const { registry, kv, state } = bootingRegistry()
    // A janela pede a lista antes do banco existir.
    await registry.list()
    state.online = true
    // Qualquer gravação depois (aqui, a leitura de consumo da conta padrão).
    registry.saveUsage(DEFAULT_ACCOUNT_ID, { at: Date.now(), windows: {} })
    await flush()
    const stored = JSON.parse(kv.get(CLAUDE_ACCOUNTS_KV_KEY) ?? '{}') as { accounts: Array<{ id: string }>; autoSwitch: boolean }
    expect(stored.accounts.map((account) => account.id)).toEqual([DEFAULT_ACCOUNT_ID, 'conta2abc'])
    expect(stored.autoSwitch).toBe(false)
  })

  it('fechar/abrir, trocar a ordem, a conta ativa e o banco cair no meio não perdem conta', async () => {
    const { registry, kv, state } = bootingRegistry()
    state.online = true
    await registry.reorder(['conta2abc', DEFAULT_ACCOUNT_ID])
    // Troca de conta: grava a leitura de consumo da conta que estourou.
    registry.saveUsage('conta2abc', { at: Date.now(), windows: { five_hour: { utilization: 100, resetsAt: null } } })
    // O banco cai (reconexão) e volta: a gravação falha, a lista em memória fica.
    state.online = false
    await registry.rename(DEFAULT_ACCOUNT_ID, 'Pessoal')
    state.online = true
    registry.saveUsage(DEFAULT_ACCOUNT_ID, { at: Date.now(), windows: {} })
    await flush()
    // Fecha e abre: uma instância nova lê o mesmo banco.
    const reopened = createAccountRegistry({
      localDir: () => join(root, 'agent-code-local'),
      readKv: async (key) => kv.get(key) ?? null,
      writeKv: async (key, value) => void kv.set(key, value),
      authStatus: async (): Promise<ClaudeAuthStatus> => ({ loggedIn: true, authMethod: 'claude.ai', email: 'eu@exemplo.com' }),
      login: async () => false,
      loginBusy: () => false
    })
    const list = await reopened.list()
    expect(list.map((account) => account.id)).toEqual(['conta2abc', DEFAULT_ACCOUNT_ID])
    expect(list[1].label).toBe('Pessoal')
    expect(reopened.loadUsage('conta2abc')?.windows['five_hour']?.utilization).toBe(100)
  })

  it('um registro inválido não derruba a lista inteira', async () => {
    const kv = new Map<string, string>([
      [
        CLAUDE_ACCOUNTS_KV_KEY,
        JSON.stringify({
          accounts: [
            { id: DEFAULT_ACCOUNT_ID, email: 'eu@exemplo.com' },
            { id: 'conta2abc', email: 'dois@exemplo.com' },
            { id: '../fora', email: 'x@exemplo.com' }
          ],
          autoSwitch: true
        })
      ]
    ])
    const registry = createAccountRegistry({
      localDir: () => join(root, 'agent-code-local'),
      readKv: async (key) => kv.get(key) ?? null,
      writeKv: async (key, value) => void kv.set(key, value),
      authStatus: async (): Promise<ClaudeAuthStatus> => ({ loggedIn: true, authMethod: 'claude.ai', email: 'eu@exemplo.com' }),
      login: async () => false,
      loginBusy: () => false
    })
    await registry.ensureLoaded()
    expect(registry.ids()).toEqual([DEFAULT_ACCOUNT_ID, 'conta2abc'])
  })

  it('depois que o banco volta, a lista lida é a do banco (2 contas, na ordem)', async () => {
    const { registry, state } = bootingRegistry()
    await registry.list()
    state.online = true
    const list = await registry.list()
    expect(list.map((account) => account.id)).toEqual([DEFAULT_ACCOUNT_ID, 'conta2abc'])
    expect(registry.autoSwitchEnabled()).toBe(false)
  })
})
