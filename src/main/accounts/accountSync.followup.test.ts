// @vitest-environment node
// Sobras da revisão da bc59b2fb: login limpo pelo CLI, ajustes com o banco fora,
// add() em andamento, cópia de conta removida, duplicatas e Linux sem chaveiro.
// Tudo em pasta temporária, com contas FALSAS; nunca o ~/.claude de verdade.
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAuthStatus } from '../auth'
import { CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY, hasRealEncryption, parseBackups, type CredentialCipher } from './accountBackup'
import { accountDir, readCredentialInfo } from './accountDirs'
import { forgetAccountBackup, syncClaudeAccounts, type AccountSyncDeps } from './accountSync'
import { CLAUDE_ACCOUNTS_KV_KEY, createAccountRegistry, DEFAULT_ACCOUNT_ID, type RegistryDeps } from './registry'

const HOUR = 3_600_000
let root: string
let localDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'contas-followup-'))
  localDir = join(root, 'agent-code-local')
  const machine = join(root, 'maquina')
  mkdirSync(machine, { recursive: true })
  vi.stubEnv('CLAUDE_CONFIG_DIR', machine)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

/** Cifra falsa (XOR) com `backend` simulado, como o safeStorage no Linux. */
function cipher(backend?: string): CredentialCipher {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(Buffer.from(plain).map((byte) => byte ^ 7)),
    decryptString: (encrypted) => Buffer.from(encrypted.map((byte) => byte ^ 7)).toString(),
    ...(backend ? { storageBackend: () => backend } : {})
  }
}

function writeLogin(dir: string, email: string | null, expiresAt: number, refreshTokenExpiresAt?: number): void {
  mkdirSync(dir, { recursive: true })
  const oauth = { accessToken: `sk-ant-oat01-FALSO-${expiresAt}`, refreshToken: 'sk-ant-ort01-FALSO', expiresAt, refreshTokenExpiresAt }
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }))
  writeFileSync(join(dir, '.claude.json'), JSON.stringify(email ? { oauthAccount: { emailAddress: email } } : { numStartups: 3 }))
}

function listOf(ids: Array<[string, string | null]>, autoSwitch = true): string {
  return JSON.stringify({
    accounts: ids.map(([id, email]) => ({ id, label: '', email, plan: 'max', rateLimitTier: null, usage: null })),
    autoSwitch
  })
}

type Kv = Map<string, string>

function world(kv: Kv = new Map(), extra: Partial<RegistryDeps> = {}, state = { online: true }, cipherImpl = cipher()) {
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
  const deps: AccountSyncDeps = { localDir: () => localDir, readKv, writeKv, cipher: cipherImpl, registry, log: () => undefined }
  return { kv, state, registry, deps, sync: () => syncClaudeAccounts(deps) }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const backupIds = (kv: Kv): string[] => Object.keys(parseBackups(kv.get(CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY) ?? null))

describe('login que o CLI tirou da pasta não volta do banco', () => {
  function withBackup() {
    const w = world()
    w.kv.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com'], ['conta2', 'dois@x.com']]))
    const dir = accountDir(localDir, 'conta2')
    writeLogin(dir, 'dois@x.com', Date.now() + HOUR)
    return { ...w, dir }
  }

  it('logout com coworkRemoteDevice (arquivo regravado sem claudeAiOauth): não restaura, nem nas passadas seguintes; a cópia revogada sai do banco', async () => {
    const w = withBackup()
    expect((await w.sync()).backedUp).toEqual(['conta2'])
    // O CLI revogou o refresh token e regravou o arquivo só com o coworkRemoteDevice.
    writeFileSync(join(w.dir, '.credentials.json'), JSON.stringify({ coworkRemoteDevice: { id: 'x' } }))
    writeFileSync(join(w.dir, '.claude.json'), JSON.stringify({ numStartups: 3 }))
    const first = await w.sync()
    expect(first.restored).toEqual([])
    expect(first.notRestored).toEqual(['conta2'])
    // A cópia ainda parece válida pelo prazo, mas o refresh token foi revogado: sai.
    expect(first.pruned).toEqual(['conta2'])
    expect(backupIds(w.kv)).toEqual([])
    expect(readCredentialInfo(w.dir).present).toBe(false)
    // "a cada 10 min": continua deslogada.
    expect((await w.sync()).restored).toEqual([])
    expect((await w.registry.list()).find((account) => account.id === 'conta2')?.status).toBe('logged-out')
  })

  it('logout com a cópia vencida (token e refresh expirados): a cópia sai do banco', async () => {
    const w = world()
    w.kv.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com'], ['conta2', 'dois@x.com']]))
    const dir = accountDir(localDir, 'conta2')
    writeLogin(dir, 'dois@x.com', Date.now() - 2 * HOUR, Date.now() - HOUR)
    expect((await w.sync()).backedUp).toEqual(['conta2'])
    writeFileSync(join(dir, '.credentials.json'), '{}')
    const report = await w.sync()
    expect(report.restored).toEqual([])
    expect(report.pruned).toEqual(['conta2'])
    expect(backupIds(w.kv)).toEqual([])
  })

  it('logout real do CLI 2.1.283 (unlink do .credentials.json, .claude.json sem oauthAccount e o resto mantido): NÃO restaura e a cópia sai do banco', async () => {
    const w = withBackup()
    await w.sync()
    // `claude auth logout`: revoga o refresh token, apaga o .credentials.json e tira
    // só o oauthAccount do .claude.json. A cópia no banco tem o formato do CLI (sem
    // refreshTokenExpiresAt): por credentialLive ela "vale" para sempre.
    unlinkSync(join(w.dir, '.credentials.json'))
    writeFileSync(join(w.dir, '.claude.json'), JSON.stringify({ numStartups: 3 }))
    const report = await w.sync()
    expect(report.restored).toEqual([])
    expect(report.notRestored).toEqual(['conta2'])
    expect(report.pruned).toEqual(['conta2'])
    expect(backupIds(w.kv)).toEqual([])
    expect(existsSync(join(w.dir, '.credentials.json'))).toBe(false)
    expect((await w.sync()).restored).toEqual([])
    expect((await w.registry.list()).find((account) => account.id === 'conta2')?.status).toBe('logged-out')
  })

  it('pasta que continuou e perdeu só o .credentials.json (a conta ainda no .claude.json) também conta como logout', async () => {
    const w = withBackup()
    await w.sync()
    unlinkSync(join(w.dir, '.credentials.json'))
    const report = await w.sync()
    expect(report.restored).toEqual([])
    expect(report.pruned).toEqual(['conta2'])
    expect(readCredentialInfo(w.dir).present).toBe(false)
  })

  it('pasta recriada vazia pelo app (envFor antes do sync): restaura', async () => {
    const w = withBackup()
    await w.sync()
    rmSync(w.dir, { recursive: true, force: true })
    await w.registry.ensureLoaded()
    w.registry.envFor('conta2') // recria a pasta sem login, como ao abrir uma conversa
    expect(existsSync(w.dir)).toBe(true)
    expect((await w.sync()).restored).toEqual(['conta2'])
  })

  it('cópia vencida (token e refresh expirados) não é restaurada numa pasta que sumiu', async () => {
    const w = world()
    w.kv.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com'], ['conta2', 'dois@x.com']]))
    const dir = accountDir(localDir, 'conta2')
    writeLogin(dir, 'dois@x.com', Date.now() - 2 * HOUR, Date.now() - HOUR)
    await w.sync()
    rmSync(dir, { recursive: true, force: true })
    const report = await w.sync()
    expect(report.restored).toEqual([])
    expect(report.notRestored).toEqual(['conta2'])
    expect(existsSync(join(dir, '.credentials.json'))).toBe(false)
  })
})

describe('ajustes feitos antes de a lista ser lida do banco', () => {
  it('desligar a troca automática com o banco fora: fica pendente e vence o valor antigo quando o banco é lido', async () => {
    const w = world(new Map(), {}, { online: false })
    w.kv.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com'], ['conta2', 'dois@x.com']], true))
    expect(await w.registry.setAutoSwitch(false)).toBe(false)
    expect(w.registry.autoSwitchEnabled()).toBe(false)
    w.state.online = true
    await w.registry.ensureLoaded()
    await flush()
    expect(w.registry.autoSwitchEnabled()).toBe(false)
    expect(w.registry.ids()).toEqual([DEFAULT_ACCOUNT_ID, 'conta2'])
    expect((JSON.parse(w.kv.get(CLAUDE_ACCOUNTS_KV_KEY) ?? '{}') as { autoSwitch: boolean }).autoSwitch).toBe(false)
    // Fecha e abre: o banco guardou o interruptor desligado.
    const reopened = world(w.kv)
    await reopened.registry.ensureLoaded()
    expect(reopened.registry.autoSwitchEnabled()).toBe(false)
  })

  it('apelido e ordem com o banco fora também valem depois da leitura', async () => {
    const w = world(new Map(), {}, { online: false })
    w.kv.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com'], ['conta2', 'dois@x.com']]))
    expect(await w.registry.rename(DEFAULT_ACCOUNT_ID, 'Pessoal')).toBe(true)
    await w.registry.reorder(['conta2', DEFAULT_ACCOUNT_ID])
    w.state.online = true
    await w.registry.ensureLoaded()
    await flush()
    expect(w.registry.ids()).toEqual(['conta2', DEFAULT_ACCOUNT_ID])
    expect(w.registry.labelOf(DEFAULT_ACCOUNT_ID)).toBe('Pessoal')
    const stored = JSON.parse(w.kv.get(CLAUDE_ACCOUNTS_KV_KEY) ?? '{}') as { accounts: Array<{ id: string; label: string }> }
    expect(stored.accounts.map((account) => [account.id, account.label])).toEqual([['conta2', ''], [DEFAULT_ACCOUNT_ID, 'Pessoal']])
  })
})

describe('sync × add() em andamento', () => {
  it('a pasta de um login em andamento não é adotada; o add termina sem duplicar nem apagar', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let loginDir = ''
    const w = world(new Map(), {
      login: async (dir) => {
        loginDir = dir
        writeLogin(dir, 'novo@x.com', Date.now() + HOUR) // o CLI já gravou o login…
        await gate // …mas o add() ainda não pôs a conta na lista
        return true
      },
      authStatus: async (dir): Promise<ClaudeAuthStatus> =>
        dir ? { loggedIn: true, authMethod: 'claude.ai', email: 'novo@x.com' } : { loggedIn: true, authMethod: 'claude.ai', email: 'eu@x.com' }
    })
    w.kv.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com']]))
    const adding = w.registry.add()
    for (let i = 0; i < 20 && !loginDir; i++) await flush()
    const id = loginDir.split(/[\\/]/).pop() ?? ''
    expect(w.registry.busy(id)).toBe(true)
    const report = await w.sync()
    expect(report.adopted).toEqual([])
    expect(w.registry.ids()).toEqual([DEFAULT_ACCOUNT_ID])
    release()
    const result = await adding
    expect(result).toMatchObject({ ok: true, account: { id, email: 'novo@x.com' } })
    expect(w.registry.ids()).toEqual([DEFAULT_ACCOUNT_ID, id])
    expect(existsSync(loginDir)).toBe(true)
    expect(w.registry.busy(id)).toBe(false)
  })
})

describe('cópia de conta removida sai do banco', () => {
  it('removida com o banco fora: a passada seguinte poda a cópia (o id não está mais na lista)', async () => {
    const state = { online: true }
    const kv: Kv = new Map()
    let syncDeps: AccountSyncDeps | null = null
    const w = world(kv, {
      onRemove: (id) => {
        if (syncDeps) void forgetAccountBackup(syncDeps, id).catch(() => undefined)
      }
    }, state)
    syncDeps = w.deps
    kv.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com'], ['conta2', 'dois@x.com'], ['conta3', 'tres@x.com']]))
    writeLogin(accountDir(localDir, 'conta2'), 'dois@x.com', Date.now() + HOUR)
    writeLogin(accountDir(localDir, 'conta3'), 'tres@x.com', Date.now() + HOUR)
    await w.sync()
    expect(backupIds(kv).sort()).toEqual(['conta2', 'conta3'])

    state.online = false
    expect(await w.registry.remove('conta2')).toBe(true)
    await flush()
    expect(backupIds(kv).sort()).toEqual(['conta2', 'conta3']) // a remoção no banco falhou

    state.online = true
    const report = await w.sync()
    expect(report.pruned).toEqual(['conta2'])
    expect(backupIds(kv)).toEqual(['conta3'])
  })

  it('cópia de um id que nunca esteve na lista (resto de corrida) também sai', async () => {
    const w = world()
    w.kv.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com'], ['conta2', 'dois@x.com']]))
    writeLogin(accountDir(localDir, 'conta2'), 'dois@x.com', Date.now() + HOUR)
    await w.sync()
    const backups = JSON.parse(w.kv.get(CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY) ?? '{}') as { accounts: Record<string, unknown> }
    backups.accounts['fantasma'] = backups.accounts['conta2']
    w.kv.set(CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY, JSON.stringify(backups))
    expect((await w.sync()).pruned).toEqual(['fantasma'])
    expect(backupIds(w.kv)).toEqual(['conta2'])
  })
})

describe('sem duplicata de conta', () => {
  it('conta adicionada com o banco fora e com o e-mail de uma conta do banco não vira segunda cópia', async () => {
    const state = { online: false }
    const w = world(new Map(), {
      login: async (dir) => {
        writeLogin(dir, 'dois@x.com', Date.now() + HOUR)
        return true
      },
      authStatus: async (dir): Promise<ClaudeAuthStatus> =>
        dir ? { loggedIn: true, authMethod: 'claude.ai', email: 'dois@x.com' } : { loggedIn: true, authMethod: 'claude.ai', email: 'eu@x.com' }
    }, state)
    w.kv.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com'], ['conta2', 'dois@x.com']]))
    const added = await w.registry.add()
    expect(added.ok).toBe(true)
    state.online = true
    await w.registry.ensureLoaded()
    expect(w.registry.ids()).toEqual([DEFAULT_ACCOUNT_ID, 'conta2'])
  })

  it('pasta órfã sem e-mail não é adotada (poderia ser a mesma conta de outra pasta); nada é apagado', async () => {
    const w = world()
    w.kv.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com'], ['conta2', 'dois@x.com']]))
    writeLogin(accountDir(localDir, 'conta2'), 'dois@x.com', Date.now() + HOUR)
    writeLogin(accountDir(localDir, 'semEmail'), null, Date.now() + 2 * HOUR)
    const report = await w.sync()
    expect(report.adopted).toEqual([])
    expect(w.registry.ids()).toEqual([DEFAULT_ACCOUNT_ID, 'conta2'])
    expect(existsSync(accountDir(localDir, 'semEmail'))).toBe(true)
  })

  it('órfã com e-mail igual ao de uma conta da lista SEM e-mail guardado (lido da pasta dela) também não entra', async () => {
    const w = world()
    w.kv.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com'], ['conta2', null]]))
    writeLogin(accountDir(localDir, 'conta2'), 'dois@x.com', Date.now() + HOUR)
    writeLogin(accountDir(localDir, 'copia'), 'DOIS@x.com', Date.now() + 2 * HOUR)
    expect((await w.sync()).adopted).toEqual([])
    expect(w.registry.ids()).toEqual([DEFAULT_ACCOUNT_ID, 'conta2'])
  })
})

describe('Linux sem chaveiro (safeStorage com backend basic_text)', () => {
  it('não grava cópia de credencial: basic_text é só ofuscação', async () => {
    expect(hasRealEncryption(cipher('basic_text'))).toBe(false)
    expect(hasRealEncryption(cipher('gnome_libsecret'))).toBe(true)
    expect(hasRealEncryption(cipher())).toBe(true)
    const w = world(new Map(), {}, { online: true }, cipher('basic_text'))
    w.kv.set(CLAUDE_ACCOUNTS_KV_KEY, listOf([[DEFAULT_ACCOUNT_ID, 'eu@x.com'], ['conta2', 'dois@x.com']]))
    writeLogin(accountDir(localDir, 'conta2'), 'dois@x.com', Date.now() + HOUR)
    const report = await w.sync()
    expect(report.backedUp).toEqual([])
    expect(w.kv.has(CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY)).toBe(false)
    // Com chaveiro de verdade, a mesma pasta é copiada.
    const keyring = world(w.kv, {}, { online: true }, cipher('gnome_libsecret'))
    expect((await keyring.sync()).backedUp).toEqual(['conta2'])
  })
})
