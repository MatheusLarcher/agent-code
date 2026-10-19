// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContextoRodada, Executor } from './agendador'
import type { AvisoTarefa, MensagemTarefa, ResultadoRodada } from './regras'
import { TarefasServico } from './servico'
import { MemoriaTarefaRepo } from './tarefasTestKit'

/**
 * O monitor no agendador com consulta falsa: avisa só quando bate (sem repetir o
 * valor), 3 falhas viram UM aviso, "precisa de você" tem aviso próprio, a
 * sobreposição é pulada e registrada, o prazo aborta e libera a vaga (teto de 2),
 * e 20 rodadas seguidas não acumulam nada.
 */

const T0 = Date.parse('2026-10-19T12:00:00-03:00')
const MIN = 60_000

let servico: TarefasServico
let repo: MemoriaTarefaRepo
let avisos: AvisoTarefa[]
let mensagens: MensagemTarefa[]

function ligar(executor: Executor): void {
  repo = new MemoriaTarefaRepo()
  avisos = []
  mensagens = []
  servico = new TarefasServico({
    repository: () => repo,
    instalacao: () => 'pc-a',
    executarMonitor: executor,
    avisar: (a) => avisos.push(a),
    mensagem: (m) => mensagens.push(m)
  })
  servico.iniciar()
}

const monitor = (intervaloMin: number, titulo = 'Passagem') =>
  servico.criar({ tipo: 'monitor', titulo, condicao: 'abaixo de R$ 3.000', convId: 'c1', cwd: 'C:\\p', agenda: { tipo: 'intervalo', intervaloMin } })

beforeEach(() => vi.useFakeTimers({ now: T0 }))
afterEach(() => {
  servico?.parar()
  vi.useRealTimers()
})

/** Executor que devolve um roteiro de resultados, um por rodada. */
const roteiro = (...resultados: ResultadoRodada[]): Executor => {
  let i = 0
  return async () => resultados[Math.min(i++, resultados.length - 1)]
}

describe('monitor — quando avisa', () => {
  it('bateu → 1 aviso + 1 mensagem; o mesmo valor não avisa de novo; saiu e voltou avisa', async () => {
    ligar(roteiro(
      { resultado: 'bateu', valor: 'R$ 2.900', fonte: 'https://x' },
      { resultado: 'bateu', valor: 'R$ 2.900' },
      { resultado: 'nao-bateu', valor: 'R$ 3.100' },
      { resultado: 'bateu', valor: 'R$ 2.900' }
    ))
    await vi.advanceTimersByTimeAsync(10)
    monitor(10)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(avisos.map((a) => a.tipo)).toEqual(['bateu'])
    expect(mensagens).toEqual([expect.objectContaining({ convId: 'c1', valor: 'R$ 2.900', fonte: 'https://x', hora: '12:00' })])
    expect(servico.vistas('c1')[0].bateuNaoVistoEm).not.toBeNull()
    await vi.advanceTimersByTimeAsync(10 * MIN + 1_000)
    expect(avisos).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(20 * MIN + 2_000)
    expect(avisos.map((a) => a.tipo)).toEqual(['bateu', 'bateu'])
    expect(mensagens).toHaveLength(2)
  })

  it('não bateu → nada; 3 falhas seguidas → UM aviso com o motivo; "precisa de você" avisa uma vez', async () => {
    ligar(roteiro(
      { resultado: 'nao-bateu', valor: 'R$ 3.400' },
      { resultado: 'falha', falha: 'site fora do ar' },
      { resultado: 'falha', falha: 'site fora do ar' },
      { resultado: 'falha', falha: 'site fora do ar' },
      { resultado: 'falha', falha: 'site fora do ar' },
      { resultado: 'precisa-de-voce', resumo: 'pede login' },
      { resultado: 'precisa-de-voce', resumo: 'pede login' }
    ))
    await vi.advanceTimersByTimeAsync(10)
    monitor(10)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(avisos).toHaveLength(0)
    // As falhas tentam de novo em 3 min (menos que o intervalo).
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(10 * MIN + 1_000)
    expect(avisos).toEqual([expect.objectContaining({ tipo: 'falhas', texto: 'site fora do ar' })])
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(10 * MIN + 1_000)
    expect(avisos.map((a) => a.tipo)).toEqual(['falhas', 'precisa'])
  })
})

describe('monitor — sobreposição, prazo e vagas', () => {
  it('a seguinte chegou com a anterior rodando: pula e registra; o prazo vira falha', async () => {
    // Ignora o abort de propósito e só termina depois de 2 intervalos.
    ligar(() => new Promise<ResultadoRodada>((resolve) => setTimeout(() => resolve({ resultado: 'nao-bateu' }), 2 * MIN + 30_000)))
    await vi.advanceTimersByTimeAsync(10)
    monitor(1)
    await vi.advanceTimersByTimeAsync(3 * MIN)
    expect(repo.rodadas.map((r) => r.resultado)).toEqual(['falha', 'pulada'])
    expect(repo.rodadas[0].falha).toMatch(/passou de 1 min/)
  })

  it('no máximo 2 monitores juntos; o prazo aborta e libera a vaga para o terceiro', async () => {
    const sinais: AbortSignal[] = []
    ligar((_t, ctx: ContextoRodada) => {
      sinais.push(ctx.signal)
      return new Promise<ResultadoRodada>((resolve) => ctx.signal.addEventListener('abort', () => resolve({ resultado: 'falha', falha: 'abortada' })))
    })
    await vi.advanceTimersByTimeAsync(10)
    monitor(1, 'A')
    monitor(1, 'B')
    monitor(1, 'C')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(sinais).toHaveLength(2)
    expect(servico.vistas().filter((t) => t.rodando)).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(MIN)
    expect(sinais.slice(0, 2).every((s) => s.aborted)).toBe(true)
    expect(sinais.length).toBeGreaterThanOrEqual(3)
    expect(servico.agendador.monitoresRodando()).toBeLessThanOrEqual(2)
  })

  it('20 rodadas seguidas: nada acumula (rodadas na memória com teto, sem rodada pendurada)', async () => {
    let n = 0
    ligar(async () => ({ resultado: 'nao-bateu', valor: `R$ ${3_000 + n++}` }))
    await vi.advanceTimersByTimeAsync(10)
    monitor(1)
    const antes = process.memoryUsage().heapUsed
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(MIN + 500)
    expect(n).toBeGreaterThanOrEqual(20)
    const [t] = servico.vistas('c1')
    expect(t.rodadas.length).toBeLessThanOrEqual(10)
    expect(servico.agendador.monitoresRodando()).toBe(0)
    expect(servico.store.pendentes()).toBe(0)
    // Folga larga: o que se mede é "não cresce por rodada", não o heap exato.
    expect(process.memoryUsage().heapUsed - antes).toBeLessThan(40 * 1024 * 1024)
  })
})
