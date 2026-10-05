import { describe, expect, it } from 'vitest'
import { currentEntrega, currentEnvio, deadlineLevel, tempoAtivoMinutos, withinDeadline } from '@shared/handoffTracking'
import { deadlineView } from './deadlineView'
import { entrega, envio, MIN, running } from './handoffFixtures'

describe('regras compartilhadas do prazo (shared/handoffTracking)', () => {
  it('deadlineLevel: ok < 80% ≤ alerta ≤ 100% < estourado; sem prazo, neutro', () => {
    expect(deadlineLevel(0, 30)).toBe('ok')
    expect(deadlineLevel(24 * MIN - 1, 30)).toBe('ok')
    expect(deadlineLevel(24 * MIN, 30)).toBe('alerta') // 80% em ponto
    expect(deadlineLevel(30 * MIN, 30)).toBe('alerta') // no prazo ainda é dentro
    expect(deadlineLevel(30 * MIN + 1, 30)).toBe('estourado')
    expect(deadlineLevel(99 * MIN, null)).toBe('neutro')
    expect(deadlineLevel(5 * MIN, 0)).toBe('neutro')
  })

  it('minutos para cima, que nunca discordam de dentro/fora do prazo', () => {
    expect(tempoAtivoMinutos(0)).toBe(0)
    expect(tempoAtivoMinutos(1)).toBe(1)
    expect(tempoAtivoMinutos(30 * MIN)).toBe(30)
    expect(tempoAtivoMinutos(30 * MIN + 1)).toBe(31)
    expect(withinDeadline(30 * MIN, 30)).toBe(true)
    expect(withinDeadline(30 * MIN + 1, 30)).toBe(false)
    expect(withinDeadline(1, null)).toBeNull()
  })

  it('envio corrente = o mais recente já enviado; etapa atual = a em andamento, senão a primeira não concluída', () => {
    const fila = envio({ id: 'he-2', ordem: 2, status: 'na_fila', enviadoEm: null, criadoEm: '2026-10-05T13:00:00.000Z' })
    const atual = envio({ id: 'he-1' })
    expect(currentEnvio([fila, atual])?.id).toBe('he-1')
    expect(currentEnvio([fila])).toBeNull()
    const a = entrega({ etapaId: 'a', ordem: 1, status: 'concluida' })
    const b = entrega({ etapaId: 'b', ordem: 2, status: 'pendente' })
    const c = entrega({ etapaId: 'c', ordem: 3, status: 'em_andamento' })
    expect(currentEntrega(envio({ entregas: [c, b, a] }))?.etapaId).toBe('c')
    expect(currentEntrega(envio({ entregas: [b, a] }))?.etapaId).toBe('b')
    expect(currentEntrega(envio({ entregas: [a] }))).toBeNull()
    expect(currentEntrega(null)).toBeNull()
  })
})

describe('deadlineView', () => {
  it('etapa atual, tempo ativo contra o prazo e a estimativa do agente, do banco', () => {
    const view = deadlineView({ envios: [running(12 * MIN)], error: null })
    expect(view).toMatchObject({ level: 'ok', etapa: 'Etapa 1/2: Registro no banco', tempo: '12 de 30 min', agente: 'agente 20 min' })
    expect(view?.title).toContain('Prazo (estimativa do plano): 30 min.')
    expect(view?.title).toContain('Estimativa do agente: 20 min — dois backends.')
    expect(view?.title).toContain('Tempo ativo: 12 min (40% do prazo — dentro do prazo).')
  })

  it('a cor muda em 80% e ao passar de 100%', () => {
    expect(deadlineView({ envios: [running(23 * MIN)], error: null })?.level).toBe('ok')
    expect(deadlineView({ envios: [running(24 * MIN)], error: null })?.level).toBe('alerta')
    expect(deadlineView({ envios: [running(30 * MIN)], error: null })?.level).toBe('alerta')
    const over = deadlineView({ envios: [running(31 * MIN)], error: null })
    expect(over).toMatchObject({ level: 'estourado', tempo: '31 de 30 min' })
    expect(over?.title).toContain('(103% do prazo — fora do prazo)')
  })

  it('estados neutros: carregando (nada), erro, sem envio, sem etapas, etapa sem estimativa do plano', () => {
    expect(deadlineView({ envios: null, error: null })).toBeNull()
    expect(deadlineView({ envios: null, error: 'banco fora do ar' })).toMatchObject({ level: 'neutro', tempo: 'prazo indisponível' })
    expect(deadlineView({ envios: [], error: null })).toMatchObject({ level: 'neutro', tempo: 'sem prazo', etapa: null })
    expect(deadlineView({ envios: [envio({ entregas: [] })], error: null })).toMatchObject({ level: 'neutro', tempo: 'sem prazo' })
    const semPrazo = deadlineView({ envios: [running(7 * MIN, { estimativaPlano: null, estimativaAgente: null })], error: null })
    expect(semPrazo).toMatchObject({ level: 'neutro', tempo: '7 min · sem prazo', agente: 'agente: sem estimativa' })
  })

  it('todas as etapas concluídas: o prompt inteiro contra a soma dos prazos', () => {
    const done = envio({
      status: 'concluida',
      prazoTotal: 30,
      tempoAtivoMs: 26 * MIN,
      entregas: [entrega({ status: 'concluida', tempoAtivoMs: 26 * MIN })]
    })
    expect(deadlineView({ envios: [done], error: null })).toMatchObject({ level: 'alerta', etapa: 'Etapas concluídas', tempo: '26 de 30 min', agente: null })
  })
})
