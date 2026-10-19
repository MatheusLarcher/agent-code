// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContextoRodada, Executor } from './agendador'
import type { AvisoTarefa, MensagemTarefa, ResultadoRodada } from './regras'
import { TarefasServico } from './servico'
import { MemoriaTarefaRepo } from './tarefasTestKit'

/**
 * O agendador com relógio falso (fake timers do vitest): próxima execução por
 * tipo de agenda, vencida roda UMA vez, pausar/retomar/cancelar, dois PCs no
 * mesmo banco (só um roda) e perda da trava (para).
 */

const T0 = Date.parse('2026-10-19T12:00:00-03:00')
const MIN = 60_000

type Mundo = { servico: TarefasServico; avisos: AvisoTarefa[]; mensagens: MensagemTarefa[]; monitor: ReturnType<typeof vi.fn> }

function mundo(repo: MemoriaTarefaRepo, instalacao = 'pc-a', monitor: Executor = async () => ({ resultado: 'nao-bateu' })): Mundo {
  const avisos: AvisoTarefa[] = []
  const mensagens: MensagemTarefa[] = []
  const fn = vi.fn(monitor)
  const servico = new TarefasServico({
    repository: () => repo,
    instalacao: () => instalacao,
    executarMonitor: fn,
    avisar: (a) => avisos.push(a),
    mensagem: (m) => mensagens.push(m)
  })
  return { servico, avisos, mensagens, monitor: fn }
}

const servicos: TarefasServico[] = []
beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
})
afterEach(() => {
  for (const s of servicos.splice(0)) s.parar()
  vi.useRealTimers()
})

function ligar(m: Mundo): Mundo {
  servicos.push(m.servico)
  m.servico.iniciar()
  return m
}

const lembrete = (agenda: unknown, extra: object = {}) => ({ tipo: 'lembrete', titulo: 'Renovar passaporte', convId: 'c1', cwd: 'C:\\p', agenda, ...extra })
const monitor = (intervaloMin: number) => ({ tipo: 'monitor', titulo: 'Passagem', condicao: 'abaixo de R$ 3.000', convId: 'c1', cwd: 'C:\\p', agenda: { tipo: 'intervalo', intervaloMin } })

describe('agendador — próxima execução e disparo', () => {
  it('lembrete "uma vez" dispara no horário, conclui e some; não dispara de novo', async () => {
    const repo = new MemoriaTarefaRepo()
    const m = ligar(mundo(repo))
    await vi.advanceTimersByTimeAsync(10)
    const r = m.servico.criar(lembrete({ tipo: 'uma-vez', quando: new Date(T0 + MIN).toISOString() }))
    expect(r.ok).toBe(true)
    await vi.advanceTimersByTimeAsync(55_000)
    expect(m.avisos).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(m.avisos).toEqual([expect.objectContaining({ tipo: 'lembrete', convId: 'c1', titulo: 'Renovar passaporte' })])
    expect(m.servico.vistas('c1')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(m.avisos).toHaveLength(1)
    expect([...repo.tarefas.values()][0]).toMatchObject({ estado: 'concluida', leaseToken: null })
  })

  it('monitor de intervalo: checa já ao criar e depois a cada N min', async () => {
    const repo = new MemoriaTarefaRepo()
    const m = ligar(mundo(repo))
    await vi.advanceTimersByTimeAsync(10)
    m.servico.criar(monitor(10))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(m.monitor).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(9 * MIN)
    expect(m.monitor).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(MIN + 1_000)
    expect(m.monitor).toHaveBeenCalledTimes(2)
    expect(repo.rodadas.map((r) => r.resultado)).toEqual(['nao-bateu', 'nao-bateu'])
  })

  it('diário: dispara no próximo HH:MM de São Paulo', async () => {
    const repo = new MemoriaTarefaRepo()
    const m = ligar(mundo(repo))
    await vi.advanceTimersByTimeAsync(10)
    m.servico.criar(lembrete({ tipo: 'diario', hora: '13:00' }))
    expect(m.servico.vistas('c1')[0].proximaEm).toBe(new Date(T0 + 60 * MIN).toISOString())
    await vi.advanceTimersByTimeAsync(59 * MIN)
    expect(m.avisos).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(m.avisos).toHaveLength(1)
    expect(m.servico.vistas('c1')[0].proximaEm).toBe(new Date(T0 + 25 * 60 * MIN).toISOString())
  })

  it('vencida enquanto o app estava fechado roda UMA vez (lembrete "(atrasado)") e a próxima sai de agora', async () => {
    const repo = new MemoriaTarefaRepo()
    const antes = mundo(repo)
    antes.servico.criar(lembrete({ tipo: 'intervalo', intervaloMin: 10 }))
    await antes.servico.flush(1_000)
    // App fechado por 2 h: 12 horários perdidos.
    vi.setSystemTime(T0 + 120 * MIN)
    const m = ligar(mundo(repo))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(m.avisos).toEqual([expect.objectContaining({ titulo: 'Renovar passaporte (atrasado)' })])
    expect(Date.parse(m.servico.vistas('c1')[0].proximaEm!)).toBeGreaterThanOrEqual(T0 + 130 * MIN)
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(m.avisos).toHaveLength(1)
  })
})

describe('agendador — pausar, retomar, cancelar', () => {
  it('pausada não roda; retomada checa já; cancelada sai da bolinha e do banco', async () => {
    const repo = new MemoriaTarefaRepo()
    const m = ligar(mundo(repo))
    await vi.advanceTimersByTimeAsync(10)
    const criado = m.servico.criar(monitor(5))
    if (!criado.ok) throw new Error(criado.erro)
    const id = criado.valor.id
    await vi.advanceTimersByTimeAsync(1_000)
    expect(m.monitor).toHaveBeenCalledTimes(1)
    expect(m.servico.acao({ id, acao: 'pausar' })).toMatchObject({ ok: true, valor: { estado: 'pausada' } })
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(m.monitor).toHaveBeenCalledTimes(1)
    expect(m.servico.acao({ id, acao: 'retomar' }).ok).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(m.monitor).toHaveBeenCalledTimes(2)
    expect(m.servico.acao({ id, acao: 'cancelar' })).toEqual({ ok: true, valor: null })
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(m.monitor).toHaveBeenCalledTimes(2)
    expect(m.servico.vistas()).toHaveLength(0)
    expect(repo.tarefas.get(id)?.estado).toBe('cancelada')
    expect(m.servico.acao({ id, acao: 'pausar' }).ok).toBe(false)
  })

  it('cancelar com a rodada no meio aborta e não grava; conversa apagada cancela as dela', async () => {
    const repo = new MemoriaTarefaRepo()
    let sinal: AbortSignal | null = null
    const m = ligar(mundo(repo, 'pc-a', (_t, ctx: ContextoRodada) => {
      sinal = ctx.signal
      return new Promise<ResultadoRodada>((resolve) => ctx.signal.addEventListener('abort', () => resolve({ resultado: 'falha', falha: 'abortada' })))
    }))
    await vi.advanceTimersByTimeAsync(10)
    const criado = m.servico.criar(monitor(10))
    if (!criado.ok) throw new Error(criado.erro)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(m.servico.vistas('c1')[0].rodando).toBe(true)
    m.servico.conversaApagada('c1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sinal!.aborted).toBe(true)
    expect(repo.rodadas).toHaveLength(0)
    expect(repo.tarefas.get(criado.valor.id)).toMatchObject({ estado: 'cancelada', leaseToken: null })
  })
})

describe('agendador — trava entre PCs', () => {
  it('dois PCs no mesmo banco: a mesma tarefa roda num só por horário', async () => {
    const repo = new MemoriaTarefaRepo()
    const a = mundo(repo, 'pc-a')
    a.servico.criar(monitor(10))
    await a.servico.flush(1_000)
    const b = ligar(mundo(repo, 'pc-b'))
    ligar(a)
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(10 * MIN)
    // A criadora roda sempre na hora; a outra só assumiria depois da cortesia.
    expect(b.monitor).not.toHaveBeenCalled()
    expect(a.monitor.mock.calls.length).toBeGreaterThanOrEqual(6)
    // A criadora para (PC desligado): a outra assume depois da cortesia.
    a.servico.parar()
    const antes = a.monitor.mock.calls.length
    await vi.advanceTimersByTimeAsync(15 * MIN)
    expect(a.monitor.mock.calls.length).toBe(antes)
    expect(b.monitor.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(repo.rodadas.length).toBe(antes + b.monitor.mock.calls.length)
  })

  it('perdeu a trava no meio (outro PC assumiu): aborta e não grava nem avisa', async () => {
    const repo = new MemoriaTarefaRepo()
    let sinal: AbortSignal | null = null
    const m = ligar(mundo(repo, 'pc-a', (_t, ctx) => {
      sinal = ctx.signal
      return new Promise<ResultadoRodada>((resolve) => ctx.signal.addEventListener('abort', () => resolve({ resultado: 'bateu', valor: 'R$ 1' })))
    }))
    await vi.advanceTimersByTimeAsync(10)
    const criado = m.servico.criar(monitor(10))
    if (!criado.ok) throw new Error(criado.erro)
    await vi.advanceTimersByTimeAsync(1_000)
    repo.roubarTrava(criado.valor.id, 'pc-b')
    await vi.advanceTimersByTimeAsync(21_000)
    expect(sinal!.aborted).toBe(true)
    expect(repo.rodadas).toHaveLength(0)
    expect(m.avisos).toHaveLength(0)
  })

  it('banco caído no fim da rodada: avisa, guarda na memória e regrava quando volta', async () => {
    const repo = new MemoriaTarefaRepo()
    const m = ligar(mundo(repo, 'pc-a', async () => {
      repo.offline = true
      return { resultado: 'bateu', valor: 'R$ 2.900', resumo: 'Google Flights' }
    }))
    await vi.advanceTimersByTimeAsync(10)
    m.servico.criar(monitor(10))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(m.avisos).toEqual([expect.objectContaining({ tipo: 'bateu', texto: 'R$ 2.900 — Google Flights' })])
    expect(m.mensagens).toHaveLength(1)
    expect(repo.rodadas).toHaveLength(0)
    repo.offline = false
    await vi.advanceTimersByTimeAsync(40_000)
    expect(repo.rodadas.map((r) => r.resultado)).toEqual(['bateu'])
  })
})
