import { describe, expect, it } from 'vitest'
import { entrega, envio } from '../handoffTracking/handoffFixtures'
import {
  filterCounts,
  matchesSearch,
  needsUserCount,
  normSearch,
  projectName,
  sortEnvios,
  visibleEnvios
} from './deliveryModel'

const at = (min: number): string => new Date(Date.UTC(2026, 9, 5, 12, min)).toISOString()

describe('deliveryModel — contador do que precisa de você', () => {
  it('conta aguardando você + incompleta + parada + atrasada, uma vez por envio', () => {
    const list = [
      envio({ id: 'a', status: 'aguardando_voce' }),
      envio({ id: 'b', status: 'incompleta' }),
      envio({ id: 'c', status: 'parada' }),
      envio({ id: 'd', status: 'em_execucao', atrasado: true }),
      // atrasado E incompleto: um envio só
      envio({ id: 'e', status: 'incompleta', atrasado: true }),
      // a marca numa entrega também é atraso do envio
      envio({ id: 'f', status: 'em_execucao', entregas: [entrega({ atrasada: true })] }),
      // não contam: em execução no prazo, concluído (mesmo com atraso), na fila, falhou
      envio({ id: 'g', status: 'em_execucao' }),
      envio({ id: 'h', status: 'concluida', atrasado: true }),
      envio({ id: 'i', status: 'na_fila' }),
      envio({ id: 'j', status: 'falhou' })
    ]
    expect(needsUserCount(list)).toBe(6)
    expect(needsUserCount(null)).toBe(0)
  })
})

describe('deliveryModel — ordem', () => {
  it('uma posição por status, mesmo quando os horários dizem o contrário', () => {
    // Quanto mais para baixo na ordem esperada, MAIS recente: só a posição do
    // status pode pôr "aguardando você" (o mais antigo) no topo.
    const list = [
      envio({ id: 'concluida', status: 'concluida', updatedAt: at(9) }),
      envio({ id: 'execucao', status: 'em_execucao', updatedAt: at(6) }),
      envio({ id: 'fila', status: 'na_fila', updatedAt: at(8) }),
      envio({ id: 'atrasada', status: 'em_execucao', atrasado: true, updatedAt: at(5) }),
      envio({ id: 'parada', status: 'parada', updatedAt: at(3) }),
      envio({ id: 'enviado', status: 'enviado', updatedAt: at(7) }),
      envio({ id: 'incompleta', status: 'incompleta', updatedAt: at(2) }),
      envio({ id: 'aguardando', status: 'aguardando_voce', updatedAt: at(1) }),
      envio({ id: 'falhou', status: 'falhou', updatedAt: at(4) })
    ]
    expect(sortEnvios(list).map((e) => e.id)).toEqual([
      'aguardando',
      'incompleta',
      'parada',
      'falhou',
      'atrasada',
      'execucao',
      'enviado',
      'fila',
      'concluida'
    ])
  })

  it('dentro do mesmo status, o mais recente primeiro', () => {
    const list = [
      envio({ id: 'parada-velha', status: 'parada', updatedAt: at(1) }),
      envio({ id: 'aguardando-velho', status: 'aguardando_voce', updatedAt: at(0) }),
      envio({ id: 'parada-nova', status: 'parada', updatedAt: at(9) }),
      envio({ id: 'aguardando-novo', status: 'aguardando_voce', updatedAt: at(8) }),
      // Concluída com atraso não volta para a faixa "atrasada".
      envio({ id: 'concluida-atrasada', status: 'concluida', atrasado: true, updatedAt: at(7) }),
      envio({ id: 'concluida', status: 'concluida', updatedAt: at(2) })
    ]
    expect(sortEnvios(list).map((e) => e.id)).toEqual([
      'aguardando-novo',
      'aguardando-velho',
      'parada-nova',
      'parada-velha',
      'concluida-atrasada',
      'concluida'
    ])
  })
})

describe('deliveryModel — filtros', () => {
  const list = [
    envio({ id: 'a', status: 'aguardando_voce' }),
    envio({ id: 'b', status: 'incompleta' }),
    envio({ id: 'c', status: 'parada' }),
    envio({ id: 'd', status: 'em_execucao', atrasado: true }),
    envio({ id: 'e', status: 'em_execucao' }),
    envio({ id: 'f', status: 'concluida', atrasado: true }),
    envio({ id: 'g', status: 'concluida' })
  ]
  it.each([
    ['incompleta', ['b']],
    ['parada', ['c']],
    ['atrasada', ['d', 'f']],
    ['aguardando_voce', ['a']],
    ['em_execucao', ['d', 'e']],
    ['concluida', ['f', 'g']]
  ] as const)('%s', (filter, ids) => {
    expect(visibleEnvios(list, filter, '').map((e) => e.id).sort()).toEqual([...ids].sort())
  })

  it('sem filtro, todos; os contadores dos filtros respeitam a busca', () => {
    expect(visibleEnvios(list, null, '')).toHaveLength(list.length)
    expect(filterCounts(list, '')).toEqual({ aguardando_voce: 1, incompleta: 1, parada: 1, atrasada: 2, em_execucao: 2, concluida: 2 })
    expect(filterCounts(list, 'nada disso')).toEqual({ aguardando_voce: 0, incompleta: 0, parada: 0, atrasada: 0, em_execucao: 0, concluida: 0 })
  })
})

describe('deliveryModel — busca sem maiúsculas e sem acentos, nos dois sentidos', () => {
  it('normaliza com NFD, tira os diacríticos e põe em minúsculas', () => {
    expect(normSearch('  Pá DE Cal  ')).toBe('pa de cal')
    expect(normSearch(null)).toBe('')
  })

  it('"pa" acha "pá" e "pá" acha "pa"', () => {
    const comAcento = envio({ id: 'acento', planTitulo: 'Pá de cal' })
    const semAcento = envio({ id: 'sem', planTitulo: 'Painel novo' })
    expect(matchesSearch(comAcento, 'pa')).toBe(true)
    expect(matchesSearch(semAcento, 'pá')).toBe(true)
    expect(matchesSearch(semAcento, 'PÁ')).toBe(true)
  })

  it('procura no projeto, no plano, na conversa e nos títulos das etapas', () => {
    const e = envio({
      projectCwd: 'C:\\GitHub\\Coração',
      planTitulo: 'Checkout',
      planSlug: 'checkout',
      conversationTitle: 'Implementação: pagamento',
      entregas: [entrega({ etapaTitulo: 'Validação do cartão' })]
    })
    expect(matchesSearch(e, 'coracao')).toBe(true)
    expect(matchesSearch(e, 'CHECK')).toBe(true)
    expect(matchesSearch(e, 'implementacao')).toBe(true)
    expect(matchesSearch(e, 'validação')).toBe(true)
    expect(matchesSearch(e, 'boleto')).toBe(false)
    expect(matchesSearch(e, '   ')).toBe(true)
  })

  it('o nome do projeto é o da pasta, com barra de qualquer lado', () => {
    expect(projectName('C:\\GitHub\\agent-code\\')).toBe('agent-code')
    expect(projectName('/home/eu/loja')).toBe('loja')
  })
})
