// @vitest-environment node
// 2ª revisão das sobras de contas: falso logout numa pasta recriada, remoção com
// o banco fora e conta pessoal + equipe no mesmo e-mail. Pasta temporária e
// contas FALSAS; nunca o ~/.claude de verdade, nunca o CLI.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAuthStatus } from '../auth'
import { CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY, parseBackups, type CredentialCipher } from './accountBackup'
import { accountDir, prepareAccountDir, readCredentialInfo, readOauthEmail } from './accountDirs'
import { syncClaudeAccounts, type AccountSyncDeps } from './accountSync'
import { CLAUDE_ACCOUNTS_KV_KEY, createAccountRegistry, DEFAULT_ACCOUNT_ID, type RegistryDeps } from './registry'
import { readRemovedIds, sameAccount } from './registryStore'
import { createUsageReader } from './usageReader'

const HOUR = 3_600_000
let root: string
let localDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'contas-review2-'))
  localDir = join(root, 'agent-code-local')
  const machine = join(root, 'maquina')
  mkdirSync(machine, { recursive: true })
  vi.stubEnv('CLAUDE_CONFIG_DIR', machine)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

const cipher: CredentialCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(Buffer.from(plain).map((byte) => byte ^ 7)),
  decryptString: (encrypted) => Buffer.from(encrypted.map((byte) => byte ^ 7)).toString()
}

function writeLogin(dir: string, email: string, expiresAt: number, org?: string): void {
  mkdirSync(dir, { recursive: true })
  const oauth = { accessToken: `sk-ant-oat01-FALSO-${expiresAt}`, refreshToken: 'sk-ant-ort01-FALSO', expiresAt }
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }))
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email, ...(org ? { organizationUuid: org } : {}) } }))
}

/**
 * O que o claude.exe 2.1.283 grava ao rodar numa pasta de config VAZIA (sem
 * login): um `.claude.json` sem `oauthAccount` e nenhum `.credentials.json`.
 * Chaves conforme a conferência ao vivo do crítico (auth status --json, env isolado).
 */
function cliTouchesEmptyDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, '.claude.json'),
    JSON.stringify({ firstStartTime: '2026-09-27T05:30:00.000Z', migrationVersion: 11, machineID: 'f'.repeat(64) })
  )
}

function listOf(ids: Array<[string, string | null]>): string {
  return JSON.stringify({
    accounts: ids.map(([id, email]) => ({ id, label: '', email, plan: 'max', rateLimitTier: null, usage: null })),
    autoSwitch: true
  })
}

type Kv = Map<string, string>

function world(kv: Kv = new Map(), extra: Partial<RegistryDeps> = {}, state = { online: true }) {
  const readKv = async (key: string): Promise<string | null> => {
    if (!state.online) throw new Error('Storage autoritativo offline.')
    return kv.get(key) ?? null
  }
  const writeKv = async (key: string, value: string): Promise<void> => {
    if (!state.online) throw new Error('Storage autoritativo offline.')
    kv.set(key, value)
  }
  const registry = createAccountRegistry({
    localDir: () => localDir,
    readKv,
    writeKv,
    authStatus: async (): Promise<ClaudeAuthStatus> => ({ loggedIn: false, authMethod: 'none' }),
    login: async () => false,
    loginBusy: () => false,
    ...extra
  })
  const deps: AccountSyncDeps = { localDir: () => localDir, readKv, writeKv, cipher, registry, log: () => undefined }
  return { kv, state, registry, deps, sync: () => syncClaudeAccounts(deps) }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const backupIds = (kv: Kv): string[] => Object.keys(parseBackups(kv.get(CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY) ?? null))
const storedIds = (kv: Kv): string[] =>
  (JSON.parse(kv.get(CLAUDE_ACCOUNTS_KV_KEY) ?? '{"accounts":[]}') as { accounts: Array<{ id: string }> }).accounts.map((a) => a.id)

describe('falso logout: pasta recriada em que o CLI só gravou um .claude.json sem conta', () => {
  it('pasta some → recriada vazia → a consulta de consumo cria o .claude.json → o sync RESTAURA e a cópia fica no banco', async () => {
    const w = world()
    w.kv.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com'], ['conta2', 'dois@x.com']]))
    const dir = accountDir(localDir, 'conta2')
    writeLogin(dir, 'dois@x.com', Date.now() + HOUR)
    expect((await w.sync()).backedUp).toEqual(['conta2'])

    // 1. A pasta some.
    rmSync(dir, { recursive: true, force: true })
    // 2 e 3. A consulta de consumo de TODAS as contas (queryAllAccountsUsage) roda o
    // CLI com envFor(id): envFor recria a pasta vazia e o CLI grava o .claude.json.
    const reader = createUsageReader({
      fetchWindows: async (id) => {
        const configDir = w.registry.envFor(id)?.['CLAUDE_CONFIG_DIR']
        if (configDir) cliTouchesEmptyDir(configDir)
        throw new Error('Not logged in')
      },
      load: (id) => w.registry.loadUsage(id),
      save: (id, reading) => w.registry.saveUsage(id, reading)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await reader.readMany(w.registry.ids(), { force: true })
    warn.mockRestore()
    expect(existsSync(join(dir, '.credentials.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'))).not.toHaveProperty('oauthAccount')

    // 4. O sync restaura em vez de apagar.
    const report = await w.sync()
    expect(report.restored).toEqual(['conta2'])
    expect(report.notRestored).toEqual([])
    expect(report.pruned).toEqual([])
    expect(backupIds(w.kv)).toEqual(['conta2'])
    expect(readCredentialInfo(dir).live).toBe(true)
    // O .claude.json do CLI fica, com a identidade da conta de volta.
    const config = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as Record<string, unknown>
    expect(config.machineID).toBe('f'.repeat(64))
    expect(readOauthEmail(dir)).toBe('dois@x.com')
    // A passada seguinte não mexe em nada.
    const again = await w.sync()
    expect([again.restored, again.pruned, again.notRestored]).toEqual([[], [], []])
    expect((await w.registry.list()).find((account) => account.id === 'conta2')?.status).toBe('connected')
  })

  it('pasta recriada vazia pelo app (prepareAccountDir, sem nenhum arquivo de login): restaura', async () => {
    const w = world()
    w.kv.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com'], ['conta2', 'dois@x.com']]))
    const dir = accountDir(localDir, 'conta2')
    writeLogin(dir, 'dois@x.com', Date.now() + HOUR)
    await w.sync()
    rmSync(dir, { recursive: true, force: true })
    prepareAccountDir(dir)
    expect((await w.sync()).restored).toEqual(['conta2'])
    expect(backupIds(w.kv)).toEqual(['conta2'])
  })
})

describe('remoção com o banco fora', () => {
  function setup() {
    const state = { online: true }
    const kv: Kv = new Map()
    const w = world(kv, { persistRetryMs: 20 }, state)
    kv.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com'], ['conta2', 'dois@x.com'], ['conta3', 'tres@x.com']]))
    writeLogin(accountDir(localDir, 'conta2'), 'dois@x.com', Date.now() + HOUR)
    writeLogin(accountDir(localDir, 'conta3'), 'tres@x.com', Date.now() + HOUR)
    return { ...w, state, kv }
  }

  it('app fechado antes de o banco voltar: ao reabrir a conta não volta da lista do banco nem é restaurada', async () => {
    const w = setup()
    await w.sync()
    expect(backupIds(w.kv).sort()).toEqual(['conta2', 'conta3'])
    w.state.online = false
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await w.registry.remove('conta2')).toBe(true)
    await flush()
    warn.mockRestore()
    // O banco ainda tem a conta e a cópia; a pasta foi apagada.
    expect(storedIds(w.kv)).toContain('conta2')
    expect(backupIds(w.kv).sort()).toEqual(['conta2', 'conta3'])
    expect(existsSync(accountDir(localDir, 'conta2'))).toBe(false)
    expect([...readRemovedIds(localDir)]).toEqual(['conta2'])

    // Fecha e abre com o banco de volta (registry novo sobre o mesmo banco e disco).
    const reopened = world(w.kv)
    await reopened.registry.ensureLoaded()
    await flush()
    expect(reopened.registry.ids()).toEqual([DEFAULT_ACCOUNT_ID, 'conta3'])
    const report = await reopened.sync()
    expect(report.restored).toEqual([])
    expect(report.recreatedDirs).toEqual([])
    expect(report.adopted).toEqual([])
    expect(report.pruned).toEqual(['conta2'])
    expect(existsSync(accountDir(localDir, 'conta2'))).toBe(false)
    // A remoção pendente foi gravada no banco na leitura.
    expect(storedIds(w.kv)).toEqual([DEFAULT_ACCOUNT_ID, 'conta3'])
    expect(backupIds(w.kv)).toEqual(['conta3'])
  })

  it('banco volta com o app aberto: a nova tentativa grava a remoção sozinha', async () => {
    const w = setup()
    await w.registry.ensureLoaded()
    w.state.online = false
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await w.registry.remove('conta2')
    await wait(50) // tentativas falham enquanto o banco está fora
    expect(storedIds(w.kv)).toContain('conta2')
    w.state.online = true
    for (let i = 0; i < 20 && storedIds(w.kv).includes('conta2'); i++) await wait(20)
    warn.mockRestore()
    expect(storedIds(w.kv)).toEqual([DEFAULT_ACCOUNT_ID, 'conta3'])
  })

  it('pasta da removida que sobrou no disco (rm falhou) não é adotada de volta', async () => {
    const w = setup()
    await w.registry.ensureLoaded()
    await w.registry.remove('conta2')
    writeLogin(accountDir(localDir, 'conta2'), 'dois@x.com', Date.now() + HOUR) // sobra
    expect((await w.sync()).adopted).toEqual([])
    expect(w.registry.ids()).toEqual([DEFAULT_ACCOUNT_ID, 'conta3'])
  })
})

describe('mesma pessoa, conta pessoal e de equipe no mesmo e-mail', () => {
  const PESSOAL = 'org-pessoal-1111'
  const EQUIPE = 'org-equipe-2222'

  function addWorld(org: string, kvList: string) {
    const w = world(new Map(), {
      login: async (dir) => {
        writeLogin(dir, 'eu@x.com', Date.now() + HOUR, org)
        return true
      },
      authStatus: async (): Promise<ClaudeAuthStatus> => ({ loggedIn: true, authMethod: 'claude.ai', email: 'eu@x.com' })
    })
    w.kv.set(CLAUDE_ACCOUNTS_KV_KEY, kvList)
    // A conta da máquina é a pessoal (organização no ~/.claude.json de teste).
    writeFileSync(join(root, 'maquina', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'eu@x.com', organizationUuid: PESSOAL } }))
    return w
  }

  it('add da conta de equipe com o mesmo e-mail da pessoal: entra como segunda conta', async () => {
    const w = addWorld(EQUIPE, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com']]))
    const result = await w.registry.add()
    expect(result.ok).toBe(true)
    expect(w.registry.ids()).toHaveLength(2)
    const stored = JSON.parse(w.kv.get(CLAUDE_ACCOUNTS_KV_KEY) ?? '{}') as { accounts: Array<{ email: string; org: string | null }> }
    expect(stored.accounts[1]).toMatchObject({ email: 'eu@x.com', org: EQUIPE })
  })

  it('add da MESMA organização (a pessoal de novo) continua recusado como duplicata', async () => {
    const w = addWorld(PESSOAL, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com']]))
    expect(await w.registry.add()).toEqual({ ok: false, reason: 'duplicate', email: 'eu@x.com' })
    expect(w.registry.ids()).toEqual([DEFAULT_ACCOUNT_ID])
  })

  it('órfã de equipe com o e-mail da pessoal é adotada; órfã da mesma organização não', async () => {
    const w = addWorld(EQUIPE, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com']]))
    writeLogin(accountDir(localDir, 'equipe'), 'eu@x.com', Date.now() + HOUR, EQUIPE)
    writeLogin(accountDir(localDir, 'copiaPessoal'), 'EU@x.com', Date.now() + 2 * HOUR, PESSOAL)
    const report = await w.sync()
    expect(report.adopted).toEqual(['equipe'])
    expect(w.registry.ids()).toEqual([DEFAULT_ACCOUNT_ID, 'equipe'])
  })

  it('regra: mesmo e-mail e organizações diferentes = duas contas; organização desconhecida num lado = a mesma', () => {
    expect(sameAccount({ email: 'eu@x.com', org: PESSOAL }, { email: 'EU@x.com', org: EQUIPE })).toBe(false)
    expect(sameAccount({ email: 'eu@x.com', org: PESSOAL }, { email: 'eu@x.com', org: PESSOAL })).toBe(true)
    expect(sameAccount({ email: 'eu@x.com', org: null }, { email: 'eu@x.com', org: EQUIPE })).toBe(true)
    expect(sameAccount({ email: 'eu@x.com', org: PESSOAL }, { email: 'outro@x.com', org: PESSOAL })).toBe(false)
  })
})
