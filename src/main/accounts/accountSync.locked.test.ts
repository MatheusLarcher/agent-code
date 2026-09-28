// @vitest-environment node
// Windows: o CLI segura o .claude.json aberto e o rename da restauração dá
// EPERM/EBUSY. A passada não pode abortar: as outras contas seguem (e a cópia
// delas é gravada), a falha é registrada e a conta é tentada na passada seguinte.
// Pasta temporária e contas FALSAS; o rename é o do node:fs com a falha simulada.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAuthStatus } from '../auth'
import { CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY, parseBackups, type CredentialCipher } from './accountBackup'
import { accountDir, isRecreatedDir, readCredentialInfo, readOauthEmail } from './accountDirs'
import { syncClaudeAccounts, type AccountSyncDeps } from './accountSync'
import { CLAUDE_ACCOUNTS_KV_KEY, createAccountRegistry, DEFAULT_ACCOUNT_ID } from './registry'

/** Caminho cujo rename falha (o arquivo "aberto pelo CLI") e o código do erro. */
const lock = vi.hoisted(() => ({ path: '', code: 'EPERM', attempts: 0 }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const renameSync: typeof actual.renameSync = (from, to) => {
    if (lock.path && resolve(String(to)) === resolve(lock.path)) {
      lock.attempts++
      const error = new Error(`${lock.code}: operation not permitted, rename '${String(from)}' -> '${String(to)}'`) as NodeJS.ErrnoException
      error.code = lock.code
      throw error
    }
    return actual.renameSync(from, to)
  }
  return { ...actual, default: { ...actual, renameSync }, renameSync }
})

const HOUR = 3_600_000
let root: string
let localDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'contas-locked-'))
  localDir = join(root, 'agent-code-local')
  const machine = join(root, 'maquina')
  mkdirSync(machine, { recursive: true })
  vi.stubEnv('CLAUDE_CONFIG_DIR', machine)
  lock.path = ''
  lock.attempts = 0
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

function writeLogin(dir: string, email: string, expiresAt: number): void {
  mkdirSync(dir, { recursive: true })
  const oauth = { accessToken: `sk-ant-oat01-FALSO-${expiresAt}`, refreshToken: 'sk-ant-ort01-FALSO', expiresAt }
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }))
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }))
}

function setup() {
  const kv = new Map<string, string>()
  const readKv = async (key: string): Promise<string | null> => kv.get(key) ?? null
  const writeKv = async (key: string, value: string): Promise<void> => void kv.set(key, value)
  const registry = createAccountRegistry({
    localDir: () => localDir,
    readKv,
    writeKv,
    authStatus: async (): Promise<ClaudeAuthStatus> => ({ loggedIn: false, authMethod: 'none' }),
    login: async () => false,
    loginBusy: () => false
  })
  const lines: string[] = []
  const deps: AccountSyncDeps = { localDir: () => localDir, readKv, writeKv, cipher, registry, log: (line) => lines.push(line) }
  kv.set(
    CLAUDE_ACCOUNTS_KV_KEY,
    JSON.stringify({
      accounts: [
        { id: DEFAULT_ACCOUNT_ID, email: 'eu@x.com' },
        { id: 'conta2', email: 'dois@x.com' },
        { id: 'conta3', email: 'tres@x.com' }
      ],
      autoSwitch: true
    })
  )
  return { kv, registry, lines, sync: () => syncClaudeAccounts(deps) }
}

describe.each(['EPERM', 'EBUSY'])('rename do .claude.json falha com %s (arquivo aberto pelo CLI)', (code) => {
  it('a passada não aborta, a cópia das outras contas é gravada, a falha é registrada e a conta volta na passada seguinte', async () => {
    const w = setup()
    const dir2 = accountDir(localDir, 'conta2')
    const dir3 = accountDir(localDir, 'conta3')
    writeLogin(dir2, 'dois@x.com', Date.now() + HOUR)
    writeLogin(dir3, 'tres@x.com', Date.now() + HOUR)
    expect((await w.sync()).backedUp.sort()).toEqual(['conta2', 'conta3'])

    // conta2: a pasta some; o app a recria (envFor) e o CLI grava o .claude.json dele
    // e o mantém aberto. conta3: o CLI renovou o token (cópia nova a gravar).
    rmSync(dir2, { recursive: true, force: true })
    await w.registry.ensureLoaded()
    w.registry.envFor('conta2')
    writeFileSync(join(dir2, '.claude.json'), JSON.stringify({ firstStartTime: '2026-09-27T05:30:00.000Z', machineID: 'f'.repeat(64) }))
    const renewed = Date.now() + 4 * HOUR
    writeLogin(dir3, 'tres@x.com', renewed)
    lock.path = join(dir2, '.claude.json')
    lock.code = code

    const first = await w.sync()
    expect(lock.attempts).toBe(1)
    expect(first.failed).toEqual(['conta2'])
    expect(first.restored).toEqual([])
    expect(first.backedUp).toEqual(['conta3'])
    expect(parseBackups(w.kv.get(CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY) ?? null)['conta3'].expiresAt).toBe(renewed)
    // A cópia da conta que falhou continua no banco; a pasta ficou como estava.
    expect(Object.keys(parseBackups(w.kv.get(CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY) ?? null)).sort()).toEqual(['conta2', 'conta3'])
    expect(existsSync(join(dir2, '.credentials.json'))).toBe(false)
    expect(isRecreatedDir(dir2)).toBe(true)
    expect(readdirSync(dir2).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(w.lines.join('\n')).toContain(`conta conta2 não conferida nesta passada`)
    expect(w.lines.join('\n')).toContain(code)

    // O CLI soltou o arquivo: a próxima passada restaura.
    lock.path = ''
    const second = await w.sync()
    expect(second.failed).toEqual([])
    expect(second.restored).toEqual(['conta2'])
    expect(readCredentialInfo(dir2).live).toBe(true)
    expect(readOauthEmail(dir2)).toBe('dois@x.com')
    expect(isRecreatedDir(dir2)).toBe(false)
  })
})
