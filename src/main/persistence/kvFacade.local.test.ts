// @vitest-environment node
// Config, contas e estado da tela no SQLite local: lidos e gravados sem o banco;
// cópia única do banco na atualização (o banco vence); espera só na 1ª abertura.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../store', () => ({
  kvGet: vi.fn(() => {
    throw new Error('o SQLite legado não pode ser lido')
  }),
  kvSet: vi.fn(() => {
    throw new Error('o SQLite legado não pode ser gravado')
  })
}))

const facade = await import('./kvFacade')
const { LocalKvStore } = await import('./localKvStore')

function fakeRepository(values: Record<string, string>) {
  return {
    getKv: vi.fn(async ({ key }: { key: string }) => (key in values ? { key, value: values[key], revision: 1 } : null)),
    getKvMany: vi.fn(async (_scope: string, keys: string[]) =>
      keys.filter((key) => key in values).map((key) => ({ key, value: values[key], revision: 1 }))
    ),
    setKv: vi.fn(async (write: { key: string; value: string }) => {
      values[write.key] = write.value
      return { ...write, revision: 2 }
    })
  }
}

let dir: string
let store: InstanceType<typeof LocalKvStore>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-code-localkv-'))
  store = new LocalKvStore(join(dir, 'config.db'))
  facade.configureLocalKvStore(store)
  facade.configureKvRepositoryOffline()
})

afterEach(async () => {
  facade.releaseLocalKv()
  facade.configureLocalKvStore(null)
  facade.configureKvRepository(null)
  store.close()
  await rm(dir, { recursive: true, force: true })
})

describe('kvFacade com o SQLite local', () => {
  it('config e estado da tela leem e gravam com o banco fora do ar; dados continuam exigindo o banco', async () => {
    await facade.writePersistedKv('config.skipPermissions', 'true')
    await facade.writePersistedKv('agentcode.ui.v1', '{"collapsed":true}')
    expect(await facade.readPersistedKv('config.skipPermissions')).toBe('true')
    const many = await facade.readPersistedKvMany(['config.skipPermissions', 'config.voice.voice', 'agentcode.ui.v1'])
    expect(Object.fromEntries(many)).toEqual({
      'config.skipPermissions': 'true',
      'config.voice.voice': null,
      'agentcode.ui.v1': '{"collapsed":true}'
    })
    await expect(facade.readPersistedKv('agentcode.po-authorizations.v1')).rejects.toThrow('offline')
    await expect(facade.readPersistedKvMany(['config.voice.voice', 'codexAuth'])).rejects.toThrow('offline')
  })

  it('com o banco de pé, cada chave vai para o seu lugar', async () => {
    const repository = fakeRepository({ 'agentcode.po-authorizations.v1': '{"a":1}' })
    facade.configureKvRepository(repository as never)
    await facade.writePersistedKv('agentcode.claude-accounts.v1', '[{"id":"x"}]')
    await facade.writePersistedKv('memory-curator:last-run-at', '123')
    expect(store.get('agentcode.claude-accounts.v1')).toBe('[{"id":"x"}]')
    expect(store.get('memory-curator:last-run-at')).toBeNull()
    expect(repository.setKv).toHaveBeenCalledWith(expect.objectContaining({ key: 'memory-curator:last-run-at' }))
    const many = await facade.readPersistedKvMany(['agentcode.claude-accounts.v1', 'agentcode.po-authorizations.v1'])
    expect(Object.fromEntries(many)).toEqual({
      'agentcode.claude-accounts.v1': '[{"id":"x"}]',
      'agentcode.po-authorizations.v1': '{"a":1}'
    })
  })

  it('cópia única do banco: o banco vence o que o SQLite já tinha, só as chaves locais, e não repete', async () => {
    store.set('config.voice.voice', '"antiga"')
    const repository = fakeRepository({
      'config.voice.voice': '"do-banco"',
      'agentcode.claude-accounts.v1': '[{"id":"conta-2"}]',
      'agentcode.po-authorizations.v1': '{"fica":"no banco"}'
    })
    facade.configureKvRepository(repository as never)
    expect(facade.localKvSeeded()).toBe(false)
    expect(await facade.seedLocalKvFromRepository()).toBe(true)
    expect(store.get('config.voice.voice')).toBe('"do-banco"')
    expect(store.get('agentcode.claude-accounts.v1')).toBe('[{"id":"conta-2"}]')
    expect(store.get('agentcode.po-authorizations.v1')).toBeNull()
    expect(facade.localKvSeeded()).toBe(true)
    expect(await facade.seedLocalKvFromRepository()).toBe(false)
    expect(repository.getKvMany.mock.calls.flatMap(([, keys]) => keys)).not.toContain('agentcode.po-authorizations.v1')
  })

  it('1ª abertura depois da atualização: quem lê espera a cópia; sem banco, segue com o que há', async () => {
    facade.holdLocalKvUntilSeeded()
    let read: string | null | undefined
    const pending = facade.readPersistedKv('agentcode.ui.v1').then((value) => (read = value))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(read).toBeUndefined()
    facade.configureKvRepository(fakeRepository({ 'agentcode.ui.v1': '{"activeId":"c9"}' }) as never)
    await facade.seedLocalKvFromRepository()
    facade.releaseLocalKv()
    await pending
    expect(read).toBe('{"activeId":"c9"}')

    // Já copiado: nas aberturas seguintes não há espera nenhuma.
    facade.holdLocalKvUntilSeeded()
    expect(await facade.readPersistedKv('agentcode.ui.v1')).toBe('{"activeId":"c9"}')
  })

  it('arquivo do SQLite local danificado: posto de lado e recomeça vazio', async () => {
    store.close()
    const path = join(dir, 'quebrado.db')
    writeFileSync(path, 'isto não é um banco sqlite')
    const broken = new LocalKvStore(path)
    expect(broken.get('config.voice.voice')).toBeNull()
    broken.set('config.voice.voice', '"nova"')
    expect(broken.get('config.voice.voice')).toBe('"nova"')
    broken.close()
    expect(readdirSync(dir).some((name) => name.startsWith('quebrado.db.corrupt-'))).toBe(true)
    expect(existsSync(path)).toBe(true)
  })
})
