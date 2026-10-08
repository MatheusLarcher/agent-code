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
    expect(view).toMatchObject({ level: 'ok', etapa: 'Etapa 1 de 2: Registro no banco', tempo: '12 de 30 min', agente: 'agente 20 min' })
    expect(view?.title).toContain('Etapa atual: Etapa 1 de 2: Registro no banco [registro-no-banco] — em andamento.')
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

  describe('"Etapa N de M" é a posição no PLANO (planProgress/stepLabel), não no prompt', () => {
    // O plano mandado em partes: a parte 1 (banco, tela) já saiu, de outra conversa; esta conversa faz a parte 2.
    const parte1 = envio({
      id: 'he-0', conversationId: 'conv-0', status: 'concluida', loteId: 'hl-0', criadoEm: '2026-10-05T11:00:00.000Z', enviadoEm: '2026-10-05T11:00:00.000Z',
      entregas: [entrega({ etapaId: 'banco', etapaTitulo: 'Banco', status: 'concluida' }), entrega({ etapaId: 'tela', etapaTitulo: 'Tela', ordem: 2, status: 'concluida' })]
    })
    const parte2 = envio({
      id: 'he-1', estimativaTotal: 50, prazoTotal: 50,
      entregas: [
        entrega({ etapaId: 'pix', etapaTitulo: 'Pix', status: 'em_andamento', tempoAtivoMs: 6 * MIN }),
        entrega({ etapaId: 'aceite', etapaTitulo: 'Aceite', ordem: 2, estimativaPlano: 20 })
      ]
    })
    const roteiro = [
      { id: 'banco', titulo: 'Banco' },
      { id: 'tela', titulo: 'Tela' },
      { id: 'pix', titulo: 'Pix' },
      { id: 'aceite', titulo: 'Aceite' },
      { id: 'deploy', titulo: 'Deploy' }
    ]

    it('com os envios do plano no projeto (de qualquer conversa): a 1ª etapa deste prompt é a 3ª do plano', () => {
      const view = deadlineView({ envios: [parte2], error: null }, { envios: [parte1, parte2], roteiro: null })
      expect(view).toMatchObject({ etapa: 'Etapa 3 de 4: Pix', tempo: '6 de 30 min' })
    })

    it('com o roteiro: o total é o do plano (etapas ainda não enviadas contam)', () => {
      expect(deadlineView({ envios: [parte2], error: null }, { envios: [parte1, parte2], roteiro })?.etapa).toBe('Etapa 3 de 5: Pix')
      // Os envios do plano ainda não chegaram: o roteiro já dá a posição.
      expect(deadlineView({ envios: [parte2], error: null }, { envios: null, roteiro })?.etapa).toBe('Etapa 3 de 5: Pix')
    })

    it('a leitura do plano ainda sem o envio desta conversa (lida antes do registro): os desta conversa entram na conta', () => {
      expect(deadlineView({ envios: [parte2], error: null }, { envios: [parte1], roteiro: null })?.etapa).toBe('Etapa 3 de 4: Pix')
    })

    it('envios de outro plano ou de outro projeto não entram na conta', () => {
      const outro = envio({ id: 'x', planSlug: 'login', entregas: [entrega({ etapaId: 'x1' }), entrega({ etapaId: 'x2', ordem: 2 })] })
      const fora = envio({ id: 'y', projectCwd: 'D:/outro', entregas: [entrega({ etapaId: 'y1' })] })
      expect(deadlineView({ envios: [parte2], error: null }, { envios: [outro, fora, parte2], roteiro: null })?.etapa).toBe('Etapa 1 de 2: Pix')
    })
  })
})
