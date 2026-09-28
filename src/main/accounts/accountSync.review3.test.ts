// @vitest-environment node
// 3ª revisão: a HISTÓRIA da pasta decide entre logout e pasta recriada (marcador
// `.agentcode-recreated`), e o relógio de nova tentativa da lista pode ser parado.
// Pasta temporária e contas FALSAS; nunca o ~/.claude de verdade, nunca o CLI.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAuthStatus } from '../auth'
import { CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY, parseBackups, type CredentialCipher } from './accountBackup'
import { accountDir, isRecreatedDir, readCredentialInfo, RECREATED_MARKER } from './accountDirs'
import { syncClaudeAccounts, type AccountSyncDeps } from './accountSync'
import { CLAUDE_ACCOUNTS_KV_KEY, createAccountRegistry, DEFAULT_ACCOUNT_ID, type RegistryDeps } from './registry'
import { createUsageReader } from './usageReader'

const HOUR = 3_600_000
let root: string
let localDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'contas-review3-'))
  localDir = join(root, 'agent-code-local')
  const machine = join(root, 'maquina')
  mkdirSync(machine, { recursive: true })
  vi.stubEnv('CLAUDE_CONFIG_DIR', machine)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

const cipher: CredentialCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(Buffer.from(plain).map((byte) => byte ^ 7)),
  decryptString: (encrypted) => Buffer.from(encrypted.map((byte) => byte ^ 7)).toString()
}

/** Login no formato do CLI: refresh token SEM refreshTokenExpiresAt (credentialLive sempre true). */
function writeLogin(dir: string, email: string, expiresAt: number): void {
  mkdirSync(dir, { recursive: true })
  const oauth = { accessToken: `sk-ant-oat01-FALSO-${expiresAt}`, refreshToken: 'sk-ant-ort01-FALSO', expiresAt }
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }))
  writeFileSync(
    join(dir, '.claude.json'),
    JSON.stringify({ numStartups: 7, userID: 'u'.repeat(64), firstStartTime: '2026-09-01T10:00:00.000Z', oauthAccount: { emailAddress: email } })
  )
}

/**
 * Fixture do `claude auth logout` do 2.1.283 (lido no binário pelo crítico): revoga
 * o refresh token, faz unlink do `.credentials.json` e tira o `oauthAccount` do
 * `.claude.json`, mantendo o resto (numStartups, userID, firstStartTime…).
 */
function cliLogout(dir: string): void {
  unlinkSync(join(dir, '.credentials.json'))
  const config = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as Record<string, unknown>
  delete config.oauthAccount
  writeFileSync(join(dir, '.claude.json'), JSON.stringify(config))
}

/** O que o CLI grava ao rodar numa pasta de config vazia (consulta de consumo). */
function cliTouchesEmptyDir(dir: string): void {
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

function world(kv: Kv = new Map(), extra: Partial<RegistryDeps> = {}) {
  const readKv = async (key: string): Promise<string | null> => kv.get(key) ?? null
  const writeKv = async (key: string, value: string): Promise<void> => void kv.set(key, value)
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
  kv.set(CLAUDE_ACCOUNTS_KV_KEY, kv.get(CLAUDE_ACCOUNTS_KV_KEY) ?? listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com'], ['conta2', 'dois@x.com']]))
  return { kv, registry, deps, sync: () => syncClaudeAccounts(deps) }
}

const backupIds = (kv: Kv): string[] => Object.keys(parseBackups(kv.get(CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY) ?? null))
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('logout × pasta recriada: decide a história da pasta, não os arquivos', () => {
  it('logout real (pasta existente, credencial apagada, oauthAccount removido): não restaura, apaga a cópia, e segue assim', async () => {
    const w = world()
    const dir = accountDir(localDir, 'conta2')
    writeLogin(dir, 'dois@x.com', Date.now() + HOUR)
    expect((await w.sync()).backedUp).toEqual(['conta2'])
    expect(isRecreatedDir(dir)).toBe(false)

    cliLogout(dir)
    const report = await w.sync()
    expect(report).toMatchObject({ restored: [], notRestored: ['conta2'], pruned: ['conta2'], recreatedDirs: [] })
    expect(backupIds(w.kv)).toEqual([])
    expect(existsSync(join(dir, '.credentials.json'))).toBe(false)
    // O resto do .claude.json do CLI ficou como estava.
    expect(JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'))).toEqual({
      numStartups: 7,
      userID: 'u'.repeat(64),
      firstStartTime: '2026-09-01T10:00:00.000Z'
    })
    for (let i = 0; i < 3; i++) expect((await w.sync()).restored).toEqual([])
    expect((await w.registry.list()).find((account) => account.id === 'conta2')?.status).toBe('logged-out')
  })

  it('pasta sumiu: o sync a recria (com marcador), restaura e tira o marcador', async () => {
    const w = world()
    const dir = accountDir(localDir, 'conta2')
    writeLogin(dir, 'dois@x.com', Date.now() + HOUR)
    await w.sync()
    rmSync(dir, { recursive: true, force: true })
    const report = await w.sync()
    expect(report).toMatchObject({ recreatedDirs: ['conta2'], restored: ['conta2'], pruned: [] })
    expect(readCredentialInfo(dir).live).toBe(true)
    expect(existsSync(join(dir, RECREATED_MARKER))).toBe(false)
    expect(backupIds(w.kv)).toEqual(['conta2'])
  })

  it('pasta recriada vazia pelo app (envFor) + a consulta de consumo grava o .claude.json: restaura; logout depois disso é logout', async () => {
    const w = world()
    const dir = accountDir(localDir, 'conta2')
    writeLogin(dir, 'dois@x.com', Date.now() + HOUR)
    await w.sync()
    rmSync(dir, { recursive: true, force: true })

    const reader = createUsageReader({
      fetchWindows: async (id) => {
        const configDir = w.registry.envFor(id)?.['CLAUDE_CONFIG_DIR']
        if (configDir) cliTouchesEmptyDir(configDir)
        throw new Error('Not logged in')
      },
      load: (id) => w.registry.loadUsage(id),
      save: (id, reading) => w.registry.saveUsage(id, reading)
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await reader.readMany(w.registry.ids(), { force: true })
    // Os arquivos são os mesmos de um logout; o marcador é o que difere.
    expect(existsSync(join(dir, '.credentials.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'))).not.toHaveProperty('oauthAccount')
    expect(isRecreatedDir(dir)).toBe(true)

    const report = await w.sync()
    expect(report).toMatchObject({ restored: ['conta2'], notRestored: [], pruned: [] })
    expect(isRecreatedDir(dir)).toBe(false)
    expect(backupIds(w.kv)).toEqual(['conta2'])

    // Agora a pasta tem história: um logout nela não é desfeito.
    cliLogout(dir)
    expect(await w.sync()).toMatchObject({ restored: [], pruned: ['conta2'] })
    expect(backupIds(w.kv)).toEqual([])
  })

  it('login novo depois do logout funciona: "Entrar de novo" grava a credencial nova e ela vai para o banco', async () => {
    const later = Date.now() + 3 * HOUR
    const w = world(new Map(), {
      login: async (dir) => {
        writeLogin(dir, 'dois@x.com', later)
        return true
      },
      authStatus: async (dir): Promise<ClaudeAuthStatus> =>
        dir ? { loggedIn: true, authMethod: 'claude.ai', email: 'dois@x.com' } : { loggedIn: true, authMethod: 'claude.ai', email: 'eu@x.com' }
    })
    const dir = accountDir(localDir, 'conta2')
    writeLogin(dir, 'dois@x.com', Date.now() + HOUR)
    await w.sync()
    cliLogout(dir)
    expect((await w.sync()).pruned).toEqual(['conta2'])

    expect(await w.registry.relogin('conta2')).toBe(true)
    const report = await w.sync()
    expect(report).toMatchObject({ restored: [], backedUp: ['conta2'] })
    expect(parseBackups(w.kv.get(CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY) ?? null)['conta2'].expiresAt).toBe(later)
    expect((await w.registry.list()).find((account) => account.id === 'conta2')?.status).toBe('connected')
  })

  it('add(): a pasta nova nasce com o marcador e o login bem-sucedido o tira', async () => {
    let seen = ''
    const w = world(new Map(), {
      login: async (dir) => {
        seen = dir
        expect(isRecreatedDir(dir)).toBe(true)
        writeLogin(dir, 'novo@x.com', Date.now() + HOUR)
        return true
      },
      authStatus: async (dir): Promise<ClaudeAuthStatus> =>
        dir ? { loggedIn: true, authMethod: 'claude.ai', email: 'novo@x.com' } : { loggedIn: true, authMethod: 'claude.ai', email: 'eu@x.com' }
    })
    w.kv.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com']]))
    expect((await w.registry.add()).ok).toBe(true)
    expect(seen).not.toBe('')
    expect(isRecreatedDir(seen)).toBe(false)
  })

  it('login observado na pasta tira um marcador que sobrou (a pasta passa a ter história)', async () => {
    const w = world()
    const dir = accountDir(localDir, 'conta2')
    writeLogin(dir, 'dois@x.com', Date.now() + HOUR)
    writeFileSync(join(dir, RECREATED_MARKER), 'sobra')
    await w.sync()
    expect(isRecreatedDir(dir)).toBe(false)
    cliLogout(dir)
    expect(await w.sync()).toMatchObject({ restored: [], pruned: ['conta2'] })
  })
})

describe('nova tentativa de gravar a lista: parada no fechamento do app', () => {
  function failingWorld(writeDelayMs = 0) {
    const kv: Kv = new Map([[CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com'], ['conta2', 'dois@x.com']])]])
    const state = { writes: 0, closed: false }
    const registry = createAccountRegistry({
      localDir: () => localDir,
      readKv: async (key) => kv.get(key) ?? null,
      writeKv: async () => {
        state.writes++
        if (writeDelayMs) await wait(writeDelayMs)
        throw new Error(state.closed ? 'persistência fechada' : 'Storage autoritativo offline.')
      },
      authStatus: async (): Promise<ClaudeAuthStatus> => ({ loggedIn: false, authMethod: 'none' }),
      login: async () => false,
      loginBusy: () => false,
      persistRetryMs: 15
    })
    return { registry, state }
  }

  it('dispose() cancela a tentativa agendada e nada mais é gravado depois', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { registry, state } = failingWorld()
    await registry.ensureLoaded()
    await registry.rename('conta2', 'Trabalho')
    await wait(60)
    expect(state.writes).toBeGreaterThanOrEqual(2) // tentou de novo enquanto aberto
    expect(registry.retryPending()).toBe(true)

    registry.dispose()
    state.closed = true
    expect(registry.retryPending()).toBe(false)
    const after = state.writes
    await wait(80)
    expect(state.writes).toBe(after)
    // Mudança depois do fechamento: não vai para a persistência fechada.
    await registry.setAutoSwitch(false)
    await wait(40)
    expect(state.writes).toBe(after)
    expect(registry.retryPending()).toBe(false)
  })

  it('gravação em voo que falha DEPOIS do dispose não agenda nova tentativa', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { registry, state } = failingWorld(20)
    await registry.ensureLoaded()
    await registry.rename('conta2', 'X') // a gravação saiu e só falha daqui a 20 ms
    expect(state.writes).toBe(1)
    registry.dispose()
    state.closed = true
    await wait(80)
    expect(registry.retryPending()).toBe(false)
    expect(state.writes).toBe(1)
  })
})
