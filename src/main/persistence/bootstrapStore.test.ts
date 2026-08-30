import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BootstrapStore, type SecureStorageAdapter } from './bootstrapStore'

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
  it('cria installation ID estável e nunca grava senha em texto puro', async () => {
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

  it('senha vazia mantém o segredo e limpar exige ação separada', async () => {
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

  it('recusa persistir senha quando safeStorage não está disponível', async () => {
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

  it('persiste transição e só confirma o ID correspondente', async () => {
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
