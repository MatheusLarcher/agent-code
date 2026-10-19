// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Tarefa, TarefaRodada } from '../../shared/tarefas'
import { SqliteRepository } from './sqliteRepository'
import type { TarefaCamposRodada } from './tarefaTypes'

/**
 * As tarefas agendadas contra o SQLite DE VERDADE: criar, reabrir (outro objeto
 * no mesmo arquivo), trava, fim da rodada numa transação, cancelar pela conversa.
 */

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function repo(dir?: string): Promise<{ repository: SqliteRepository; dir: string }> {
  const cache = dir ?? (await mkdtemp(join(tmpdir(), 'agent-code-tarefas-')))
  if (!dir) tempDirs.push(cache)
  const repository = new SqliteRepository(cache, join(cache, 'agent-code.db'), 'pc-a')
  await repository.initialize()
  return { repository, dir: cache }
}

const T0 = Date.parse('2026-10-19T12:00:00Z')
const tarefa = (over: Partial<Tarefa> = {}): Tarefa => ({
  id: 't1', tipo: 'monitor', titulo: 'Passagem', mensagem: null, convId: 'c1', cwd: 'C:\\p', agenda: { tipo: 'intervalo', intervaloMin: 10 },
  estado: 'ativa', modelo: 'claude-haiku-5-5', condicao: 'abaixo de R$ 3.000', combinado: 'só ler', criadaPor: 'pc-a',
  criadaEm: new Date(T0).toISOString(), atualizadaEm: new Date(T0).toISOString(), proximaEm: new Date(T0).toISOString(),
  ultimaEm: null, ultimoResultado: null, ultimoValor: null, avisadoValor: null, falhasSeguidas: 0, bateuNaoVistoEm: null, ...over
})
const campos = (agora: number, over: Partial<TarefaCamposRodada> = {}): TarefaCamposRodada => ({
  proximaEm: new Date(agora + 600_000).toISOString(), ultimaEm: new Date(agora).toISOString(), ultimoResultado: 'bateu', ultimoValor: 'R$ 2.900',
  avisadoValor: 'R$ 2.900', falhasSeguidas: 0, bateuNaoVistoEm: new Date(agora).toISOString(), concluir: false, atualizadaEm: new Date(agora).toISOString(), ...over
})
const rodada = (id: string, inicio: number): TarefaRodada => ({
  id, tarefaId: 't1', inicio: new Date(inicio).toISOString(), fim: new Date(inicio + 5_000).toISOString(), resultado: 'bateu',
  valor: 'R$ 2.900', resumo: 'Google Flights', fonte: 'https://example.com', falha: null, instalacao: 'pc-a'
})

describe('tarefas no SQLite', () => {
  it('cria, reabre o arquivo e a tarefa continua lá', async () => {
    const { repository, dir } = await repo()
    await repository.insertTarefa(tarefa())
    const { repository: reaberto } = await repo(dir)
    const lista = await reaberto.listTarefas()
    expect(lista).toHaveLength(1)
    expect(lista[0]).toMatchObject({ id: 't1', agenda: { tipo: 'intervalo', intervaloMin: 10 }, proximaEm: new Date(T0).toISOString(), leaseToken: null })
  })

  it('trava: vencida pega uma vez; outro dono não pega com ela viva; renova e solta', async () => {
    const { repository } = await repo()
    await repository.insertTarefa(tarefa())
    const claim = { id: 't1', dono: 'pc-a', token: 'k1', agora: T0 + 1_000, ttlMs: 60_000, cortesiaMs: 60_000 }
    expect(await repository.claimTarefa({ ...claim, agora: T0 - 1_000 })).toBe(false) // ainda não venceu
    expect(await repository.claimTarefa(claim)).toBe(true)
    expect(await repository.claimTarefa({ ...claim, dono: 'pc-b', token: 'k2', agora: T0 + 60_500 })).toBe(false) // cortesia passou, trava viva
    expect(await repository.renewTarefaLease('t1', 'k1', T0 + 200_000)).toBe(true)
    expect(await repository.renewTarefaLease('t1', 'outro', T0 + 200_000)).toBe(false)
    await repository.releaseTarefaLease('t1', 'k1')
    // Quem não criou só pega depois da cortesia.
    expect(await repository.claimTarefa({ ...claim, dono: 'pc-b', token: 'k3', agora: T0 + 30_000 })).toBe(false)
    expect(await repository.claimTarefa({ ...claim, dono: 'pc-b', token: 'k3', agora: T0 + 61_000 })).toBe(true)
  })

  it('fim da rodada: rodada + tarefa + trava solta numa escrita; rodada mais velha não passa por cima', async () => {
    const { repository } = await repo()
    await repository.insertTarefa(tarefa())
    await repository.claimTarefa({ id: 't1', dono: 'pc-a', token: 'k1', agora: T0, ttlMs: 60_000, cortesiaMs: 0 })
    const fim = T0 + 5_000
    expect(await repository.finishTarefaRodada({ id: 't1', token: 'k1', inicio: T0, agora: fim, rodadas: [rodada('r1', T0)], campos: campos(fim), guardar: 30 })).toBe(true)
    const [t] = await repository.listTarefas()
    expect(t).toMatchObject({ ultimoResultado: 'bateu', ultimoValor: 'R$ 2.900', proximaEm: new Date(fim + 600_000).toISOString(), leaseToken: null })
    expect(await repository.listTarefaRodadas(['t1'], 10)).toEqual([rodada('r1', T0)])
    // Uma rodada que começou ANTES da gravada (PC que voltou da queda) é descartada.
    expect(await repository.finishTarefaRodada({ id: 't1', token: 'velho', inicio: T0 - 60_000, agora: fim, rodadas: [rodada('r0', T0 - 60_000)], campos: campos(fim), guardar: 30 })).toBe(false)
    expect(await repository.listTarefaRodadas(['t1'], 10)).toHaveLength(1)
  })

  it('poda as rodadas além de "guardar"; lembrete "uma vez" conclui e sai da lista', async () => {
    const { repository } = await repo()
    await repository.insertTarefa(tarefa())
    for (let i = 0; i < 4; i++) {
      const inicio = T0 + i * 1_000_000
      await repository.finishTarefaRodada({ id: 't1', token: `k${i}`, inicio, agora: inicio + 5_000, rodadas: [rodada(`r${i}`, inicio)], campos: campos(inicio + 5_000), guardar: 2 })
    }
    expect((await repository.listTarefaRodadas(['t1'], 10)).map((r) => r.id)).toEqual(['r3', 'r2'])
    await repository.insertTarefa(tarefa({ id: 't2', tipo: 'lembrete', agenda: { tipo: 'uma-vez', quando: new Date(T0).toISOString() } }))
    await repository.finishTarefaRodada({ id: 't2', token: 'x', inicio: T0, agora: T0, rodadas: [], campos: campos(T0, { proximaEm: null, concluir: true }), guardar: 30 })
    expect((await repository.listTarefas()).map((t) => t.id)).toEqual(['t1'])
  })

  it('pausar, visto e conversa apagada cancela as dela', async () => {
    const { repository } = await repo()
    await repository.insertTarefa(tarefa({ bateuNaoVistoEm: new Date(T0).toISOString() }))
    await repository.insertTarefa(tarefa({ id: 't2', convId: 'c2' }))
    expect(await repository.updateTarefaEstado({ id: 't1', estado: 'pausada', proximaEm: null, atualizadaEm: new Date(T0).toISOString() })).toBe(true)
    await repository.marcarTarefaVista('t1', new Date(T0).toISOString())
    expect((await repository.listTarefas()).find((t) => t.id === 't1')).toMatchObject({ estado: 'pausada', proximaEm: null, bateuNaoVistoEm: null })
    expect(await repository.cancelTarefasDaConversa('c1', new Date(T0).toISOString())).toBe(1)
    expect((await repository.listTarefas()).map((t) => t.id)).toEqual(['t2'])
  })
})
