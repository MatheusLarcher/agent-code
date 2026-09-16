import { describe, it, expect } from 'vitest'
import {
  buildCrew,
  buildLanes,
  callSegments,
  lineText,
  roleFromSubagentType,
  workingMembers,
  type CrewInput,
  type CrewMember
} from './crew'
import type { AgentTrack } from './agentTracks'
import type { MemoristaProviderDiagnosticMsg, PoProviderDiagnosticMsg } from '@shared/ipc'

const T = 1_700_000_000_000

function track(over: Partial<AgentTrack> = {}): AgentTrack {
  return {
    id: 't1',
    label: 'executor: fazer',
    subagentType: 'executor',
    status: 'running',
    startedAt: T - 60_000,
    stepCount: 3,
    steps: [{ id: 's1', name: 'Bash', input: { command: 'npm test' }, startedAt: T - 10_000 }],
    ...over
  }
}

function input(over: Partial<CrewInput> = {}): CrewInput {
  return {
    tracks: {},
    busy: false,
    busySince: null,
    vigia: null,
    po: null,
    poEnabled: true,
    vigiaEnabled: true,
    now: T,
    ...over
  }
}

describe('roleFromSubagentType', () => {
  it('reconhece os quatro especialistas, com e sem acento', () => {
    expect(roleFromSubagentType('executor')).toBe('executor')
    expect(roleFromSubagentType('crítico')).toBe('critico')
    expect(roleFromSubagentType('navegador-de-código')).toBe('navegador-de-codigo')
    expect(roleFromSubagentType('MEMORIA')).toBe('memoria')
  })

  it('tipo de fora do cadastro vira subagente, nunca some', () => {
    expect(roleFromSubagentType('Explore')).toBe('subagente')
    expect(roleFromSubagentType(undefined)).toBe('subagente')
  })
})

describe('buildCrew', () => {
  it('o elenco está inteiro em cena mesmo sem ninguém trabalhando', () => {
    const crew = buildCrew(input())
    expect(crew.map((m) => m.role)).toEqual([
      'principal',
      'executor',
      'critico',
      'navegador-de-codigo',
      'memoria',
      'po',
      'vigia'
    ])
    expect(crew.every((m) => m.state === 'idle')).toBe(true)
  })

  it('a ordem dos papéis não muda quando alguém começa — o cartão não pula de lugar', () => {
    const parado = buildCrew(input()).map((m) => m.id)
    const trabalhando = buildCrew(input({ tracks: { t1: track() }, busy: true, busySince: T - 5_000 })).map(
      (m) => m.id
    )
    expect(trabalhando).toEqual(parado)
  })

  it('quem acabou de entrar anuncia a chegada; depois vira a ferramenta e o alvo', () => {
    const agora = buildCrew(input({ tracks: { t1: track({ startedAt: T - 900 }) } }))
    expect(lineText(agora[1].line)).toBe('começou agora · Bash')

    const depois = buildCrew(input({ tracks: { t1: track({ startedAt: T - 60_000 }) } }))
    expect(lineText(depois[1].line)).toBe('Bash npm test')
  })

  it('o principal diz a quem delegou, não só que está ocupado', () => {
    const crew = buildCrew(input({ tracks: { t1: track() }, busy: true, busySince: T - 9_000 }))
    expect(lineText(crew[0].line)).toBe('delegando · Agent → executor')
    expect(crew[0].state).toBe('working')
  })

  it('duas trilhas do mesmo papel viram um cartão, com a contagem', () => {
    const crew = buildCrew(
      input({
        tracks: {
          a: track({ id: 'a', startedAt: T - 30_000 }),
          b: track({ id: 'b', startedAt: T - 10_000 })
        }
      })
    )
    const executor = crew.find((m) => m.role === 'executor')!
    expect(executor.kind).toBe('2 em paralelo')
    expect(executor.startedAt).toBe(T - 10_000) // a mais recente manda
  })

  it('subagente fora do cadastro ganha linha própria, sem roubar a de um papel', () => {
    const crew = buildCrew(input({ tracks: { x: track({ id: 'x', subagentType: 'Explore' }) } }))
    const stray = crew.find((m) => m.id === 'track:x')
    expect(stray?.role).toBe('subagente')
    expect(stray?.name).toBe('Explore')
    expect(crew.find((m) => m.role === 'executor')?.state).toBe('idle')
  })

  it('o PO só sai de "trabalhando" quando a auditoria anuncia o fim', () => {
    const comum = {
      conversationId: 'c1',
      correlationId: 'x',
      requestedProvider: 'claude' as const,
      id: 'd1',
      at: T - 1_000
    }
    const rodando = buildCrew(
      input({ po: { ...comum, phase: 'claude-started', actualProvider: 'claude' } })
    ).find((m) => m.role === 'po')!
    expect(rodando.state).toBe('working')

    const fim = buildCrew(
      input({
        po: { ...comum, phase: 'audit-finished', actualProvider: 'gpt-luna', appliedOps: 2 }
      })
    ).find((m) => m.role === 'po')!
    expect(fim.state).toBe('idle')
    expect(lineText(fim.line)).toBe('auditou no fim do turno · 2 cartões corrigidos')
    expect(fim.badge).toEqual({ text: 'gpt-5.6-luna', tone: 'ok' })
  })

  it('o cartão do PO diz qual das duas rodadas do turno está acontecendo', () => {
    // Parado é como o cartão passa a maior parte do tempo: ali ele descreve o
    // papel inteiro, as duas rodadas, e não só a auditoria do fim.
    const parado = buildCrew(input()).find((m) => m.role === 'po')!
    expect(lineText(parado.line)).toBe('registra o pedido na abertura e audita no fim do turno')
    // A pílula fica ao lado do nome o tempo todo — chamá-lo de auditor esconderia
    // a rodada da abertura, que é metade do que ele faz, e chamá-lo de dono diria
    // que o quadro é dele: o esqueleto é do agente, o PO só cuida por cima.
    expect(parado.kind).toBe('cuida do quadro')

    const comum = {
      conversationId: 'c1',
      correlationId: 'x',
      requestedProvider: 'claude' as const,
      actualProvider: 'claude' as const,
      phase: 'claude-started' as const,
      id: 'd1',
      at: T - 1_000
    }
    const linha = (over: Partial<PoProviderDiagnosticMsg>): string => {
      const po = buildCrew(input({ po: { ...comum, ...over } })).find((m) => m.role === 'po')!
      return lineText(po.line)
    }

    expect(linha({ round: 'open' })).toBe('registrando o pedido no quadro')
    expect(linha({ round: 'close' })).toBe('auditando o quadro desta conversa')
    // Diagnóstico sem rodada (de um main anterior às duas fases) não pode piscar
    // "undefined": fica exatamente com o texto que o cartão sempre teve.
    expect(linha({})).toBe('auditando o quadro desta conversa')

    expect(linha({ round: 'open', phase: 'audit-finished', appliedOps: 0 })).toBe(
      'conferiu o pedido · nada a registrar'
    )
    // A abertura fecha tanto abrindo cartão quanto marcando andamento num que já
    // existia; a contagem é a mesma nos dois, então a frase não pode dizer
    // "aberto" — só o estado em que o cartão ficou.
    expect(linha({ round: 'open', phase: 'audit-finished', appliedOps: 1 })).toBe(
      'registrou o pedido · 1 cartão em andamento'
    )
    expect(linha({ round: 'open', phase: 'audit-finished', appliedOps: 2 })).toBe(
      'registrou o pedido · 2 cartões em andamento'
    )
    expect(linha({ round: 'close', phase: 'audit-finished', appliedOps: 0 })).toBe(
      'auditou no fim do turno · nada a corrigir'
    )
    expect(linha({ phase: 'audit-finished', appliedOps: 2 })).toBe(
      'auditou no fim do turno · 2 cartões corrigidos'
    )

    expect(
      linha({ round: 'open', phase: 'gpt-luna-unavailable', actualProvider: 'gpt-luna' })
    ).toBe('não consegui registrar o pedido · GPT Luna indisponível')
    expect(linha({ phase: 'gpt-luna-unavailable', actualProvider: 'gpt-luna' })).toBe(
      'não consegui auditar · GPT Luna indisponível'
    )
    // A troca de provedor não muda com a rodada: o que importa ali é o modelo.
    expect(linha({ round: 'open', phase: 'po-provider-switch', actualProvider: 'gpt-luna' })).toBe(
      'trocando de provedor · gpt-5.6-luna'
    )
  })

  it('a dúvida do vigia é o único estado que pede ação', () => {
    const crew = buildCrew(input({ vigia: { at: T - 40_000 } }))
    const vigia = crew.find((m) => m.role === 'vigia')!
    expect(vigia.state).toBe('asking')
    expect(vigia.badge?.tone).toBe('warn')
  })

  it('observador desligado não entra no elenco', () => {
    const crew = buildCrew(input({ poEnabled: false, vigiaEnabled: false }))
    expect(crew.some((m) => m.role === 'po' || m.role === 'vigia')).toBe(false)
  })

  it('o cartão de memória conta o que o memorista fez, fase por fase', () => {
    const comum = {
      conversationId: 'c1',
      correlationId: 'x',
      requestedProvider: 'claude' as const,
      actualProvider: 'claude' as const,
      phase: 'claude-started' as const,
      id: 'd1',
      at: T - 1_000
    }
    const cartao = (over?: Partial<MemoristaProviderDiagnosticMsg>): CrewMember =>
      buildCrew(
        input({ memoristaEnabled: true, memorista: over ? { ...comum, ...over } : null })
      ).find((m) => m.role === 'memoria')!

    // Parado, o cartão ensina o papel — e o que surpreende é ser sozinho.
    expect(lineText(cartao().line)).toBe('anota sozinho, no fim do turno, o que vale lembrar')
    expect(cartao().state).toBe('idle')

    expect(lineText(cartao({}).line)).toBe('lendo a conversa')
    expect(cartao({}).state).toBe('working')

    // Zero é o caso normal, não falha: não pode sair com cara de erro.
    const nada = cartao({ phase: 'analysis-finished', savedMemories: 0 })
    expect(lineText(nada.line)).toBe('leu a conversa · nada a guardar')
    expect(nada.badge).toEqual({ text: 'claude', tone: 'ok' })
    expect(lineText(cartao({ phase: 'analysis-finished', savedMemories: 1 }).line)).toBe(
      'guardou 1 memória'
    )
    expect(lineText(cartao({ phase: 'analysis-finished', savedMemories: 3 }).line)).toBe(
      'guardou 3 memórias'
    )

    const falhou = cartao({ phase: 'gpt-luna-unavailable', actualProvider: 'gpt-luna' })
    expect(falhou.state).toBe('failed')
    expect(lineText(falhou.line)).toBe('não consegui ler a conversa · GPT Luna indisponível')
    expect(
      lineText(cartao({ phase: 'memorista-provider-switch', actualProvider: 'gpt-luna' }).line)
    ).toBe('trocando de provedor · gpt-5.6-luna')
  })

  it('a delegação em cena ganha do memorista no mesmo cartão, sem duplicar o papel', () => {
    const crew = buildCrew(
      input({
        tracks: { t9: track({ id: 't9', subagentType: 'memoria', label: 'memoria: buscar' }) },
        memoristaEnabled: true,
        memorista: {
          conversationId: 'c1',
          correlationId: 'x',
          requestedProvider: 'claude',
          actualProvider: 'claude',
          phase: 'claude-started',
          id: 'd1',
          at: T - 1_000
        }
      })
    )
    const memoria = crew.filter((m) => m.role === 'memoria')
    expect(memoria).toHaveLength(1)
    expect(memoria[0]!.steps).toBeDefined()
  })

  it('memorista desligado devolve o cartão de memória ao especialista parado', () => {
    const memoria = buildCrew(input({ memoristaEnabled: false })).find((m) => m.role === 'memoria')!
    expect(lineText(memoria.line)).toBe('parado')
  })
})

describe('callSegments', () => {
  it('edição carrega os contadores de linha, coloridos', () => {
    const segs = callSegments('Edit', {
      file_path: 'C:\\p\\src\\main\\po\\po.ts',
      old_string: 'a\nb',
      new_string: 'a\nb\nc\nd'
    })
    expect(lineText(segs)).toBe('po/po.ts +4 −2')
    expect(segs.some((s) => s.kind === 'add')).toBe(true)
    expect(segs.some((s) => s.kind === 'del')).toBe(true)
  })

  it('comando longo é cortado, não estoura a linha', () => {
    const segs = callSegments('Bash', { command: 'x'.repeat(200) })
    expect(lineText(segs).length).toBeLessThanOrEqual(52)
  })

  it('entrada sem nada legível não inventa texto', () => {
    expect(callSegments('task_get', { task_id: 123 })).toEqual([])
  })
})

describe('buildLanes', () => {
  it('sem ninguém que tenha começado, não há faixa (e não divide por zero)', () => {
    expect(buildLanes(buildCrew(input()), T)).toEqual([])
  })

  it('a faixa de quem ainda trabalha vai até agora e fica marcada como viva', () => {
    const crew = buildCrew(input({ tracks: { t1: track() }, busy: true, busySince: T - 120_000 }))
    const lanes = buildLanes(crew, T)
    expect(lanes.length).toBe(2)
    expect(lanes.every((l) => l.live)).toBe(true)
    // O principal abriu o turno, então sua faixa começa na origem.
    expect(lanes[0].left).toBe(0)
    expect(lanes[0].width).toBeCloseTo(100, 5)
    // O executor entrou depois: começa adiante e termina no mesmo "agora".
    expect(lanes[1].left).toBeGreaterThan(0)
    expect(lanes[1].left + lanes[1].width).toBeCloseTo(100, 5)
  })

  it('nenhuma faixa escapa do trilho', () => {
    const crew = buildCrew(input({ tracks: { t1: track({ startedAt: T - 1 }) }, busy: true, busySince: T - 50_000 }))
    for (const lane of buildLanes(crew, T)) {
      expect(lane.left).toBeGreaterThanOrEqual(0)
      expect(lane.left + lane.width).toBeLessThanOrEqual(100.001)
    }
  })
})

describe('workingMembers', () => {
  it('lista só quem está trabalhando — é o que o chip da topbar mostra', () => {
    const crew = buildCrew(input({ tracks: { t1: track() }, busy: true, busySince: T - 5_000 }))
    expect(workingMembers(crew).map((m) => m.role)).toEqual(['principal', 'executor'])
  })
})
