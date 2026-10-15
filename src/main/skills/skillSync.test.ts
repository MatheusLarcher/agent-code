import { describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ERROR_BACKOFF_MS,
  EXPOSE_TTL_MS,
  inlineSkillSyncRunner,
  SkillSyncCoordinator,
  workerSkillSyncRunner,
  type SkillSyncRunner
} from './skillSync'
import type { SkillSyncRequest, SkillSyncResponse } from './skillSyncTask'

const TARGET = { appRoot: '/app', cacheDir: '/cache', userHome: '/home', kits: [] }

/** Runner falso: espelha o runSkillSync (versão da origem vs. conhecida) sem disco. */
function fakeRunner(opts: { version?: () => string; errors?: () => string[]; hold?: boolean } = {}) {
  const calls: SkillSyncRequest[] = []
  const releases: Array<() => void> = []
  const runner: SkillSyncRunner = {
    run: async (request) => {
      calls.push(request)
      if (opts.hold) await new Promise<void>((resolve) => releases.push(resolve))
      const version = opts.version?.() ?? 'v1'
      const full = request.mode === 'full' || version !== request.knownVersion
      const ran = full || request.mode === 'expose'
      const errors = ran ? (opts.errors?.() ?? []) : []
      const response: SkillSyncResponse = { version, full, ran, result: { skillsDir: request.skillsDir, available: [], errors } }
      return response
    },
    dispose: () => undefined
  }
  const release = (): void => {
    for (const fn of releases.splice(0)) fn()
  }
  return { runner, calls, release }
}

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

const managed = (fingerprint = 'fp', scope = '/projeto') => ({ scope, fingerprint: () => fingerprint })

describe('SkillSyncCoordinator — coalescência', () => {
  it('chamadas simultâneas do mesmo alvo rodam uma vez só', async () => {
    const fake = fakeRunner({ hold: true })
    const sync = new SkillSyncCoordinator({ runner: () => fake.runner, machine: 'pc' })
    const all = Promise.all([
      sync.syncManaged(TARGET, managed('a', '/p1')),
      sync.syncManaged(TARGET, managed('b', '/p2')),
      sync.syncManaged(TARGET, managed('c', '/p3'))
    ])
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
    fake.release()
    const responses = await all
    expect(fake.calls).toHaveLength(1)
    expect(new Set(responses)).toHaveProperty('size', 1)
  })

  it('a completa em voo cobre as gerenciadas; a gerenciada em voo não cobre a completa', async () => {
    const fake = fakeRunner({ hold: true })
    const sync = new SkillSyncCoordinator({ runner: () => fake.runner, machine: 'pc' })
    const full = sync.syncAll(TARGET)
    const managedCall = sync.syncManaged(TARGET, managed())
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
    fake.release()
    await Promise.all([full, managedCall])
    expect(fake.calls.map((c) => c.mode)).toEqual(['full'])

    const sync2 = new SkillSyncCoordinator({ runner: () => fake.runner, machine: 'pc' })
    fake.calls.length = 0
    const first = sync2.syncManaged(TARGET, managed())
    const second = sync2.syncAll(TARGET)
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
    fake.release()
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2))
    fake.release()
    await Promise.all([first, second])
    expect(fake.calls.map((c) => c.mode)).toEqual(['expose', 'full'])
  })

  it('uma execução por vez no app, mesmo com alvos diferentes', async () => {
    const fake = fakeRunner({ hold: true })
    const sync = new SkillSyncCoordinator({ runner: () => fake.runner, machine: 'pc' })
    const a = sync.syncAll(TARGET)
    const b = sync.syncAll({ ...TARGET, cacheDir: '/outro' })
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fake.calls).toHaveLength(1)
    fake.release()
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2))
    fake.release()
    await Promise.all([a, b])
  })
})

describe('SkillSyncCoordinator — TTL da exposição', () => {
  it('dentro de 30 s com a mesma assinatura não expõe; depois do TTL, expõe', async () => {
    const fake = fakeRunner()
    const time = clock()
    const sync = new SkillSyncCoordinator({ runner: () => fake.runner, now: time.now, machine: 'pc' })
    await sync.syncManaged(TARGET, managed())
    expect(fake.calls.at(-1)?.mode).toBe('expose')
    time.advance(EXPOSE_TTL_MS - 1)
    const quiet = await sync.syncManaged(TARGET, managed())
    expect(fake.calls.at(-1)?.mode).toBe('check')
    expect(quiet.ran).toBe(false)
    time.advance(1)
    await sync.syncManaged(TARGET, managed())
    expect(fake.calls.at(-1)?.mode).toBe('expose')
  })

  it('assinatura barata diferente expõe na hora, por chamador', async () => {
    const fake = fakeRunner()
    const time = clock()
    const sync = new SkillSyncCoordinator({ runner: () => fake.runner, now: time.now, machine: 'pc' })
    await sync.syncManaged(TARGET, managed('a', '/p1'))
    await sync.syncManaged(TARGET, managed('a', '/p1'))
    expect(fake.calls.map((c) => c.mode)).toEqual(['expose', 'check'])
    await sync.syncManaged(TARGET, managed('b', '/p1'))
    expect(fake.calls.at(-1)?.mode).toBe('expose')
    // Outro chamador ainda sem assinatura registrada: expõe também.
    await sync.syncManaged(TARGET, managed('b', '/p2'))
    expect(fake.calls.at(-1)?.mode).toBe('expose')
    await sync.syncManaged(TARGET, managed('b', '/p2'))
    expect(fake.calls.at(-1)?.mode).toBe('check')
  })

  it('a origem que mudou vira completa mesmo dentro do TTL (conferida no runner)', async () => {
    let version = 'v1'
    const fake = fakeRunner({ version: () => version })
    const time = clock()
    const sync = new SkillSyncCoordinator({ runner: () => fake.runner, now: time.now, machine: 'pc' })
    await sync.syncAll(TARGET)
    version = 'v2'
    const response = await sync.syncManaged(TARGET, managed())
    expect(response.full).toBe(true)
    expect(response.version).toBe('v2')
    expect(fake.calls.at(-1)?.knownVersion).toBe('v1')
    await sync.syncManaged(TARGET, managed())
    expect(fake.calls.at(-1)?.knownVersion).toBe('v2')
  })
})

describe('SkillSyncCoordinator — erro e backoff', () => {
  it('completa com erro registra a versão e só refaz a completa depois de 60 s', async () => {
    let errors = ['EPERM']
    const fake = fakeRunner({ errors: () => errors })
    const time = clock()
    const sync = new SkillSyncCoordinator({ runner: () => fake.runner, now: time.now, machine: 'pc' })
    const first = await sync.syncAll(TARGET)
    expect(first.errors).toEqual(['EPERM'])

    // A versão ficou: o próximo envio não repete a completa.
    time.advance(1_000)
    const next = await sync.syncManaged(TARGET, managed())
    expect(fake.calls.at(-1)?.knownVersion).toBe('v1')
    expect(next.full).toBe(false)
    // Primeira vez deste chamador (assinatura desconhecida): só expõe.
    expect(fake.calls.at(-1)?.mode).toBe('expose')
    await sync.syncManaged(TARGET, managed())
    expect(fake.calls.at(-1)?.mode).toBe('check')

    // Antes do backoff, nem a exposição volta (o TTL de erro é o backoff).
    time.advance(EXPOSE_TTL_MS)
    await sync.syncManaged(TARGET, managed())
    expect(fake.calls.at(-1)?.mode).toBe('check')

    time.advance(ERROR_BACKOFF_MS - EXPOSE_TTL_MS - 1_000)
    errors = []
    const retried = await sync.syncManaged(TARGET, managed())
    expect(fake.calls.at(-1)?.mode).toBe('full')
    expect(retried.full).toBe(true)
    expect(retried.result.errors).toEqual([])

    // Completa ok: volta ao TTL normal, sem nova completa.
    time.advance(1_000)
    await sync.syncManaged(TARGET, managed())
    expect(fake.calls.at(-1)?.mode).toBe('check')
  })

  it('runner que lança vira erro na resposta, com a versão conhecida', async () => {
    const runner: SkillSyncRunner = {
      run: async () => {
        throw new Error('worker morreu')
      },
      dispose: () => undefined
    }
    const sync = new SkillSyncCoordinator({ runner: () => runner, machine: 'pc' })
    const result = await sync.syncAll(TARGET)
    expect(result.errors[0]).toMatch(/worker morreu/)
  })
})

describe('runner inline (sem o bundle do worker)', () => {
  it('workerSkillSyncRunner sem caminho é o inline', () => {
    expect(workerSkillSyncRunner(null)).toBe(inlineSkillSyncRunner)
  })

  it('pedido impossível não lança: vira erro na resposta', async () => {
    const request: SkillSyncRequest = {
      mode: 'full',
      appRoot: '\0inválido',
      cacheDir: '\0inválido',
      skillsDir: '\0inválido',
      userHome: '\0inválido',
      machine: 'pc',
      kits: [],
      knownVersion: 'antiga'
    }
    const response = await inlineSkillSyncRunner.run(request)
    expect(response.ran).toBe(true)
    expect(response.result.errors.length).toBeGreaterThan(0)
  })

  it('sincroniza de verdade no próprio thread', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-sync-inline-'))
    const appRoot = join(root, 'app')
    const skill = join(appRoot, '.agents', 'skills', 'caveman')
    await mkdir(skill, { recursive: true })
    await writeFile(join(skill, 'SKILL.md'), '---\nname: caveman\ndescription: teste\n---\nugh', 'utf8')
    const cacheDir = join(root, 'cache')
    const home = join(root, 'home')
    await mkdir(cacheDir, { recursive: true })
    await mkdir(home, { recursive: true })

    const sync = new SkillSyncCoordinator({ runner: () => inlineSkillSyncRunner, machine: 'pc' })
    const result = await sync.syncAll({ appRoot, cacheDir, userHome: home, kits: [] })
    expect(result.errors).toEqual([])
    expect(existsSync(join(cacheDir, 'skills', 'caveman', 'SKILL.md'))).toBe(true)
  })
})
