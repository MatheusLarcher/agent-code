// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAuthStatus } from '../auth'
import { CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY, parseBackups, type CredentialCipher } from './accountBackup'
import { accountDir } from './accountDirs'
import { forgetAccountBackup, syncClaudeAccounts } from './accountSync'
import { CLAUDE_ACCOUNTS_KV_KEY, createAccountRegistry, DEFAULT_ACCOUNT_ID } from './registry'

const TOKEN = 'sk-ant-oat01-TOKEN-FALSO'
const REFRESH = 'sk-ant-ort01-REFRESH-FALSO'
const HOUR = 3_600_000

let root: string
let localDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'contas-sync-'))
  localDir = join(root, 'agent-code-local')
  // "Máquina" isolada: nunca o ~/.claude de verdade.
  const machine = join(root, 'maquina')
  mkdirSync(machine, { recursive: true })
  writeFileSync(join(machine, 'CLAUDE.md'), '# regras')
  vi.stubEnv('CLAUDE_CONFIG_DIR', machine)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

/** Cifra falsa com dono: só a "máquina" que cifrou consegue abrir (como o DPAPI). */
function cipherOf(machine: string, available = true): CredentialCipher {
  const key = machine.charCodeAt(0)
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.concat([Buffer.from(`${machine}|`), Buffer.from(plain).map((byte) => byte ^ key)]),
    decryptString: (encrypted) => {
      const text = encrypted.toString('latin1')
      if (!text.startsWith(`${machine}|`)) throw new Error('outra máquina')
      return Buffer.from(encrypted.subarray(machine.length + 1).map((byte) => byte ^ key)).toString()
    }
  }
}

function writeLogin(dir: string, email: string, expiresAt: number): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: `${TOKEN}-${expiresAt}`, refreshToken: REFRESH, expiresAt, subscriptionType: 'max' } })
  )
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }))
}

function expiresOf(dir: string): number {
  return (JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8')) as { claudeAiOauth: { expiresAt: number } }).claudeAiOauth.expiresAt
}

function listOf(ids: Array<[string, string]>): string {
  return JSON.stringify({
    accounts: ids.map(([id, email]) => ({ id, label: '', email, plan: 'max', rateLimitTier: null, usage: null })),
    autoSwitch: true
  })
}

function world(kv = new Map<string, string>(), machine = 'A', available = true) {
  const registry = createAccountRegistry({
    localDir: () => localDir,
    readKv: async (key) => kv.get(key) ?? null,
    writeKv: async (key, value) => {
      kv.set(key, value)
    },
    authStatus: async (): Promise<ClaudeAuthStatus> => ({ loggedIn: false, authMethod: 'none' }),
    login: async () => false,
    loginBusy: () => false
  })
  const deps = {
    localDir: () => localDir,
    readKv: async (key: string) => kv.get(key) ?? null,
    writeKv: async (key: string, value: string) => {
      kv.set(key, value)
    },
    cipher: cipherOf(machine, available),
    registry,
    log: () => undefined
  }
  return { kv, registry, deps, sync: () => syncClaudeAccounts(deps) }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('conferência das contas ao abrir', () => {
  it('conta do banco sem pasta: a pasta é recriada e o login volta da cópia cifrada', async () => {
    const now = Date.now()
    const first = world()
    first.kv.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com'], ['conta2', 'dois@x.com']]))
    const dir = accountDir(localDir, 'conta2')
    writeLogin(dir, 'dois@x.com', now + HOUR)
    expect((await first.sync()).backedUp).toEqual(['conta2'])

    rmSync(dir, { recursive: true, force: true }) // a pasta sumiu
    const reopened = world(first.kv)
    const report = await reopened.sync()
    expect(report.recreatedDirs).toEqual(['conta2'])
    expect(report.restored).toEqual(['conta2'])
    expect(expiresOf(dir)).toBe(now + HOUR)
    expect(readFileSync(join(dir, '.claude.json'), 'utf8')).toContain('dois@x.com')
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(true)
    expect((await reopened.registry.list()).map((account) => account.id)).toEqual([DEFAULT_ACCOUNT_ID, 'conta2'])
  })

  it('conta só na pasta entra na lista do banco (uma por e-mail, a de login mais novo)', async () => {
    const now = Date.now()
    const { kv, sync, registry } = world()
    kv.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com']]))
    writeLogin(accountDir(localDir, 'velha'), 'dois@x.com', now + HOUR)
    writeLogin(accountDir(localDir, 'nova'), 'dois@x.com', now + 2 * HOUR)
    mkdirSync(accountDir(localDir, 'semlogin'), { recursive: true })
    const report = await sync()
    expect(report.adopted).toEqual(['nova'])
    await flush()
    const stored = JSON.parse(kv.get(CLAUDE_ACCOUNTS_KV_KEY) ?? '{}') as { accounts: Array<{ id: string; email: string | null }> }
    expect(stored.accounts.map((account) => account.id)).toEqual([DEFAULT_ACCOUNT_ID, 'nova'])
    expect(stored.accounts[1].email).toBe('dois@x.com')
    expect(registry.ids()).toEqual([DEFAULT_ACCOUNT_ID, 'nova'])
    // Nada é apagado: as outras pastas continuam no disco.
    for (const id of ['velha', 'nova', 'semlogin']) expect(existsSync(accountDir(localDir, id))).toBe(true)
  })

  it('pasta e banco em dia: nada é regravado nem apagado', async () => {
    const now = Date.now()
    const { kv, sync } = world()
    kv.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com'], ['conta2', 'dois@x.com']]))
    writeLogin(accountDir(localDir, 'conta2'), 'dois@x.com', now + HOUR)
    await sync()
    const before = kv.get(CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY)
    const report = await sync()
    expect(report).toMatchObject({ adopted: [], recreatedDirs: [], restored: [], backedUp: [] })
    expect(kv.get(CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY)).toBe(before)
    expect(expiresOf(accountDir(localDir, 'conta2'))).toBe(now + HOUR)
  })

  it('login renovado na pasta vai para o banco; o banco mais velho nunca volta para a pasta', async () => {
    const now = Date.now()
    const { kv, sync } = world()
    kv.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com'], ['conta2', 'dois@x.com']]))
    const dir = accountDir(localDir, 'conta2')
    writeLogin(dir, 'dois@x.com', now + HOUR)
    await sync()
    writeLogin(dir, 'dois@x.com', now + 5 * HOUR) // o CLI renovou o token
    const report = await sync()
    expect(report.backedUp).toEqual(['conta2'])
    expect(report.restored).toEqual([])
    expect(parseBackups(kv.get(CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY) ?? null)['conta2'].expiresAt).toBe(now + 5 * HOUR)
    expect(expiresOf(dir)).toBe(now + 5 * HOUR)
  })

  it('segredo nunca em texto puro no banco; sem cifra do sistema, nada de credencial é gravado', async () => {
    const now = Date.now()
    const plain = world(new Map(), 'A', false)
    plain.kv.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com'], ['conta2', 'dois@x.com']]))
    writeLogin(accountDir(localDir, 'conta2'), 'dois@x.com', now + HOUR)
    await plain.sync()
    expect(plain.kv.has(CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY)).toBe(false)

    const secure = world(plain.kv)
    await secure.sync()
    const everything = [...secure.kv.values()].join('\n')
    expect(everything).not.toContain('sk-ant-')
    expect(everything).not.toContain('accessToken')
    expect(everything).not.toContain('refreshToken')
  })

  it('remover a conta tira a cópia dela do banco', async () => {
    const now = Date.now()
    const { kv, deps, sync } = world()
    kv.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com'], ['conta2', 'dois@x.com']]))
    writeLogin(accountDir(localDir, 'conta2'), 'dois@x.com', now + HOUR)
    await sync()
    await forgetAccountBackup(deps, 'conta2')
    expect(parseBackups(kv.get(CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY) ?? null)).toEqual({})
  })

  it('banco ainda offline: a conferência não faz nada (não adota nem grava)', async () => {
    const kv = new Map<string, string>()
    const registry = createAccountRegistry({
      localDir: () => localDir,
      readKv: async () => {
        throw new Error('Storage autoritativo offline.')
      },
      writeKv: async () => {
        throw new Error('Storage autoritativo offline.')
      },
      authStatus: async (): Promise<ClaudeAuthStatus> => ({ loggedIn: false, authMethod: 'none' }),
      login: async () => false,
      loginBusy: () => false
    })
    writeLogin(accountDir(localDir, 'orfa'), 'dois@x.com', Date.now() + HOUR)
    const report = await syncClaudeAccounts({
      localDir: () => localDir,
      readKv: async (key) => kv.get(key) ?? null,
      writeKv: async (key, value) => void kv.set(key, value),
      cipher: cipherOf('A'),
      registry,
      log: () => undefined
    })
    expect(report.skipped).toBe(true)
    expect(kv.size).toBe(0)
  })
})

describe('dois dispositivos no mesmo PostgreSQL (regra: vence o expiresAt maior)', () => {
  it('cópia mais nova de outra máquina não é trocada por uma mais velha, nem aberta aqui', async () => {
    const now = Date.now()
    // Mesmo KV para os dois — o pior caso; no app a chave ainda é por instalação.
    const shared = new Map<string, string>()
    shared.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com'], ['conta2', 'dois@x.com']]))
    const dir = accountDir(localDir, 'conta2')

    writeLogin(dir, 'dois@x.com', now + 5 * HOUR) // máquina A, login mais novo
    await world(shared, 'A').sync()
    const fromA = shared.get(CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY)

    writeLogin(dir, 'dois@x.com', now + HOUR) // máquina B, login mais velho
    const report = await world(shared, 'B').sync()
    expect(report.backedUp).toEqual([])
    expect(report.restored).toEqual([])
    expect(report.unreadable).toEqual(['conta2'])
    expect(shared.get(CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY)).toBe(fromA)
    expect(expiresOf(dir)).toBe(now + HOUR) // a pasta de B não foi mexida
  })

  it('máquina com login mais novo atualiza; a mais velha depois não desfaz', async () => {
    const now = Date.now()
    const shared = new Map<string, string>()
    shared.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com'], ['conta2', 'dois@x.com']]))
    const dir = accountDir(localDir, 'conta2')
    writeLogin(dir, 'dois@x.com', now + HOUR)
    await world(shared, 'A').sync()
    writeLogin(dir, 'dois@x.com', now + 3 * HOUR)
    expect((await world(shared, 'B').sync()).backedUp).toEqual(['conta2'])
    writeLogin(dir, 'dois@x.com', now + 2 * HOUR)
    expect((await world(shared, 'A').sync()).backedUp).toEqual([])
    expect(parseBackups(shared.get(CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY) ?? null)['conta2'].expiresAt).toBe(now + 3 * HOUR)
  })
})
