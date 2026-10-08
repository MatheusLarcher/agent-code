import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BootstrapStore, LOCAL_POSTGRES_PORT, type SecureStorageAdapter } from './bootstrapStore'

const dirs: string[] = []

function secure(available = true): SecureStorageAdapter {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^encrypted:/, '')
  }
}

async function store(adapter = secure()): Promise<{ dir: string; store: BootstrapStore }> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-code-bootstrap-'))
  dirs.push(dir)
  return { dir, store: new BootstrapStore(dir, adapter) }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('BootstrapStore', () => {
  it('cria installation ID estÃ¡vel e nunca grava senha em texto puro', async () => {
    const { dir, store: bootstrap } = await store()
    const first = await bootstrap.load()
    await bootstrap.saveConnection({
      host: 'db.local',
      port: 5433,
      user: 'agent',
      password: 'segredo-super-secreto',
      maintenanceDatabase: 'postgres',
      tlsMode: 'verify-full',
      ca: 'CA'
    })
    const raw = await readFile(join(dir, 'storage-bootstrap.json'), 'utf8')
    expect(raw).not.toContain('segredo-super-secreto')
    expect((await bootstrap.connection()).password).toBe('segredo-super-secreto')
    expect((await new BootstrapStore(dir, secure()).load()).installationId).toBe(first.installationId)
  })

  it('senha vazia mantÃ©m o segredo e limpar exige aÃ§Ã£o separada', async () => {
    const { store: bootstrap } = await store()
    const draft = {
      host: 'localhost',
      port: 5432,
      user: 'postgres',
      password: 'primeira',
      maintenanceDatabase: 'postgres',
      tlsMode: 'disable' as const,
      ca: ''
    }
    await bootstrap.saveConnection(draft)
    await bootstrap.saveConnection({ ...draft, password: '', host: 'outro-host' })
    expect(await bootstrap.connection()).toMatchObject({ host: 'outro-host', password: 'primeira' })
    await bootstrap.clearPassword()
    expect((await bootstrap.connection()).password).toBe('')
  })

  it('recusa persistir senha quando safeStorage nÃ£o estÃ¡ disponÃ­vel', async () => {
    const { store: bootstrap } = await store(secure(false))
    await expect(
      bootstrap.saveConnection({
        host: 'localhost',
        port: 5432,
        user: 'postgres',
        password: 'texto-puro',
        maintenanceDatabase: 'postgres',
        tlsMode: 'disable',
        ca: ''
      })
    ).rejects.toMatchObject({ code: 'SECURE_STORAGE_UNAVAILABLE' })
  })

  it('persiste transiÃ§Ã£o e sÃ³ confirma o ID correspondente', async () => {
    const { store: bootstrap } = await store()
    const transitionId = await bootstrap.beginTransition('activating-postgres')
    await expect(bootstrap.confirmBackend('postgres', '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      code: 'TRANSITION_IN_PROGRESS'
    })
    await bootstrap.confirmBackend('postgres', transitionId)
    expect(await bootstrap.load()).toMatchObject({
      backend: 'postgres',
      transitionState: 'idle',
      lastConfirmedTransitionId: transitionId
    })
  })
})

describe('BootstrapStore: PostgreSQL local x nuvem', () => {
  async function legacy(backend: 'sqlite' | 'postgres', transitionState = 'idle') {
    const { dir } = await store()
    await writeFile(
      join(dir, 'storage-bootstrap.json'),
      JSON.stringify({
        version: 1,
        installationId: randomUUID(),
        backend,
        transitionState,
        transitionId: transitionState === 'idle' ? null : randomUUID(),
        lastConfirmedTransitionId: null,
        postgres: {
          host: '192.0.2.10',
          port: 6502,
          user: 'crm',
          maintenanceDatabase: 'postgres',
          tlsMode: 'disable',
          ca: '',
          encryptedPassword: Buffer.from('encrypted:remota').toString('base64'),
          targetDatabase: 'agent-code'
        }
      })
    )
    return { dir, bootstrap: new BootstrapStore(dir, secure()) }
  }

  it('instalaÃ§Ã£o nova comeÃ§a no PostgreSQL local, importando o SQLite (vazio) na abertura', async () => {
    const { store: bootstrap } = await store()
    expect(await bootstrap.load()).toMatchObject({
      version: 2,
      backend: 'sqlite',
      postgresTarget: 'local',
      pendingLocalImport: true,
      local: { port: LOCAL_POSTGRES_PORT, encryptedPassword: '' }
    })
  })

  it('v1 no PostgreSQL remoto continua nele (nuvem ligada) e o arquivo Ã© regravado como v2', async () => {
    const { dir, bootstrap } = await legacy('postgres')
    expect(await bootstrap.load()).toMatchObject({ backend: 'postgres', postgresTarget: 'cloud', pendingLocalImport: false })
    expect(await bootstrap.connection()).toMatchObject({ host: '192.0.2.10', port: 6502, password: 'remota' })
    const raw = JSON.parse(await readFile(join(dir, 'storage-bootstrap.json'), 'utf8'))
    expect(raw).toMatchObject({ version: 2, postgresTarget: 'cloud' })
  })

  it('v1 no SQLite fica para importar no PostgreSQL local', async () => {
    const { bootstrap } = await legacy('sqlite')
    expect(await bootstrap.load()).toMatchObject({ backend: 'sqlite', postgresTarget: 'local', pendingLocalImport: true })
  })

  it('v1 com ativaÃ§Ã£o da nuvem interrompida: a recuperaÃ§Ã£o confere na nuvem', async () => {
    const { bootstrap } = await legacy('sqlite', 'activating-postgres')
    expect(await bootstrap.load()).toMatchObject({
      transitionState: 'activating-postgres',
      postgresTarget: 'cloud',
      pendingLocalImport: true
    })
  })

  it('senha do servidor local sÃ³ cifrada; porta trocada fica gravada', async () => {
    const { dir, store: bootstrap } = await store()
    expect(await bootstrap.localPassword()).toBe('')
    await bootstrap.saveLocalPassword('senha-local-aleatoria')
    await bootstrap.saveLocalPort(45433)
    expect(await readFile(join(dir, 'storage-bootstrap.json'), 'utf8')).not.toContain('senha-local-aleatoria')
    const reopened = new BootstrapStore(dir, secure())
    expect(await reopened.localPassword()).toBe('senha-local-aleatoria')
    expect((await reopened.load()).local.port).toBe(45433)
  })

  it('a ativaÃ§Ã£o grava o alvo antes de comeÃ§ar e confirmar encerra a importaÃ§Ã£o pendente', async () => {
    const { store: bootstrap } = await store()
    const transitionId = await bootstrap.beginTransition('activating-postgres', 'local')
    expect(await bootstrap.load()).toMatchObject({ postgresTarget: 'local', pendingLocalImport: true })
    await bootstrap.confirmBackend('postgres', transitionId)
    expect(await bootstrap.load()).toMatchObject({ backend: 'postgres', postgresTarget: 'local', pendingLocalImport: false })
  })
})
