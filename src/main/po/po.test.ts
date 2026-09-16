// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { BoardConfig, BoardItem, ChatEvent, PoProviderDiagnostic } from '../../shared/ipc'
import type { BoardService } from '../board/boardService'
import { classifyClaudeObserverFailure } from '../observerQuery'
import type { BoardPoCreate } from '../persistence/types'
import { Po, type PoObserverRequest } from './po'
import { PO_MAX_USER_CHARS, type PoPhase } from './poPrompt'

function card(over: Partial<BoardItem> = {}): BoardItem {
  return {
    id: 'bi-1',
    projectId: 'p',
    projectCwd: 'C:/p',
    conversationId: 'conv-1',
    origin: 'agent',
    sourceId: '1',
    sourceTitle: 'add board table',
    sourceStatus: 'pending',
    activeForm: null,
    seq: 0,
    poTitle: null,
    poNote: null,
    poStatus: null,
    poReason: null,
    poAt: null,
    dismissedAt: null,
    revision: 1,
    createdAt: '',
    updatedAt: '',
    ...over
  }
}

const config = (over: Partial<BoardConfig['po']> = {}): BoardConfig => ({
  requirePlan: true,
  po: { enabled: true, model: 'claude-sonnet-5', ...over }
})

/**
 * O dublê do quadro REFLETE o que o PO escreve nele.
 *
 * Um `list` que devolve sempre o mesmo array esconde justamente a corrida que
 * interessa aqui: as duas fases do mesmo turno consultando o modelo ao mesmo
 * tempo, cada uma julgando um quadro de antes da outra ter escrito.
 */
function fakeBoard(initial: BoardItem[], projectId = initial[0]?.projectId ?? 'p') {
  const cards = [...initial]
  return {
    settled: vi.fn(async () => undefined),
    // Cópia a cada chamada: quem listou antes continua com a lista de antes,
    // como acontece de verdade com o resultado de uma consulta.
    list: vi.fn(async () => [...cards]),
    projectId: vi.fn(async () => projectId),
    applyPo: vi.fn(async () => null),
    createPoItem: vi.fn(async (input: BoardPoCreate) => {
      // Como o repositório grava um cartão de origem `po`: título e status vão
      // para as colunas source_*, e o motivo para a camada do PO.
      const created = card({
        id: `bi-po-${cards.length + 1}`,
        origin: 'po',
        sourceId: null,
        sourceTitle: input.title,
        sourceStatus: input.status,
        poReason: input.reason,
        projectId: input.projectId,
        projectCwd: input.projectCwd,
        conversationId: input.conversationId
      })
      cards.push(created)
      return created
    })
  } as unknown as BoardService & {
    settled: ReturnType<typeof vi.fn>
    list: ReturnType<typeof vi.fn>
    projectId: ReturnType<typeof vi.fn>
    applyPo: ReturnType<typeof vi.fn>
    createPoItem: ReturnType<typeof vi.fn>
  }
}

const result: ChatEvent = { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 }
const toolUse = (name: string, input: unknown): ChatEvent => ({
  kind: 'tool-use',
  id: `t-${name}`,
  name,
  input,
  parentToolUseId: null
})

/** A fase se reconhece pelo digest: só o fechamento leva as AÇÕES do turno. */
const isClose = (prompt: string): boolean => prompt.includes('AÇÕES DESTE TURNO')

/** Um `ask` que responde diferente em cada rodada — é assim que o teste diz de
 *  qual das duas ele está falando. O silêncio (OK) é o padrão dos dois lados. */
function askPhases(answers: { open?: string; close?: string } = {}) {
  return vi.fn(async (prompt: string) => (isClose(prompt) ? answers.close ?? 'OK' : answers.open ?? 'OK'))
}

function prompts(ask: ReturnType<typeof askPhases>, phase: PoPhase): string[] {
  return ask.mock.calls.map((call) => String(call[0])).filter((prompt) => isClose(prompt) === (phase === 'close'))
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('Po — abertura (o pedido vira cartão antes do trabalho)', () => {
  it('abre o cartão do pedido mesmo com o quadro VAZIO — é o caso que o fechamento nunca cobriu', async () => {
    const board = fakeBoard([])
    const ask = askPhases({ open: 'NOVA | Corrigir a exportação de XML | o usuário pediu agora' })
    const po = new Po({ config: () => config(), board, ask })

    po.noteUserMessage('conv-1', 'C:/p', 'corrige a exportação de XML')
    await flush()

    expect(board.createPoItem).toHaveBeenCalledWith({
      projectId: 'p',
      projectCwd: 'C:/p',
      conversationId: 'conv-1',
      title: 'Corrigir a exportação de XML',
      // Já EM ANDAMENTO: o trabalho está começando agora, não é intenção.
      status: 'in_progress',
      reason: 'o usuário pediu agora'
    })
  })

  it('usa o cartão que já cobre o pedido em vez de criar outro', async () => {
    const board = fakeBoard([card()])
    const ask = askPhases({ open: 'ANDAMENTO bi-1 | o pedido é exatamente este cartão' })
    const po = new Po({ config: () => config(), board, ask })

    po.noteUserMessage('conv-1', 'C:/p', 'termina a tabela do quadro')
    await flush()

    expect(board.applyPo).toHaveBeenCalledWith({
      id: 'bi-1',
      poStatus: 'in_progress',
      poReason: 'o pedido é exatamente este cartão'
    })
    expect(board.createPoItem).not.toHaveBeenCalled()
  })

  it('pergunta não vira cartão — o PO vê o pedido e responde OK', async () => {
    const board = fakeBoard([card()])
    const ask = askPhases({ open: 'OK' })
    const po = new Po({ config: () => config(), board, ask })

    po.noteUserMessage('conv-1', 'C:/p', 'por que o build quebra no Windows?')
    await flush()

    expect(prompts(ask, 'open')).toEqual([expect.stringContaining('por que o build quebra no Windows?')])
    expect(board.applyPo).not.toHaveBeenCalled()
    expect(board.createPoItem).not.toHaveBeenCalled()
  })

  it('a abertura não gasta a janela de cooldown do fechamento', async () => {
    const board = fakeBoard([card()])
    const ask = askPhases()
    let now = 1_000_000
    const po = new Po({ config: () => config(), board, ask, now: () => now })

    po.noteUserMessage('conv-1', 'C:/p', 'um')
    po.observe('conv-1', result)
    await flush()
    expect(prompts(ask, 'open')).toHaveLength(1)
    expect(prompts(ask, 'close')).toHaveLength(1)

    // Segundo turno dentro do minuto: as DUAS fases seguram, cada uma pela sua.
    now += 5_000
    po.noteUserMessage('conv-1', 'C:/p', 'dois')
    po.observe('conv-1', result)
    await flush()
    expect(prompts(ask, 'open')).toHaveLength(1)
    expect(prompts(ask, 'close')).toHaveLength(1)

    now += 120_000
    po.noteUserMessage('conv-1', 'C:/p', 'três')
    po.observe('conv-1', result)
    await flush()
    expect(prompts(ask, 'open')).toHaveLength(2)
    expect(prompts(ask, 'close')).toHaveLength(2)
  })

  it('o turno pulado pelo cooldown entra no digest da auditoria seguinte', async () => {
    const board = fakeBoard([card()])
    const ask = askPhases()
    let now = 1_000_000
    const po = new Po({ config: () => config(), board, ask, now: () => now })

    po.noteUserMessage('conv-1', 'C:/p', 'primeiro pedido')
    po.observe('conv-1', result)
    await flush()

    now += 5_000
    po.noteUserMessage('conv-1', 'C:/p', 'pedido pulado pelo cooldown')
    po.observe('conv-1', toolUse('Bash', { command: 'teste-do-turno-pulado' }))
    po.observe('conv-1', result)
    await flush()
    expect(prompts(ask, 'close')).toHaveLength(1)

    now += 120_000
    po.noteUserMessage('conv-1', 'C:/p', 'pedido de agora')
    po.observe('conv-1', result)
    await flush()

    // Nenhum pedido fica sem passar pelo PO: o que o cooldown pulou volta junto.
    const digest = prompts(ask, 'close')[1] ?? ''
    expect(digest).toContain('pedido pulado pelo cooldown')
    expect(digest).toContain('teste-do-turno-pulado')
    expect(digest).toContain('pedido de agora')
    expect(digest).not.toContain('primeiro pedido')
  })

  it('o pedido de AGORA não é empurrado para fora do digest pelo acumulado', async () => {
    const board = fakeBoard([card()])
    const ask = askPhases()
    let now = 1_000_000
    const po = new Po({ config: () => config(), board, ask, now: () => now })
    // Um pedido pulado que sozinho já enche o orçamento do digest.
    const gigante = `pedido-antigo-gigante ${'x'.repeat(PO_MAX_USER_CHARS)}`

    po.noteUserMessage('conv-1', 'C:/p', 'primeiro pedido')
    po.observe('conv-1', result)
    await flush()

    now += 5_000
    po.noteUserMessage('conv-1', 'C:/p', gigante)
    po.observe('conv-1', result)
    await flush()

    now += 120_000
    po.noteUserMessage('conv-1', 'C:/p', 'PEDIDO-DE-AGORA: corrige a exportação')
    po.observe('conv-1', result)
    await flush()

    // O teto do digest corta pela CAUDA. Sem orçamento na junção, o que
    // sobreviveria seria o pedido velho e o de agora sumiria inteiro — o
    // oposto do que o acúmulo existe para fazer.
    const digest = prompts(ask, 'close')[1] ?? ''
    expect(digest).toContain('PEDIDO-DE-AGORA')
    expect(digest).not.toContain('pedido-antigo-gigante')
  })

  it('o acumulado volta para a fila quando a análise falha e entra na auditoria seguinte', async () => {
    const board = fakeBoard([card()])
    const closes: string[] = []
    const ask = vi.fn(async (prompt: string) => {
      if (!isClose(prompt)) return 'OK'
      closes.push(prompt)
      // A SEGUNDA auditoria morre depois de já ter tirado o turno pulado da fila.
      if (closes.length === 2) throw new Error('Claude indisponível')
      return 'OK'
    })
    let now = 1_000_000
    const po = new Po({ config: () => config(), board, ask, now: () => now })

    po.noteUserMessage('conv-1', 'C:/p', 'primeiro pedido')
    po.observe('conv-1', result)
    await flush()

    now += 5_000
    po.noteUserMessage('conv-1', 'C:/p', 'pedido pulado pelo cooldown')
    po.observe('conv-1', result)
    await flush()

    now += 120_000
    po.noteUserMessage('conv-1', 'C:/p', 'pedido da auditoria que falhou')
    po.observe('conv-1', result)
    await flush()

    now += 120_000
    po.noteUserMessage('conv-1', 'C:/p', 'pedido de agora')
    po.observe('conv-1', result)
    await flush()

    // Uma análise que não completa não dá baixa no que tirou da fila: o turno
    // que nunca passou pelo PO continua esperando até passar.
    expect(closes[2] ?? '').toContain('pedido pulado pelo cooldown')
    expect(closes[2] ?? '').toContain('pedido de agora')
  })
})

describe('Po — a corrida entre as duas fases do mesmo turno', () => {
  it('não cria o cartão duas vezes quando a abertura ainda está no modelo e o turno já acabou', async () => {
    const board = fakeBoard([])
    let releaseOpen = (): void => {}
    let releaseClose = (): void => {}
    const openHeld = new Promise<void>((resolve) => {
      releaseOpen = resolve
    })
    const closeHeld = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    const ask = vi.fn(async (prompt: string) => {
      if (isClose(prompt)) {
        await closeHeld
        return 'FEITA | Corrigir a exportação de XML | o arquivo foi escrito e o teste passou'
      }
      await openHeld
      return 'NOVA | Corrigir a exportação de XML | o usuário pediu agora'
    })
    const po = new Po({ config: () => config(), board, ask })

    // A ordem real de um turno curto: a abertura fica pendurada na consulta...
    po.noteUserMessage('conv-1', 'C:/p', 'corrige a exportação de XML')
    await flush()
    po.observe('conv-1', toolUse('Edit', { file_path: 'src/xml.ts' }))
    // ...e o `result` chega antes de ela responder, então o fechamento julga um
    // quadro que ainda não tem o cartão que a abertura vai criar.
    po.observe('conv-1', result)
    await flush()
    expect(await board.list.mock.results[1]?.value).toEqual([])

    // A abertura responde e cria o cartão; só então o fechamento responde.
    releaseOpen()
    await flush()
    releaseClose()
    await po.settled('conv-1')

    // Um pedido, um cartão. O fechamento confere o quadro de novo na hora de
    // escrever e vê o que a abertura acabou de criar.
    expect(board.createPoItem).toHaveBeenCalledTimes(1)
    expect(board.createPoItem).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Corrigir a exportação de XML',
      status: 'in_progress'
    }))
  })

  it('sem conseguir reler o quadro na hora de escrever, não cria — duplicar é pior', async () => {
    const board = fakeBoard([card()])
    let listed = 0
    // 1 = abertura, 2 = fechamento, 3 = a releitura do fechamento antes de criar.
    board.list.mockImplementation(async () => (++listed >= 3 ? null : [card()]))
    const po = new Po({
      config: () => config(),
      board,
      ask: askPhases({ close: 'NOVA | Documentar o quadro | o agente disse que falta documentar' })
    })

    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', result)
    await po.settled('conv-1')

    expect(board.createPoItem).not.toHaveBeenCalled()
  })
})

describe('Po — fechamento (a auditoria do turno)', () => {
  it('conclui no quadro a tarefa que o agente terminou e esqueceu de marcar', async () => {
    const board = fakeBoard([card()])
    const ask = askPhases({ close: 'CONCLUIR bi-1 | o arquivo foi escrito e o teste passou' })
    const po = new Po({ config: () => config(), board, ask })

    po.noteUserMessage('conv-1', 'C:/p', 'cria a tabela')
    po.observe('conv-1', toolUse('Edit', { file_path: 'src/a.ts' }))
    po.observe('conv-1', result)
    await flush()

    expect(board.applyPo).toHaveBeenCalledWith({
      id: 'bi-1',
      poStatus: 'completed',
      poReason: 'o arquivo foi escrito e o teste passou'
    })
  })

  it('audita no FIM do turno, uma vez só', async () => {
    const board = fakeBoard([card()])
    const ask = askPhases()
    const po = new Po({ config: () => config(), board, ask })

    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', toolUse('Edit', { file_path: 'a' }))
    po.observe('conv-1', toolUse('Edit', { file_path: 'b' }))
    await flush()
    expect(prompts(ask, 'close')).toHaveLength(0)

    po.observe('conv-1', result)
    po.observe('conv-1', result)
    await flush()
    expect(prompts(ask, 'close')).toHaveLength(1)
  })

  it('OK não escreve nada no quadro', async () => {
    const board = fakeBoard([card()])
    const po = new Po({ config: () => config(), board, ask: askPhases() })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', result)
    await flush()
    expect(board.applyPo).not.toHaveBeenCalled()
    expect(board.createPoItem).not.toHaveBeenCalled()
  })

  it('conclui o cartão que ficou EM ANDAMENTO no fim do turno — o caso central', async () => {
    const board = fakeBoard([card({ sourceStatus: 'in_progress' })])
    const po = new Po({
      config: () => config(),
      board,
      ask: askPhases({ close: 'CONCLUIR bi-1 | o arquivo foi escrito e o teste passou' })
    })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', result)
    await flush()
    expect(board.applyPo).toHaveBeenCalledWith({
      id: 'bi-1',
      poStatus: 'completed',
      poReason: 'o arquivo foi escrito e o teste passou'
    })
  })

  it('não reconclui o que já está concluído', async () => {
    const board = fakeBoard([card({ sourceStatus: 'completed' })])
    const po = new Po({ config: () => config(), board, ask: askPhases({ close: 'CONCLUIR bi-1 | de novo' }) })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', result)
    await flush()
    expect(board.applyPo).not.toHaveBeenCalled()
  })

  it('FEITA registra o trabalho que aconteceu e nenhum cartão cobria', async () => {
    const board = fakeBoard([])
    const po = new Po({
      config: () => config(),
      board,
      ask: askPhases({ close: 'FEITA | Corrigir a exportação de XML | o arquivo foi escrito e o teste passou' })
    })
    po.noteUserMessage('conv-1', 'C:/p', 'corrige a exportação')
    po.observe('conv-1', toolUse('Edit', { file_path: 'src/xml.ts' }))
    po.observe('conv-1', result)
    await flush()

    expect(board.createPoItem).toHaveBeenCalledWith({
      projectId: 'p',
      projectCwd: 'C:/p',
      conversationId: 'conv-1',
      title: 'Corrigir a exportação de XML',
      // Nasce CONCLUÍDA: um cartão "a fazer" para algo já feito seria mentira.
      status: 'completed',
      reason: 'o arquivo foi escrito e o teste passou'
    })
  })

  it('não recria o cartão que já existe, mesmo com acento e caixa diferentes', async () => {
    const board = fakeBoard([card({ sourceTitle: 'Corrigir a exportação de XML' })])
    const po = new Po({
      config: () => config(),
      board,
      ask: askPhases({ close: 'FEITA | corrigir a EXPORTACAO de xml | já estava feito' })
    })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', result)
    await flush()
    expect(board.createPoItem).not.toHaveBeenCalled()
  })

  it('cria o cartão da tarefa que surgiu e nunca foi declarada', async () => {
    const board = fakeBoard([card()])
    const po = new Po({
      config: () => config(),
      board,
      ask: askPhases({ close: 'NOVA | Documentar o quadro | o agente disse que falta documentar' })
    })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', result)
    await flush()
    expect(board.createPoItem).toHaveBeenCalledWith({
      projectId: 'p',
      projectCwd: 'C:/p',
      conversationId: 'conv-1',
      title: 'Documentar o quadro',
      status: 'pending',
      reason: 'o agente disse que falta documentar'
    })
  })

  it('guarda as ÚLTIMAS ações do turno — a evidência está no fim, não no começo', async () => {
    const board = fakeBoard([card()])
    const ask = askPhases()
    const po = new Po({ config: () => config(), board, ask })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    for (let i = 0; i < 40; i += 1) {
      po.observe('conv-1', toolUse('Read', { file_path: `leitura-${i}.ts` }))
    }
    po.observe('conv-1', toolUse('Bash', { command: 'npx vitest run' }))
    po.observe('conv-1', result)
    await flush()
    const digest = prompts(ask, 'close')[0] ?? ''
    expect(digest).toContain('npx vitest run')
    expect(digest).not.toContain('leitura-0.ts')
  })

  it('turno que morreu em erro não é auditado', async () => {
    const board = fakeBoard([card()])
    const ask = askPhases({ close: 'CONCLUIR bi-1 | x' })
    const po = new Po({ config: () => config(), board, ask })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', { kind: 'error', id: 'e', text: 'caiu' })
    po.observe('conv-1', result)
    await flush()
    expect(prompts(ask, 'close')).toHaveLength(0)
    expect(board.applyPo).not.toHaveBeenCalled()
  })

  it('sem mensagem do usuário não roda (retomada de sessão, recuperação de turno)', async () => {
    const board = fakeBoard([card()])
    const ask = askPhases()
    const po = new Po({ config: () => config(), board, ask })
    po.observe('conv-1', result)
    await flush()
    expect(ask).not.toHaveBeenCalled()
  })

  it('espera a ingestão do snapshot antes de julgar', async () => {
    const board = fakeBoard([card()])
    const po = new Po({ config: () => config(), board, ask: askPhases() })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', result)
    await flush()
    expect(board.settled).toHaveBeenCalledWith('conv-1')
  })
})

describe('Po — o quadro como fonte, e o silêncio como falha', () => {
  it('desligado na configuração não chama o modelo em nenhuma fase', async () => {
    const board = fakeBoard([card()])
    const ask = askPhases()
    const po = new Po({ config: () => config({ enabled: false }), board, ask })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', result)
    await flush()
    expect(ask).not.toHaveBeenCalled()
  })

  it('quadro INDISPONÍVEL (null) aborta — não dá para auditar o que não se conseguiu ler', async () => {
    const board = fakeBoard([card()])
    board.list.mockResolvedValue(null)
    const ask = askPhases()
    const po = new Po({ config: () => config(), board, ask })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', result)
    await flush()
    expect(ask).not.toHaveBeenCalled()
    expect(board.createPoItem).not.toHaveBeenCalled()
  })

  it('sem identidade de projeto não há onde criar cartão', async () => {
    const board = fakeBoard([], '')
    const ask = askPhases({ open: 'NOVA | Qualquer coisa | x' })
    const po = new Po({ config: () => config(), board, ask })
    po.noteUserMessage('conv-1', '', 'x')
    await flush()
    expect(ask).not.toHaveBeenCalled()
    expect(board.createPoItem).not.toHaveBeenCalled()
  })

  it('falha do modelo degrada em silêncio — o observador não derruba o observado', async () => {
    const board = fakeBoard([card()])
    const po = new Po({
      config: () => config(),
      board,
      ask: vi.fn(async () => {
        throw new Error('rede caiu')
      })
    })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    expect(() => po.observe('conv-1', result)).not.toThrow()
    await flush()
    expect(board.applyPo).not.toHaveBeenCalled()
  })

  it('quadro que rejeita também degrada em silêncio, nas duas fases', async () => {
    const board = fakeBoard([card()])
    board.list.mockRejectedValue(new Error('banco fora do ar'))
    board.applyPo.mockRejectedValue(new Error('banco fora do ar'))
    const po = new Po({ config: () => config(), board, ask: askPhases({ close: 'CONCLUIR bi-1 | x' }) })

    expect(() => po.noteUserMessage('conv-1', 'C:/p', 'x')).not.toThrow()
    expect(() => po.observe('conv-1', result)).not.toThrow()
    await expect(po.settled('conv-1')).resolves.toBeUndefined()
  })

  it('dispose esquece a conversa', async () => {
    const board = fakeBoard([card()])
    const ask = askPhases()
    const po = new Po({ config: () => config(), board, ask })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.dispose('conv-1')
    po.observe('conv-1', result)
    await flush()
    expect(prompts(ask, 'close')).toHaveLength(0)
  })
})

describe('Po — settled', () => {
  it('sem análise em voo resolve na hora', async () => {
    const board = fakeBoard([card()])
    const po = new Po({ config: () => config(), board, ask: askPhases() })
    await expect(po.settled('conv-sem-nada')).resolves.toBeUndefined()
  })

  it('só resolve depois de a análise TERMINAR de escrever no quadro', async () => {
    const board = fakeBoard([card()])
    let release: (() => void) | undefined
    board.settled.mockImplementation(() => new Promise<void>((resolve) => {
      release = resolve
    }))
    const po = new Po({
      config: () => config(),
      board,
      ask: askPhases({ open: 'ANDAMENTO bi-1 | o pedido é este cartão' })
    })

    po.noteUserMessage('conv-1', 'C:/p', 'termina a tabela')
    let done = false
    const waiting = po.settled('conv-1').then(() => {
      done = true
    })
    await flush()
    expect(done).toBe(false)

    release?.()
    await waiting
    expect(board.applyPo).toHaveBeenCalledWith({
      id: 'bi-1',
      poStatus: 'in_progress',
      poReason: 'o pedido é este cartão'
    })
  })
})

describe('Po — failover Claude → Luna', () => {
  it('mantém Claude como única tentativa quando ele conclui — uma consulta por fase', async () => {
    const board = fakeBoard([card()])
    const runClaude = vi.fn(async (_request: PoObserverRequest) => ({ provider: 'claude' as const, state: 'completed' as const, text: 'OK' }))
    const runLuna = vi.fn()
    const po = new Po({ config: () => config(), board, runClaude, runLuna })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', result)
    await flush()

    expect(runClaude.mock.calls.map(([request]) => request.phase)).toEqual(['open', 'close'])
    expect(runLuna).not.toHaveBeenCalled()
  })

  it.each(['claude_plan', 'claude_auth', 'claude_authorization'] as const)('troca uma vez para Luna somente por %s estruturado', async (reason) => {
    const board = fakeBoard([card()])
    const phaseOf = new Map<string, PoPhase>()
    const runClaude = vi.fn(async (request: PoObserverRequest) => {
      phaseOf.set(request.correlationId, request.phase)
      return { provider: 'claude' as const, state: 'failed' as const, reason }
    })
    const runLuna = vi.fn(async (_request: PoObserverRequest, started: () => void) => {
      started()
      return { provider: 'gpt-luna' as const, state: 'completed' as const, text: 'CONCLUIR bi-1 | confirmado pela Luna' }
    })
    const diagnostics: PoProviderDiagnostic[] = []
    const po = new Po({ config: () => config(), board, runClaude, runLuna, diagnose: (event) => diagnostics.push(event) })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', result)
    await flush()

    // Uma troca por fase, e nunca mais de uma consulta Luna dentro da mesma.
    expect(runLuna).toHaveBeenCalledTimes(2)
    expect(board.applyPo).toHaveBeenCalledTimes(1)

    const closeId = [...phaseOf].find(([, phase]) => phase === 'close')?.[0]
    const close = diagnostics.filter((event) => event.correlationId === closeId)
    // A auditoria também ANUNCIA O FIM: sem isso o elenco mostraria o PO
    // trabalhando para sempre depois de um turno.
    expect(close.map(({ phase }) => phase)).toEqual([
      'claude-started',
      'claude-unavailable',
      'po-provider-switch',
      'gpt-luna-started',
      'audit-finished'
    ])
    expect(close.slice(1, 4)).toEqual([
      expect.objectContaining({ phase: 'claude-unavailable', actualProvider: 'claude', fallbackReason: reason }),
      expect.objectContaining({ phase: 'po-provider-switch', actualProvider: 'gpt-luna', fallbackReason: reason }),
      expect.objectContaining({ phase: 'gpt-luna-started', actualProvider: 'gpt-luna', fallbackReason: reason })
    ])
    // O fim conta o que foi de fato escrito no quadro, e pela rota vencedora.
    expect(close[4]).toEqual(
      expect.objectContaining({ phase: 'audit-finished', actualProvider: 'gpt-luna', appliedOps: 1 })
    )
  })

  it('faz uma única chamada Luna por account_on_hold estruturado do SDK', async () => {
    const reason = classifyClaudeObserverFailure({ type: 'assistant', error: 'account_on_hold' })
    if (reason !== 'claude_plan') throw new Error('account_on_hold precisa ser elegível ao failover')

    const board = fakeBoard([card()])
    const runClaude = vi.fn(async () => ({ provider: 'claude' as const, state: 'failed' as const, reason }))
    const runLuna = vi.fn(async (_request: PoObserverRequest, started: () => void) => {
      started()
      return { provider: 'gpt-luna' as const, state: 'completed' as const, text: 'OK' }
    })
    const po = new Po({ config: () => config(), board, runClaude, runLuna })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', result)
    await flush()

    // Duas fases, duas análises: uma tentativa Claude e uma Luna em cada.
    expect(runClaude).toHaveBeenCalledTimes(2)
    expect(runLuna).toHaveBeenCalledTimes(2)
  })

  it('não troca para Luna por falha ambígua e não escreve no quadro', async () => {
    const board = fakeBoard([card()])
    const runLuna = vi.fn()
    const po = new Po({
      config: () => config(),
      board,
      runClaude: async () => ({ provider: 'claude', state: 'failed' }),
      runLuna
    })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', result)
    await flush()

    expect(runLuna).not.toHaveBeenCalled()
    expect(board.applyPo).not.toHaveBeenCalled()
  })

  it('falha de Luna não persiste parcialmente e só emite diagnóstico seguro', async () => {
    const board = fakeBoard([card()])
    const diagnostics: unknown[] = []
    const po = new Po({
      config: () => config(),
      board,
      runClaude: async () => ({ provider: 'claude', state: 'failed', reason: 'claude_auth' }),
      runLuna: async (_request, started) => {
        started()
        return { provider: 'gpt-luna', state: 'failed' }
      },
      diagnose: (event) => diagnostics.push(event)
    })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', result)
    await flush()

    expect(board.applyPo).not.toHaveBeenCalled()
    expect(board.createPoItem).not.toHaveBeenCalled()
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'gpt-luna-unavailable', actualProvider: 'gpt-luna', fallbackReason: 'claude_auth' })
    ]))
  })

  it('congela cwd, cartões e correlação no pedido Luna', async () => {
    const board = fakeBoard([card({ projectId: 'project-a', projectCwd: 'C:/a' })])
    const seen: PoObserverRequest[] = []
    const configValue = config()
    const po = new Po({
      config: () => configValue,
      board,
      newCorrelationId: () => 'correlation-a',
      runClaude: async () => ({ provider: 'claude', state: 'failed', reason: 'claude_plan' }),
      runLuna: async (request, started) => {
        started()
        seen.push(request)
        configValue.po.model = 'claude-other'
        return { provider: 'gpt-luna', state: 'completed', text: 'OK' }
      }
    })
    po.noteUserMessage('conv-1', 'C:/a', 'x')
    po.observe('conv-1', result)
    await flush()

    // Uma análise por fase, e nenhuma delas muda de modelo no meio do caminho:
    // a configuração é lida uma vez, na largada.
    expect(seen.map(({ phase }) => phase)).toEqual(['open', 'close'])
    for (const request of seen) {
      expect(request).toEqual(expect.objectContaining({
        cwd: 'C:/a',
        conversationId: 'conv-1',
        projectId: 'project-a',
        correlationId: 'correlation-a',
        model: 'claude-sonnet-5'
      }))
    }
  })

  it('preserva a evidência do turno quando o próximo começa durante a fila do quadro', async () => {
    const board = fakeBoard([card()])
    const releases: (() => void)[] = []
    board.settled.mockImplementation(() => new Promise<void>((resolve) => {
      releases.push(resolve)
    }))
    const runClaude = vi.fn(async (_request: PoObserverRequest) => ({ provider: 'claude' as const, state: 'completed' as const, text: 'OK' }))
    const po = new Po({ config: () => config(), board, runClaude })

    po.noteUserMessage('conv-1', 'C:/turn-a', 'pedido do turno A')
    po.observe('conv-1', toolUse('Edit', { file_path: 'src/turn-a.ts' }))
    po.observe('conv-1', result)

    po.noteUserMessage('conv-1', 'C:/turn-b', 'pedido do turno B')
    po.observe('conv-1', toolUse('Bash', { command: 'teste-do-turno-b' }))
    for (const release of releases) release()
    await flush()

    expect(board.list).toHaveBeenCalledWith('C:/turn-a', { conversationId: 'conv-1' })
    const request = runClaude.mock.calls.map(([sent]) => sent).find((sent) => sent.phase === 'close')
    if (!request) throw new Error('Claude não recebeu a auditoria do turno A')
    expect(request.prompt).toContain('pedido do turno A')
    expect(request.prompt).toContain('src/turn-a.ts')
    expect(request.prompt).not.toContain('pedido do turno B')
    expect(request.prompt).not.toContain('teste-do-turno-b')
  })
})
