// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { SqliteRepository } from '../persistence/sqliteRepository'
import { resolveProjectIdentity } from '../persistence/projectIdentity'
import { createPlan, PlanNotFoundError, saveRoteiro, writeHandoff } from '../planning/planningStore'
import { handoffContentHash } from './handoffModel'
import { registerHandoffEnvios, type HandoffRegisterDeps } from './handoffRegister'

const SLUG = 'checkout'
const NOW = new Date(2026, 9, 5, 10, 0, 0)

const tempDirs: string[] = []
const opened: SqliteRepository[] = []
let cwd: string

async function repository(): Promise<SqliteRepository> {
  const cache = await mkdtemp(join(tmpdir(), 'agent-code-handoff-register-'))
  tempDirs.push(cache)
  const repo = new SqliteRepository(cache, join(cache, 'agent-code.db'), 'device-a')
  await repo.initialize()
  opened.push(repo)
  return repo
}

/** Plano real em disco: roteiro com estimativas (a etapa "testes" sem nenhuma). */
async function plan(): Promise<void> {
  await createPlan(cwd, SLUG, 'Checkout novo')
  await saveRoteiro(
    cwd,
    SLUG,
    {
      titulo: 'Checkout novo',
      etapas: [
        { id: 'requisitos', titulo: 'Levantar requisitos', status: 'concluida', estimativa: 20 },
        { id: 'pagamento', titulo: 'Integrar o pagamento', status: 'pendente', estimativa: 90 },
        { id: 'testes', titulo: 'Testar o fluxo', status: 'pendente' }
      ]
    },
    1
  )
}

async function prompt(conteudo: string, etapas?: string[]): Promise<{ arquivo: string; conteudo: string }> {
  return { arquivo: basename(await writeHandoff(cwd, SLUG, conteudo, NOW, etapas)), conteudo }
}

function deps(repo: SqliteRepository | null, over: Partial<HandoffRegisterDeps> = {}): HandoffRegisterDeps {
  return { repository: () => repo, projectId: async () => 'proj-1', newLoteId: () => 'lote-1', ...over }
}

const input = (prompts: { arquivo: string; conteudo: string }[]) => ({
  projectCwd: cwd,
  slug: SLUG,
  conversationId: 'conv-impl',
  conversationTitle: 'Implementação: Checkout novo',
  prompts
})

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'agent-code-handoff-plan-'))
  tempDirs.push(cwd)
})

afterEach(async () => {
  await Promise.all(opened.splice(0).map((repo) => repo.close()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('registerHandoffEnvios', () => {
  it('um envio por prompt (ordem 1..n, lote comum, na_fila) com uma entrega por etapa declarada e a estimativa copiada', async () => {
    await plan()
    const repo = await repository()
    const um = await prompt('# Prompt 1\r\nrequisitos e pagamento\n', ['requisitos', 'pagamento'])
    const dois = await prompt('# Prompt 2\ntestes', ['testes'])
    const envios = await registerHandoffEnvios(input([um, dois]), deps(repo))

    expect(envios).toHaveLength(2)
    expect(envios.map((e) => [e.arquivo, e.ordem, e.loteId, e.status])).toEqual([
      [um.arquivo, 1, 'lote-1', 'na_fila'],
      [dois.arquivo, 2, 'lote-1', 'na_fila']
    ])
    expect(envios[0]).toMatchObject({
      planSlug: SLUG,
      planTitulo: 'Checkout novo',
      projectId: 'proj-1',
      projectCwd: cwd,
      conversationId: 'conv-impl',
      conversationTitle: 'Implementação: Checkout novo',
      conteudo: um.conteudo,
      conteudoHash: handoffContentHash(um.conteudo),
      estimativaTotal: 110,
      prazoTotal: 110
    })
    expect(envios[0].entregas.map((n) => [n.ordem, n.etapaId, n.etapaTitulo, n.estimativaPlano, n.status])).toEqual([
      [1, 'requisitos', 'Levantar requisitos', 20, 'pendente'],
      [2, 'pagamento', 'Integrar o pagamento', 90, 'pendente']
    ])
    // Etapa sem estimativa no roteiro: entrega sem prazo.
    expect(envios[1].entregas.map((n) => [n.etapaId, n.estimativaPlano])).toEqual([['testes', null]])
    expect(envios[1].estimativaTotal).toBeNull()
    // Está no banco, não só no retorno.
    const gravados = await repo.listHandoffEnvios({ conversationId: 'conv-impl' })
    expect(gravados.map((e) => e.id).sort()).toEqual(envios.map((e) => e.id).sort())
  })

  it('prompt sem etapas declaradas (sem o .meta.json) vira envio sem entregas e sem prazo', async () => {
    await plan()
    const repo = await repository()
    const antigo = await prompt('# Prompt antigo')
    const [envio] = await registerHandoffEnvios(input([antigo]), deps(repo))
    expect(envio).toMatchObject({ arquivo: antigo.arquivo, ordem: 1, status: 'na_fila', estimativaTotal: null, entregas: [] })
  })

  it('etapa declarada que sumiu do roteiro: o título é o id e não há estimativa', async () => {
    await plan()
    const repo = await repository()
    const p = await prompt('# Prompt', ['pagamento', 'etapa-removida'])
    const [envio] = await registerHandoffEnvios(input([p]), deps(repo))
    expect(envio.entregas.map((n) => [n.etapaId, n.etapaTitulo, n.estimativaPlano])).toEqual([
      ['pagamento', 'Integrar o pagamento', 90],
      ['etapa-removida', 'etapa-removida', null]
    ])
    expect(envio.prazoTotal).toBe(90)
  })

  it('editar o roteiro depois do registro não muda as linhas gravadas (o prazo prometido fica)', async () => {
    await plan()
    const repo = await repository()
    const p = await prompt('# Prompt', ['requisitos', 'pagamento'])
    const [antes] = await registerHandoffEnvios(input([p]), deps(repo))
    await saveRoteiro(
      cwd,
      SLUG,
      {
        titulo: 'Checkout reescrito',
        etapas: [
          { id: 'requisitos', titulo: 'Requisitos (revistos)', status: 'concluida', estimativa: 5 },
          { id: 'pagamento', titulo: 'Pagamento com Pix', status: 'pendente', estimativa: 300 }
        ]
      },
      2
    )
    const [depois] = await repo.listHandoffEnvios({ ids: [antes.id] })
    expect(depois.planTitulo).toBe('Checkout novo')
    expect(depois.estimativaTotal).toBe(110)
    expect(depois.prazoTotal).toBe(110)
    expect(depois.entregas.map((n) => [n.etapaTitulo, n.estimativaPlano])).toEqual([
      ['Levantar requisitos', 20],
      ['Integrar o pagamento', 90]
    ])
  })

  it('sem repositório não lança e devolve [] — nem lê o plano', async () => {
    const store = { openPlan: vi.fn(), readHandoffEtapas: vi.fn() }
    const prompts = [{ arquivo: '2026-10-05-01.md', conteudo: 'x' }]
    await expect(registerHandoffEnvios(input(prompts), deps(null, { store }))).resolves.toEqual([])
    const quebrado = deps(null, {
      store,
      repository: () => {
        throw new Error('backend trocando')
      }
    })
    await expect(registerHandoffEnvios(input(prompts), quebrado)).resolves.toEqual([])
    expect(store.openPlan).not.toHaveBeenCalled()
  })

  it('busca o repositório a cada chamada: depois de o banco reconectar, grava no novo', async () => {
    await plan()
    const [a, b] = [await repository(), await repository()]
    let atual = a
    const getter = vi.fn(() => atual)
    const p = await prompt('# Prompt', ['requisitos'])
    await registerHandoffEnvios(input([p]), deps(null, { repository: getter }))
    atual = b
    await registerHandoffEnvios(input([p]), deps(null, { repository: getter }))
    expect(await a.listHandoffEnvios({})).toHaveLength(1)
    expect(await b.listHandoffEnvios({})).toHaveLength(1)
    expect(getter.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('cada registro tem um lote novo por padrão', async () => {
    await plan()
    const repo = await repository()
    const p = await prompt('# Prompt', ['requisitos'])
    const [x] = await registerHandoffEnvios(input([p]), deps(repo, { newLoteId: undefined }))
    const [y] = await registerHandoffEnvios(input([p]), deps(repo, { newLoteId: undefined }))
    expect(x.loteId).toMatch(/^hl-/)
    expect(x.loteId).not.toBe(y.loteId)
  })

  it('o projectId padrão é o do resolveProjectIdentity (o mesmo critério do Quadro)', async () => {
    await plan()
    const repo = await repository()
    const p = await prompt('# Prompt', ['requisitos'])
    const [envio] = await registerHandoffEnvios(input([p]), deps(repo, { projectId: undefined }))
    expect(envio.projectId).toBe((await resolveProjectIdentity(cwd)).projectId)
  })

  it('plano inexistente lança (o IPC transforma em { ok: false }) e nada é gravado', async () => {
    const repo = await repository()
    const prompts = [{ arquivo: '2026-10-05-01.md', conteudo: 'x' }]
    await expect(registerHandoffEnvios(input(prompts), deps(repo))).rejects.toBeInstanceOf(PlanNotFoundError)
    expect(await repo.listHandoffEnvios({})).toEqual([])
  })
})
