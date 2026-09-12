// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteRepository } from '../persistence/sqliteRepository'
import { TaskLedger } from './taskLedger'
import { clearProjectScopeCache, resolveProjectCwds, PROJECT_SCOPE_TTL_MS } from './projectScope'

vi.mock('../persistence/projectIdentity', () => ({
  resolveProjectIdentity: vi.fn()
}))
const { resolveProjectIdentity } = await import('../persistence/projectIdentity')
const identityOf = vi.mocked(resolveProjectIdentity)

const tempDirs: string[] = []

async function setup(): Promise<TaskLedger> {
  const cache = await mkdtemp(join(tmpdir(), 'agent-code-scope-'))
  tempDirs.push(cache)
  const repository = new SqliteRepository(cache, join(cache, 'agent-code.db'), 'device-a')
  await repository.initialize()
  return new TaskLedger(repository)
}

beforeEach(() => {
  clearProjectScopeCache()
  identityOf.mockReset()
  identityOf.mockResolvedValue({ projectId: 'proj-1', signature: 'sig-1', remoteGit: 'github.com/x/y' })
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('resolveProjectCwds', () => {
  it('sem registro autoritativo, vale só o caminho local', async () => {
    expect(await resolveProjectCwds(null, 'C:/a')).toEqual(['C:/a'])
  })

  it('caminho vazio não vira filtro de nada', async () => {
    expect(await resolveProjectCwds(null, '')).toEqual([])
  })

  it('grava a própria linha e se enxerga na lista', async () => {
    const ledger = await setup()
    expect(await resolveProjectCwds(ledger, 'C:/GitHub/agent-code')).toEqual(['C:/GitHub/agent-code'])
    expect(await ledger.projectCwdsForIdentity('proj-1')).toEqual(['C:/GitHub/agent-code'])
  })

  it('o outro PC aparece: mesmo projeto, caminho diferente', async () => {
    const ledger = await setup()
    // O que o PC B gravou quando abriu o mesmo repositório lá.
    await ledger.recordProjectIdentity({
      projectCwd: 'D:/dev/agent-code',
      projectId: 'proj-1',
      signature: 'sig-1'
    })

    const cwds = await resolveProjectCwds(ledger, 'C:/GitHub/agent-code')
    expect(cwds.sort()).toEqual(['C:/GitHub/agent-code', 'D:/dev/agent-code'])
  })

  it('projeto diferente não entra na lista', async () => {
    const ledger = await setup()
    await ledger.recordProjectIdentity({
      projectCwd: 'D:/outro',
      projectId: 'proj-2',
      signature: 'sig-2'
    })
    expect(await resolveProjectCwds(ledger, 'C:/GitHub/agent-code')).toEqual(['C:/GitHub/agent-code'])
  })

  it('identidade que não resolve degrada para o caminho local, sem lançar', async () => {
    const ledger = await setup()
    identityOf.mockRejectedValue(new Error('pasta sumiu'))
    expect(await resolveProjectCwds(ledger, 'C:/sumiu')).toEqual(['C:/sumiu'])
  })

  it('não paga git a cada chamada — e o TTL solta o cache', async () => {
    const ledger = await setup()
    const t0 = 1_000_000
    await resolveProjectCwds(ledger, 'C:/a', t0)
    await resolveProjectCwds(ledger, 'C:/a', t0 + 1_000)
    expect(identityOf).toHaveBeenCalledTimes(1)

    await resolveProjectCwds(ledger, 'C:/a', t0 + PROJECT_SCOPE_TTL_MS + 1)
    expect(identityOf).toHaveBeenCalledTimes(2)
  })
})

describe('a fila do projeto é uma só entre PCs', () => {
  it('claim e list alcançam a tarefa que o outro PC deixou', async () => {
    const ledger = await setup()
    // Tarefa criada no PC B, com o caminho de LÁ.
    const task = await ledger.createTask({
      projectCwd: 'D:/dev/agent-code',
      title: 'deixada pelo outro PC',
      goal: 'g'
    })
    await ledger.recordProjectIdentity({
      projectCwd: 'D:/dev/agent-code',
      projectId: 'proj-1',
      signature: 'sig-1'
    })

    // Deste PC, o caminho é outro: pelo filtro antigo, a fila parecia vazia.
    expect(await ledger.listTasks({ projectCwd: 'C:/GitHub/agent-code' })).toHaveLength(0)
    expect(await ledger.claimTask('session:aqui', { projectCwd: 'C:/GitHub/agent-code' })).toBeNull()

    const projectCwds = await resolveProjectCwds(ledger, 'C:/GitHub/agent-code')
    expect(await ledger.listTasks({ projectCwds })).toHaveLength(1)

    const claim = await ledger.claimTask('session:aqui', { projectCwds })
    expect(claim?.task.id).toBe(task.id)
  })

  it('lista vazia é "nenhum projeto", não "todos"', async () => {
    const ledger = await setup()
    await ledger.createTask({ projectCwd: 'C:/a', title: 'x', goal: 'g' })
    expect(await ledger.listTasks({ projectCwds: [] })).toEqual([])
    expect(await ledger.claimTask('session:aqui', { projectCwds: [] })).toBeNull()
  })

  it('a lista de caminhos vence o caminho único quando os dois vêm', async () => {
    const ledger = await setup()
    await ledger.createTask({ projectCwd: 'D:/dev/agent-code', title: 'do outro', goal: 'g' })
    const tasks = await ledger.listTasks({
      projectCwd: 'C:/GitHub/agent-code',
      projectCwds: ['C:/GitHub/agent-code', 'D:/dev/agent-code']
    })
    expect(tasks).toHaveLength(1)
  })
})
