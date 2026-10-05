// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handoffContentHash } from '../handoffTracking/handoffModel'
import { SqliteRepository } from './sqliteRepository'
import type { HandoffEnvioCreate } from './types'

const tempDirs: string[] = []
const opened: SqliteRepository[] = []

async function repository(): Promise<{ repo: SqliteRepository; dbPath: string }> {
  const cache = await mkdtemp(join(tmpdir(), 'agent-code-handoff-'))
  tempDirs.push(cache)
  const dbPath = join(cache, 'agent-code.db')
  const repo = new SqliteRepository(cache, dbPath, 'device-a')
  await repo.initialize()
  opened.push(repo)
  return { repo, dbPath }
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(opened.splice(0).map((repo) => repo.close()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function envio(ordem: number, patch: Partial<HandoffEnvioCreate> = {}): HandoffEnvioCreate {
  return {
    planSlug: 'plano-1',
    planTitulo: 'Plano de teste',
    projectId: 'proj-1',
    projectCwd: 'C:/GitHub/agent-code',
    conversationId: 'conv-1',
    conversationTitle: 'Implementação',
    arquivo: `0${ordem}-prompt.md`,
    ordem,
    loteId: 'lote-1',
    conteudo: `Prompt ${ordem}\r\n`,
    entregas: [
      { etapaId: `etapa-${ordem}a`, etapaTitulo: 'Primeira', estimativaPlano: 30 },
      { etapaId: `etapa-${ordem}b`, etapaTitulo: 'Segunda', estimativaPlano: null },
      { etapaId: `etapa-${ordem}c`, etapaTitulo: 'Terceira', estimativaPlano: 15 }
    ],
    ...patch
  }
}

function count(dbPath: string, table: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
  } finally {
    db.close()
  }
}

describe('SqliteRepository — envios de handoff', () => {
  it('createHandoffEnvios grava o lote com status na_fila, hash normalizado, totais e entregas por ordem', async () => {
    const { repo } = await repository()
    const created = await repo.createHandoffEnvios([envio(1), envio(2, { entregas: [] })])

    expect(created.map((item) => item.ordem)).toEqual([1, 2])
    const [first, second] = created
    expect(first).toMatchObject({
      status: 'na_fila',
      motivo: null,
      conteudo: 'Prompt 1\r\n',
      conteudoHash: handoffContentHash('Prompt 1'),
      estimativaTotal: 45,
      prazoTotal: 45,
      atrasado: false,
      tempoAtivoMs: 0,
      retrabalhoMs: 0,
      enviadoEm: null,
      iniciadoEm: null,
      concluidoEm: null
    })
    expect(first.id).toMatch(/^he-/)
    expect(first.criadoEm).toBe(second.criadoEm)
    expect(first.entregas.map((entrega) => [entrega.etapaId, entrega.ordem, entrega.estimativaPlano, entrega.status])).toEqual([
      ['etapa-1a', 1, 30, 'pendente'],
      ['etapa-1b', 2, null, 'pendente'],
      ['etapa-1c', 3, 15, 'pendente']
    ])
    expect(first.entregas.every((entrega) => entrega.id.startsWith('hn-') && entrega.envioId === first.id)).toBe(true)
    expect(first.entregas[0]).toMatchObject({ auditada: null, corrigidoPor: null, tempoCorridoMs: null, atrasada: false })
    expect(second).toMatchObject({ entregas: [], estimativaTotal: null, prazoTotal: null })
  })

  it('um envio inválido no lote não grava nenhum', async () => {
    const { repo, dbPath } = await repository()
    await expect(repo.createHandoffEnvios([envio(1), envio(2, { conteudo: ' ' })])).rejects.toThrow(/conteudo/)
    expect(count(dbPath, 'handoff_envios')).toBe(0)
    expect(count(dbPath, 'handoff_entregas')).toBe(0)
    expect(await repo.createHandoffEnvios([])).toEqual([])
  })

  it('listHandoffEnvios filtra por ids, conversa, projetos e status, com limite e ordem criado_em DESC, ordem ASC', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { repo } = await repository()
    vi.setSystemTime(new Date('2026-10-05T10:00:00.000Z'))
    const antigo = await repo.createHandoffEnvios([envio(1), envio(2)])
    vi.setSystemTime(new Date('2026-10-05T11:00:00.000Z'))
    const novo = await repo.createHandoffEnvios([
      envio(1, { loteId: 'lote-2', conversationId: 'conv-2', projectId: 'proj-2' }),
      envio(2, { loteId: 'lote-2', conversationId: 'conv-2', projectId: 'proj-2' })
    ])
    await repo.updateHandoffEnvio(novo[1].id, { status: 'enviado' })

    const all = await repo.listHandoffEnvios({})
    expect(all.map((item) => item.id)).toEqual([novo[0].id, novo[1].id, antigo[0].id, antigo[1].id])
    expect(all[0].entregas.map((entrega) => entrega.ordem)).toEqual([1, 2, 3])

    expect((await repo.listHandoffEnvios({ conversationId: 'conv-1' })).map((item) => item.id)).toEqual(antigo.map((item) => item.id))
    expect((await repo.listHandoffEnvios({ projectIds: ['proj-2', 'outro'] })).map((item) => item.id)).toEqual(novo.map((item) => item.id))
    expect((await repo.listHandoffEnvios({ statuses: ['enviado'] })).map((item) => item.id)).toEqual([novo[1].id])
    expect((await repo.listHandoffEnvios({ ids: [antigo[1].id, novo[0].id] })).map((item) => item.id)).toEqual([novo[0].id, antigo[1].id])
    expect((await repo.listHandoffEnvios({ limit: 3 })).map((item) => item.id)).toEqual(all.slice(0, 3).map((item) => item.id))
    expect(await repo.listHandoffEnvios({ conversationId: 'conv-2', statuses: ['na_fila'] })).toHaveLength(1)
    expect(await repo.listHandoffEnvios({ ids: [] })).toEqual([])
    expect(await repo.listHandoffEnvios({ statuses: [] })).toEqual([])
  })

  it('updateHandoffEnvio grava o patch, null limpa, atualiza updated_at e lança se não existe', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { repo } = await repository()
    vi.setSystemTime(new Date('2026-10-05T10:00:00.000Z'))
    const [created] = await repo.createHandoffEnvios([envio(1)])
    vi.setSystemTime(new Date('2026-10-05T10:05:00.000Z'))
    const updated = await repo.updateHandoffEnvio(created.id, {
      status: 'falhou',
      motivo: 'Erro: rede\u0000caiu',
      enviadoEm: '2026-10-05T07:01:00-03:00',
      atrasado: true,
      conversationTitle: 'Título novo'
    })
    expect(updated).toMatchObject({
      status: 'falhou',
      motivo: 'Erro: rede\u0000caiu',
      enviadoEm: '2026-10-05T10:01:00.000Z',
      atrasado: true,
      conversationTitle: 'Título novo',
      criadoEm: '2026-10-05T10:00:00.000Z',
      updatedAt: '2026-10-05T10:05:00.000Z'
    })
    expect(updated.entregas).toHaveLength(3)

    const cleared = await repo.updateHandoffEnvio(created.id, { motivo: null, enviadoEm: null })
    expect(cleared).toMatchObject({ motivo: null, enviadoEm: null, status: 'falhou', atrasado: true })
    await expect(repo.updateHandoffEnvio('he-nada', { status: 'enviado' })).rejects.toThrow(/inexistente/)
    await expect(repo.updateHandoffEnvio(created.id, { status: 'pronto' as never })).rejects.toThrow(/inválido/)
  })

  it('updateHandoffEntrega devolve o envio-pai com as entregas e lança se a entrega não existe', async () => {
    const { repo } = await repository()
    const [created] = await repo.createHandoffEnvios([envio(1)])
    const alvo = created.entregas[1]
    const parent = await repo.updateHandoffEntrega(alvo.id, {
      status: 'concluida',
      boardItemId: 'bi-123',
      auditada: true,
      corrigidoPor: 'usuario',
      corrigidoEm: '2026-10-05T10:00:00.000Z',
      iniciadaEm: '2026-10-05T09:00:00.000Z',
      concluidaEm: '2026-10-05T10:00:00.000Z',
      tempoCorridoMs: 3_600_000,
      estimativaAgente: 20,
      estimativaAgenteMotivo: 'mais simples do que parecia',
      estimativaAgenteEm: '2026-10-05T09:01:00.000Z',
      aviso80Em: '2026-10-05T09:30:00.000Z',
      atrasada: true,
      motivo: 'corrigido por você'
    })
    expect(parent.id).toBe(created.id)
    expect(parent.entregas.map((entrega) => entrega.id)).toEqual(created.entregas.map((entrega) => entrega.id))
    expect(parent.entregas[1]).toMatchObject({
      status: 'concluida',
      boardItemId: 'bi-123',
      auditada: true,
      corrigidoPor: 'usuario',
      tempoCorridoMs: 3_600_000,
      estimativaAgente: 20,
      estimativaAgenteMotivo: 'mais simples do que parecia',
      aviso80Em: '2026-10-05T09:30:00.000Z',
      aviso100Em: null,
      atrasada: true,
      motivo: 'corrigido por você'
    })
    // A estimativa do agente não mexe no prazo.
    expect(parent.entregas[1].estimativaPlano).toBeNull()
    expect(parent.prazoTotal).toBe(45)
    expect(parent.entregas[0].status).toBe('pendente')

    const reopened = await repo.updateHandoffEntrega(alvo.id, { status: 'pendente', concluidaEm: null, auditada: null })
    expect(reopened.entregas[1]).toMatchObject({ status: 'pendente', concluidaEm: null, auditada: null })
    await expect(repo.updateHandoffEntrega('hn-nada', { status: 'concluida' })).rejects.toThrow(/inexistente/)
  })

  it('addHandoffTime soma na linha, acumula e desfaz o lote inteiro se uma entrega não for do envio', async () => {
    const { repo } = await repository()
    const [a, b] = await repo.createHandoffEnvios([envio(1), envio(2)])
    await repo.addHandoffTime({ envioId: a.id, ativoMs: 1_000, entregas: [{ id: a.entregas[0].id, ativoMs: 1_000 }] })
    await repo.addHandoffTime({
      envioId: a.id,
      ativoMs: 2_500,
      retrabalhoMs: 700,
      entregas: [{ id: a.entregas[0].id, ativoMs: 2_500 }, { id: a.entregas[2].id, retrabalhoMs: 700 }]
    })
    let [current] = await repo.listHandoffEnvios({ ids: [a.id] })
    expect(current).toMatchObject({ tempoAtivoMs: 3_500, retrabalhoMs: 700 })
    expect(current.entregas.map((entrega) => [entrega.tempoAtivoMs, entrega.retrabalhoMs])).toEqual([
      [3_500, 0],
      [0, 0],
      [0, 700]
    ])

    await expect(
      repo.addHandoffTime({ envioId: a.id, ativoMs: 9_999, entregas: [{ id: b.entregas[0].id, ativoMs: 9_999 }] })
    ).rejects.toThrow(/não pertence/)
    await expect(repo.addHandoffTime({ envioId: 'he-nada', ativoMs: 1 })).rejects.toThrow(/inexistente/)
    await expect(repo.addHandoffTime({ envioId: a.id, ativoMs: -5 })).rejects.toThrow(/inteiro/)
    ;[current] = await repo.listHandoffEnvios({ ids: [a.id] })
    expect(current.tempoAtivoMs).toBe(3_500)
    const [other] = await repo.listHandoffEnvios({ ids: [b.id] })
    expect(other.entregas[0].tempoAtivoMs).toBe(0)
  })

  it('addHandoffTime zerado não abre escrita', async () => {
    const { repo } = await repository()
    const [created] = await repo.createHandoffEnvios([envio(1)])
    const write = vi.spyOn(repo, 'write')
    await repo.addHandoffTime({ envioId: created.id, ativoMs: 0, entregas: [{ id: created.entregas[0].id }] })
    expect(write).not.toHaveBeenCalled()
  })

  it('apagar o envio leva as entregas junto (ON DELETE CASCADE)', async () => {
    const { repo, dbPath } = await repository()
    const [a, b] = await repo.createHandoffEnvios([envio(1), envio(2)])
    repo.write((db) => db.prepare('DELETE FROM handoff_envios WHERE id = ?').run(a.id))
    expect(count(dbPath, 'handoff_entregas')).toBe(b.entregas.length)
    expect((await repo.listHandoffEnvios({})).map((item) => item.id)).toEqual([b.id])
  })

  it('o banco recusa status fora da lista e entrega sem envio', async () => {
    const { repo } = await repository()
    const [created] = await repo.createHandoffEnvios([envio(1)])
    expect(() =>
      repo.write((db) => db.prepare("UPDATE handoff_envios SET status = 'pronto' WHERE id = ?").run(created.id))
    ).toThrow(/CHECK/)
    expect(() =>
      repo.write((db) =>
        db
          .prepare(
            `INSERT INTO handoff_entregas(id, envio_id, etapa_id, etapa_titulo, ordem, status, updated_at)
             VALUES('hn-x', 'he-nada', 'e', 'E', 1, 'pendente', '2026-10-05T10:00:00.000Z')`
          )
          .run()
      )
    ).toThrow(/FOREIGN KEY/)
  })
})
