// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAuthStatus } from '../auth'
import { accountDir, prepareAccountDir, readCredentialInfo, removeAccountDir } from './accountDirs'
import { CLAUDE_ACCOUNTS_KV_KEY, createAccountRegistry, DEFAULT_ACCOUNT_ID } from './registry'

const ACCESS = 'sk-ant-oat01-SEGREDO-DE-TESTE'
const REFRESH = 'sk-ant-ort01-SEGREDO-DE-TESTE'

let root: string
let machine: string

function writeCredential(dir: string, fields: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: ACCESS,
        refreshToken: REFRESH,
        expiresAt: Date.now() + 3_600_000,
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
        ...fields
      }
    })
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'contas-'))
  machine = join(root, 'maquina')
  mkdirSync(machine, { recursive: true })
  writeFileSync(join(machine, 'CLAUDE.md'), '# minhas regras')
  writeFileSync(join(machine, 'settings.json'), '{}')
  mkdirSync(join(machine, 'skills', 'minha-skill'), { recursive: true })
  writeFileSync(join(machine, 'skills', 'minha-skill', 'SKILL.md'), 'skill')
  writeCredential(machine)
  vi.stubEnv('CLAUDE_CONFIG_DIR', machine)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

function setup(emails: Record<string, string> = {}) {
  const kv = new Map<string, string>()
  const localDir = join(root, 'agent-code-local')
  const authStatus = vi.fn(async (configDir?: string): Promise<ClaudeAuthStatus> => {
    const key = configDir ?? 'machine'
    const email = emails[key] ?? emails[configDir ? 'new' : 'machine']
    return email ? { loggedIn: true, authMethod: 'claude.ai', email, subscriptionType: 'max' } : { loggedIn: false, authMethod: 'none' }
  })
  const login = vi.fn(async (configDir: string) => {
    writeCredential(configDir)
    return true
  })
  const registry = createAccountRegistry({
    localDir: () => localDir,
    readKv: async (key) => kv.get(key) ?? null,
    writeKv: async (key, value) => {
      kv.set(key, value)
    },
    authStatus,
    login,
    loginBusy: () => false
  })
  return { registry, kv, localDir, authStatus, login }
}

describe('pastas das contas', () => {
  it('copia CLAUDE.md/settings.json, liga as skills e nunca copia a credencial', () => {
    const dir = prepareAccountDir(join(root, 'conta'), machine)
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(true)
    expect(existsSync(join(dir, 'settings.json'))).toBe(true)
    expect(existsSync(join(dir, 'skills', 'minha-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(dir, '.credentials.json'))).toBe(false)
  })

  it('remover a conta apaga a pasta sem apagar as skills do usuário (link desfeito antes)', () => {
    const localDir = join(root, 'local')
    prepareAccountDir(accountDir(localDir, 'abc'), machine)
    removeAccountDir(localDir, 'abc')
    expect(existsSync(accountDir(localDir, 'abc'))).toBe(false)
    expect(existsSync(join(machine, 'skills', 'minha-skill', 'SKILL.md'))).toBe(true)
  })

  it('recusa id que escaparia da raiz das contas', () => {
    expect(() => accountDir(root, '../fora')).toThrow()
    expect(() => removeAccountDir(root, '..')).toThrow()
  })

  it('status pela validade do token, sem devolver o token', () => {
    const dir = join(root, 'cred')
    writeCredential(dir, { expiresAt: Date.now() - 1000, refreshToken: '' })
    const info = readCredentialInfo(dir)
    expect(info).toEqual({ present: true, live: false, subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' })
    expect(JSON.stringify(info)).not.toContain('sk-ant-')
    writeCredential(dir, { expiresAt: Date.now() - 1000 })
    expect(readCredentialInfo(dir).live).toBe(true) // renovável pelo refresh token
  })
})

describe('registro de contas', () => {
  it('conta já logada aparece como conta 1, sem novo login', async () => {
    const { registry, login } = setup({ machine: 'eu@exemplo.com' })
    const list = await registry.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: DEFAULT_ACCOUNT_ID, isDefault: true, status: 'connected', email: 'eu@exemplo.com' })
    expect(login).not.toHaveBeenCalled()
    // Conta padrão: a sessão herda o ambiente, exatamente como antes.
    expect(registry.envFor(DEFAULT_ACCOUNT_ID)).toBeUndefined()
  })

  it('adiciona conta com login próprio, e-mail e plano; a pasta fica na raiz local', async () => {
    const { registry, localDir } = setup({ machine: 'eu@exemplo.com', new: 'outra@exemplo.com' })
    const result = await registry.add()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.account).toMatchObject({ email: 'outra@exemplo.com', plan: 'max', status: 'connected', isDefault: false })
    const env = registry.envFor(result.account.id)
    expect(env?.CLAUDE_CONFIG_DIR).toBe(join(localDir, 'claude-accounts', result.account.id))
    expect(env?.CLAUDE_CONFIG_DIR).not.toBe(machine)
  })

  it('e-mail repetido avisa e não duplica (a pasta nova é descartada)', async () => {
    const { registry, localDir } = setup({ machine: 'eu@exemplo.com', new: 'EU@exemplo.com' })
    const result = await registry.add()
    expect(result).toEqual({ ok: false, reason: 'duplicate', email: 'EU@exemplo.com' })
    expect(await registry.list()).toHaveLength(1)
    expect(readdirSync(join(localDir, 'claude-accounts'))).toEqual([])
  })

  it('nenhum token vai para o store', async () => {
    const { registry, kv } = setup({ machine: 'eu@exemplo.com', new: 'outra@exemplo.com' })
    await registry.add()
    await registry.list()
    const stored = kv.get(CLAUDE_ACCOUNTS_KV_KEY) ?? ''
    expect(stored).toContain('outra@exemplo.com')
    expect(stored).not.toContain('sk-ant-')
    expect(stored).not.toContain('accessToken')
    expect(stored).not.toContain('refreshToken')
  })

  it('renomeia, reordena e remove; a conta padrão não sai', async () => {
    const { registry } = setup({ machine: 'eu@exemplo.com', new: 'outra@exemplo.com' })
    const added = await registry.add()
    if (!added.ok) throw new Error('add')
    const id = added.account.id
    await registry.rename(id, '  Trabalho  ')
    await registry.reorder([id, DEFAULT_ACCOUNT_ID])
    let list = await registry.list()
    expect(list.map((a) => a.id)).toEqual([id, DEFAULT_ACCOUNT_ID])
    expect(list[0].label).toBe('Trabalho')

    expect(await registry.remove(DEFAULT_ACCOUNT_ID)).toBe(false)
    expect(await registry.remove(id)).toBe(true)
    list = await registry.list()
    expect(list.map((a) => a.id)).toEqual([DEFAULT_ACCOUNT_ID])
    expect(registry.envFor(id)).toBeUndefined()
  })

  it('login expirado não é candidata', async () => {
    const { registry } = setup({ machine: 'eu@exemplo.com', new: 'outra@exemplo.com' })
    const added = await registry.add()
    if (!added.ok) throw new Error('add')
    writeCredential(registry.configDirOf(added.account.id)!, { expiresAt: Date.now() - 1000, refreshToken: '' })
    const candidates = await registry.candidates()
    expect(candidates.find((c) => c.id === added.account.id)?.status).toBe('expired')
  })
})
