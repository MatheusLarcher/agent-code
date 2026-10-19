import { describe, expect, it } from 'vitest'
import {
  dataHoraTexto,
  frequenciaTexto,
  proximaDiaria,
  proximaExecucao,
  resumoDaConversa,
  validarTarefaAcao,
  validarTarefaNova,
  type TarefaVista
} from './tarefas'

const base = { tipo: 'lembrete', titulo: 'Renovar passaporte', convId: 'c1', cwd: 'C:\\p', agenda: { tipo: 'uma-vez', quando: '2026-10-20T09:00:00-03:00' } }

describe('validarTarefaNova — fronteira', () => {
  it('aceita lembrete e monitor bem formados', () => {
    expect(validarTarefaNova(base).ok).toBe(true)
    const monitor = { ...base, tipo: 'monitor', agenda: { tipo: 'intervalo', intervaloMin: 10 }, condicao: 'passagem < R$ 3.000', modelo: 'claude-haiku-5-5' }
    expect(validarTarefaNova(monitor)).toMatchObject({ ok: true })
  })

  it('recusa intervalo 0, data inválida, hora fora do formato e convId vazio', () => {
    const intervalo0 = validarTarefaNova({ ...base, tipo: 'monitor', condicao: 'x', agenda: { tipo: 'intervalo', intervaloMin: 0 } })
    expect(intervalo0).toMatchObject({ ok: false })
    expect(validarTarefaNova({ ...base, agenda: { tipo: 'uma-vez', quando: 'amanhã cedo' } })).toMatchObject({ ok: false, erro: expect.stringContaining('agenda.quando') })
    expect(validarTarefaNova({ ...base, agenda: { tipo: 'diario', hora: '25:00' } }).ok).toBe(false)
    expect(validarTarefaNova({ ...base, convId: '  ' })).toMatchObject({ ok: false, erro: expect.stringContaining('convId') })
  })

  it('monitor sem condição ou "uma vez" é recusado', () => {
    expect(validarTarefaNova({ ...base, tipo: 'monitor', agenda: { tipo: 'intervalo', intervaloMin: 5 } })).toMatchObject({ ok: false, erro: expect.stringContaining('condição') })
    expect(validarTarefaNova({ ...base, tipo: 'monitor', condicao: 'x' })).toMatchObject({ ok: false, erro: expect.stringContaining('recorrente') })
  })

  it('ação da bolinha: só as quatro conhecidas', () => {
    expect(validarTarefaAcao({ id: 't1', acao: 'pausar' }).ok).toBe(true)
    expect(validarTarefaAcao({ id: 't1', acao: 'apagar' }).ok).toBe(false)
    expect(validarTarefaAcao({ id: '', acao: 'visto' }).ok).toBe(false)
  })
})

describe('próxima execução (fuso de São Paulo)', () => {
  it('diário: o próximo HH:MM de São Paulo, hoje ou amanhã', () => {
    const antes = Date.parse('2026-10-19T08:00:00-03:00')
    expect(proximaDiaria('09:00', antes)).toBe(Date.parse('2026-10-19T09:00:00-03:00'))
    const depois = Date.parse('2026-10-19T09:00:00-03:00')
    expect(proximaDiaria('09:00', depois)).toBe(Date.parse('2026-10-20T09:00:00-03:00'))
    // Virada do dia em UTC (23h de SP = 02h UTC do dia seguinte).
    expect(proximaDiaria('23:30', Date.parse('2026-10-19T23:00:00-03:00'))).toBe(Date.parse('2026-10-19T23:30:00-03:00'))
  })

  it('uma vez só antes de rodar; intervalo a partir da última rodada (atrasada não acumula)', () => {
    const quando = '2026-10-20T09:00:00-03:00'
    expect(proximaExecucao({ tipo: 'uma-vez', quando }, 0, false)).toBe(Date.parse(quando))
    expect(proximaExecucao({ tipo: 'uma-vez', quando }, 0, true)).toBeNull()
    expect(proximaExecucao({ tipo: 'intervalo', intervaloMin: 10 }, 1_000_000, true)).toBe(1_000_000 + 600_000)
  })

  it('textos da frequência e da hora', () => {
    expect(frequenciaTexto({ tipo: 'intervalo', intervaloMin: 10 })).toBe('a cada 10 min')
    expect(frequenciaTexto({ tipo: 'intervalo', intervaloMin: 120 })).toBe('a cada 2 h')
    expect(frequenciaTexto({ tipo: 'diario', hora: '09:00' })).toBe('1x por dia às 09:00')
    const agora = Date.parse('2026-10-19T14:00:00-03:00')
    expect(dataHoraTexto(Date.parse('2026-10-19T14:10:00-03:00'), agora)).toBe('14:10')
    expect(dataHoraTexto(Date.parse('2026-10-20T09:00:00-03:00'), agora)).toBe('20/10 09:00')
  })
})

describe('resumoDaConversa — o estado da bolinha', () => {
  const t = (over: Partial<TarefaVista>): TarefaVista => ({
    id: 'x', tipo: 'monitor', titulo: 'T', mensagem: null, convId: 'c1', cwd: '', agenda: { tipo: 'intervalo', intervaloMin: 10 },
    estado: 'ativa', modelo: null, condicao: 'c', combinado: null, criadaPor: 'pc', criadaEm: '', atualizadaEm: '', proximaEm: null,
    ultimaEm: null, ultimoResultado: null, ultimoValor: null, avisadoValor: null, falhasSeguidas: 0, bateuNaoVistoEm: null,
    rodando: false, rodadas: [], ...over
  })

  it('sem tarefa visível → nada; bateu ganha de checando, que ganha de esperando', () => {
    expect(resumoDaConversa('c1', [t({ estado: 'cancelada' })])).toBeNull()
    expect(resumoDaConversa('c1', [t({})])?.estado).toBe('esperando')
    expect(resumoDaConversa('c1', [t({}), t({ id: 'y', rodando: true })])).toMatchObject({ estado: 'checando', total: 2, rodando: true })
    expect(resumoDaConversa('c1', [t({ rodando: true }), t({ id: 'y', bateuNaoVistoEm: '2026' })])?.estado).toBe('bateu')
  })

  it('só lembrete → âmbar; tudo pausado → cinza; outra conversa não conta', () => {
    expect(resumoDaConversa('c1', [t({ tipo: 'lembrete' })])?.estado).toBe('lembrete')
    expect(resumoDaConversa('c1', [t({ estado: 'pausada' })])?.estado).toBe('pausado')
    expect(resumoDaConversa('c2', [t({})])).toBeNull()
  })
})
