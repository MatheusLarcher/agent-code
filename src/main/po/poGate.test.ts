// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { BoardConfig, BoardItem, ChatEvent, PoProviderDiagnostic } from '../../shared/ipc'
import type { BoardService } from '../board/boardService'
import type { BoardPoCreate } from '../persistence/types'
import type { BoardGateInput } from '../typesafe'
import { Po, PO_RETRY_DELAY_MS, type PoObserverRequest } from './po'

/**
 * O gate do TypeSafe dentro do PO: um "não" economiza o modelo e conta como
 * auditoria feita; `null`, inativo ou lançando é ausência de decisão, e o PO
 * segue exatamente como seguia antes do gate existir.
 */

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

const config = (): BoardConfig => ({ requirePlan: true, po: { enabled: true, model: 'claude-sonnet-5' } })

function fakeBoard(initial: BoardItem[]) {
  const cards = [...initial]
  return {
    settled: vi.fn(async () => undefined),
    list: vi.fn(async () => [...cards]),
    projectId: vi.fn(async () => 'p'),
    applyPo: vi.fn(async () => null),
    createPoItem: vi.fn(async (input: BoardPoCreate) => {
      const created = card({ id: `bi-po-${cards.length + 1}`, origin: 'po', sourceTitle: input.title, sourceStatus: input.status })
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
const toolUse = (name: string, input: unknown): ChatEvent => ({ kind: 'tool-use', id: `t-${name}`, name, input, parentToolUseId: null })

/** Um Claude que responderia com escrita nas DUAS fases: se o gate deixar
 *  passar, o quadro muda — é o que torna o "não chamou" observável. */
function writingClaude() {
  return vi.fn(async (request: PoObserverRequest) => ({
    provider: 'claude' as const,
    state: 'completed' as const,
    text: request.phase === 'open' ? 'NOVA | Corrigir a exportação | pediu agora' : 'CONCLUIR bi-1 | o teste passou'
  }))
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Mesmo padrão do po.test.ts: captura o que o PO agendou, sem esperar. */
function fakeScheduler() {
  const scheduled: { delayMs: number; fn: () => void; cancelled: boolean }[] = []
  const scheduleFlush = vi.fn((delayMs: number, fn: () => void) => {
    const entry = { delayMs, fn, cancelled: false }
    scheduled.push(entry)
    return () => {
      entry.cancelled = true
    }
  })
  return { scheduleFlush, scheduled }
}

describe('Po — gate "não" economiza o modelo', () => {
  it('na ABERTURA: não chama Claude nem Luna, não escreve e não anuncia auditoria', async () => {
    const board = fakeBoard([card()])
    const runClaude = writingClaude()
    const runLuna = vi.fn()
    const diagnostics: PoProviderDiagnostic[] = []
    const gate = vi.fn(async () => false)
    const po = new Po({ config, board, runClaude, runLuna, gate, diagnose: (event) => diagnostics.push(event) })

    po.noteUserMessage('conv-1', 'C:/p', 'obrigado, ficou ótimo')
    await flush()

    expect(gate).toHaveBeenCalledTimes(1)
    expect(runClaude).not.toHaveBeenCalled()
    expect(runLuna).not.toHaveBeenCalled()
    expect(board.createPoItem).not.toHaveBeenCalled()
    expect(board.applyPo).not.toHaveBeenCalled()
    expect(diagnostics).toEqual([])
  })

  it('no FECHAMENTO: a abertura roda normal, o fechamento não chama modelo nem escreve', async () => {
    const board = fakeBoard([card({ sourceStatus: 'in_progress' })])
    const runClaude = writingClaude()
    const diagnostics: PoProviderDiagnostic[] = []
    const gate = vi.fn(async (input: BoardGateInput) => (input.phase === 'close' ? false : null))
    const po = new Po({ config, board, runClaude, gate, diagnose: (event) => diagnostics.push(event) })

    po.noteUserMessage('conv-1', 'C:/p', 'por que o build quebra?')
    po.observe('conv-1', result)
    await flush()

    expect(gate.mock.calls.map(([input]) => input.phase).sort()).toEqual(['close', 'open'])
    expect(runClaude.mock.calls.map(([request]) => request.phase)).toEqual(['open'])
    expect(board.applyPo).not.toHaveBeenCalled()
    expect(diagnostics.every((event) => event.round === 'open')).toBe(true)
  })

  it('o "não" conta como auditado: o acumulado não volta para a fila e nada é reagendado', async () => {
    const board = fakeBoard([card()])
    const closes: string[] = []
    const runClaude = vi.fn(async (request: PoObserverRequest) => {
      if (request.phase === 'close') closes.push(request.prompt)
      return { provider: 'claude' as const, state: 'completed' as const, text: 'OK' }
    })
    // Só o fechamento que carrega o turno pulado ouve "não".
    const gate = vi.fn(async (input: BoardGateInput) =>
      input.phase === 'close' && input.userText.includes('pedido pulado') ? false : null
    )
    let now = 1_000_000
    const { scheduleFlush, scheduled } = fakeScheduler()
    const po = new Po({ config, board, runClaude, gate, now: () => now, scheduleFlush })

    po.noteUserMessage('conv-1', 'C:/p', 'primeiro pedido')
    po.observe('conv-1', result)
    await flush()

    now += 5_000
    po.noteUserMessage('conv-1', 'C:/p', 'pedido pulado pelo cooldown')
    po.observe('conv-1', result)
    await flush()

    now += 120_000
    po.noteUserMessage('conv-1', 'C:/p', 'pedido julgado pelo gate')
    po.observe('conv-1', result)
    await flush()

    now += 120_000
    po.noteUserMessage('conv-1', 'C:/p', 'pedido de agora')
    po.observe('conv-1', result)
    await flush()

    expect(closes).toHaveLength(2)
    expect(closes[1]).toContain('pedido de agora')
    expect(closes[1]).not.toContain('pedido pulado pelo cooldown')
    expect(closes[1]).not.toContain('pedido julgado pelo gate')
    // Só os flushes do cooldown (55 s) foram agendados — nenhuma retentativa.
    expect(scheduled.some((entry) => entry.delayMs === PO_RETRY_DELAY_MS)).toBe(false)
  })

  it('o "não" encerra a sequência de retentativas: o contador zera como numa auditoria completa', async () => {
    const board = fakeBoard([card()])
    const failing = { close: true }
    const runClaude = vi.fn(async (request: PoObserverRequest) =>
      request.phase === 'close' && failing.close
        ? { provider: 'claude' as const, state: 'failed' as const }
        : { provider: 'claude' as const, state: 'completed' as const, text: 'OK' }
    )
    const verdict: { close: boolean | null } = { close: null }
    const gate = vi.fn(async (input: BoardGateInput) => (input.phase === 'close' ? verdict.close : null))
    let now = 1_000_000
    const { scheduleFlush, scheduled } = fakeScheduler()
    const retries = () => scheduled.filter((entry) => entry.delayMs === PO_RETRY_DELAY_MS)
    const po = new Po({ config, board, runClaude, gate, now: () => now, scheduleFlush })

    // Falha, retentativa 1 falha: o teto de 2 está gasto.
    po.noteUserMessage('conv-1', 'C:/p', 'termina a tabela')
    po.observe('conv-1', result)
    await flush()
    now += PO_RETRY_DELAY_MS
    retries()[0].fn()
    await flush()
    expect(retries()).toHaveLength(2)

    // Retentativa 2: o gate diz "não" — julgado, nada reagendado.
    verdict.close = false
    now += PO_RETRY_DELAY_MS
    retries()[1].fn()
    await flush()
    expect(retries()).toHaveLength(2)

    // Um turno no cooldown e o flush dele (não um turno real) falhando: se o
    // "não" não tivesse zerado o contador, o teto gasto impediria a retentativa.
    verdict.close = null
    now += 5_000
    po.noteUserMessage('conv-1', 'C:/p', 'mais uma coisa')
    po.observe('conv-1', result)
    await flush()
    scheduled.filter((entry) => !entry.cancelled && entry.delayMs !== PO_RETRY_DELAY_MS).forEach((entry) => entry.fn())
    await flush()

    expect(retries()).toHaveLength(3)
  })
})

describe('Po — gate sem decisão segue como hoje', () => {
  it('null: consulta o modelo e escreve normalmente', async () => {
    const board = fakeBoard([card({ sourceStatus: 'in_progress' })])
    const runClaude = writingClaude()
    const po = new Po({ config, board, runClaude, gate: async () => null })

    po.noteUserMessage('conv-1', 'C:/p', 'termina a tabela')
    po.observe('conv-1', result)
    await flush()

    expect(runClaude.mock.calls.map(([request]) => request.phase)).toEqual(['open', 'close'])
    expect(board.applyPo).toHaveBeenCalledWith({ id: 'bi-1', poStatus: 'completed', poReason: 'o teste passou' })
  })

  it('gate lançando: consulta o modelo mesmo assim', async () => {
    const board = fakeBoard([card({ sourceStatus: 'in_progress' })])
    const runClaude = writingClaude()
    const gate = vi.fn(async () => {
      throw new Error('TypeSafe fora do ar')
    })
    const po = new Po({ config, board, runClaude, gate })

    po.noteUserMessage('conv-1', 'C:/p', 'termina a tabela')
    po.observe('conv-1', result)
    await flush()

    expect(gate).toHaveBeenCalledTimes(2)
    expect(runClaude).toHaveBeenCalledTimes(2)
    expect(board.applyPo).toHaveBeenCalledWith({ id: 'bi-1', poStatus: 'completed', poReason: 'o teste passou' })
  })

  it('gate inativo: nem pergunta, e o modelo roda', async () => {
    const board = fakeBoard([card()])
    const runClaude = writingClaude()
    const gate = vi.fn(async () => false)
    const po = new Po({ config, board, runClaude, gate, gateActive: async () => false })

    po.noteUserMessage('conv-1', 'C:/p', 'corrige a exportação')
    await flush()

    expect(gate).not.toHaveBeenCalled()
    expect(runClaude).toHaveBeenCalledTimes(1)
    expect(board.createPoItem).toHaveBeenCalledTimes(1)
  })

  it('sonda de atividade lançando também é ausência de decisão', async () => {
    const board = fakeBoard([card()])
    const runClaude = writingClaude()
    const po = new Po({
      config,
      board,
      runClaude,
      gate: async () => false,
      gateActive: async () => {
        throw new Error('cofre ilegível')
      }
    })

    po.noteUserMessage('conv-1', 'C:/p', 'corrige a exportação')
    await flush()

    expect(runClaude).toHaveBeenCalledTimes(1)
  })
})

describe('Po — gate "sim"', () => {
  it('segue normal e o gate vê o mesmo material do digest, depois do quadro e antes do anúncio', async () => {
    const board = fakeBoard([card({ sourceStatus: 'in_progress', poTitle: 'Tabela do quadro' })])
    const order: string[] = []
    board.list.mockImplementation(async () => {
      order.push('list')
      return [card({ sourceStatus: 'in_progress', poTitle: 'Tabela do quadro' })]
    })
    const runClaude = writingClaude()
    const inputs: BoardGateInput[] = []
    const gate = vi.fn(async (input: BoardGateInput) => {
      order.push(`gate:${input.phase}`)
      inputs.push(input)
      return true
    })
    const listConvTasks = vi.fn(async () => [{ title: 'Tabela do quadro', status: 'done' }])
    const po = new Po({
      config,
      board,
      runClaude,
      gate,
      listConvTasks,
      diagnose: (event) => order.push(`${event.phase}:${event.round}`)
    })

    po.noteUserMessage('conv-1', 'C:/p', 'termina a tabela')
    await flush()
    po.observe('conv-1', toolUse('Edit', { file_path: 'src/quadro.ts' }))
    po.observe('conv-1', result)
    await flush()

    expect(board.applyPo).toHaveBeenCalledWith({ id: 'bi-1', poStatus: 'completed', poReason: 'o teste passou' })
    const close = inputs.find((input) => input.phase === 'close')
    expect(close).toEqual({
      phase: 'close',
      userText: 'termina a tabela',
      cards: [{ title: 'Tabela do quadro', status: 'in_progress' }],
      calls: [{ tool: 'Edit', detail: expect.stringContaining('src/quadro.ts') }],
      ledgerTasks: [{ title: 'Tabela do quadro', status: 'done' }]
    })
    // Em cada fase: o quadro é lido, o gate decide, e só então a auditoria começa.
    const closeOrder = order.slice(order.indexOf('gate:open') + 1)
    expect(order.indexOf('list')).toBeLessThan(order.indexOf('gate:open'))
    expect(order.indexOf('gate:open')).toBeLessThan(order.indexOf('claude-started:open'))
    expect(closeOrder.indexOf('gate:close')).toBeLessThan(closeOrder.indexOf('claude-started:close'))
  })
})
