// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { BoardConfig, BoardItem, ChatEvent, PoProviderDiagnostic } from '../../shared/ipc'
import type { BoardService } from '../board/boardService'
import { classifyClaudeObserverFailure } from '../observerQuery'
import { Po, type PoObserverRequest } from './po'

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

function fakeBoard(cards: BoardItem[]) {
  return {
    settled: vi.fn(async () => undefined),
    list: vi.fn(async () => cards),
    applyPo: vi.fn(async () => null),
    createPoItem: vi.fn(async () => null)
  } as unknown as BoardService & {
    settled: ReturnType<typeof vi.fn>
    list: ReturnType<typeof vi.fn>
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

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('Po', () => {
  it('conclui no quadro a tarefa que o agente terminou e esqueceu de marcar', async () => {
    const board = fakeBoard([card()])
    const ask = vi.fn(async () => 'CONCLUIR bi-1 | o arquivo foi escrito e o teste passou')
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

  it('roda no FIM do turno, uma vez só', async () => {
    const board = fakeBoard([card()])
    const ask = vi.fn(async () => 'OK')
    const po = new Po({ config: () => config(), board, ask })

    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', toolUse('Edit', { file_path: 'a' }))
    po.observe('conv-1', toolUse('Edit', { file_path: 'b' }))
    expect(ask).not.toHaveBeenCalled()

    po.observe('conv-1', result)
    po.observe('conv-1', result)
    await flush()
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('OK não escreve nada no quadro', async () => {
    const board = fakeBoard([card()])
    const po = new Po({ config: () => config(), board, ask: vi.fn(async () => 'OK') })
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
      ask: vi.fn(async () => 'CONCLUIR bi-1 | o arquivo foi escrito e o teste passou')
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
    const po = new Po({
      config: () => config(),
      board,
      ask: vi.fn(async () => 'CONCLUIR bi-1 | de novo')
    })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', result)
    await flush()
    expect(board.applyPo).not.toHaveBeenCalled()
  })

  it('guarda as ÚLTIMAS ações do turno — a evidência está no fim, não no começo', async () => {
    const board = fakeBoard([card()])
    const ask = vi.fn(async () => 'OK')
    const po = new Po({ config: () => config(), board, ask })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    for (let i = 0; i < 40; i += 1) {
      po.observe('conv-1', toolUse('Read', { file_path: `leitura-${i}.ts` }))
    }
    po.observe('conv-1', toolUse('Bash', { command: 'npx vitest run' }))
    po.observe('conv-1', result)
    await flush()
    const prompt = String(ask.mock.calls.at(0)?.at(0) ?? '')
    expect(prompt).toContain('npx vitest run')
    expect(prompt).not.toContain('leitura-0.ts')
  })

  it('turno que morreu em erro não é analisado', async () => {
    const board = fakeBoard([card()])
    const ask = vi.fn(async () => 'CONCLUIR bi-1 | x')
    const po = new Po({ config: () => config(), board, ask })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', { kind: 'error', id: 'e', text: 'caiu' })
    po.observe('conv-1', result)
    await flush()
    expect(ask).not.toHaveBeenCalled()
  })

  it('sem mensagem do usuário não roda (retomada de sessão, recuperação de turno)', async () => {
    const board = fakeBoard([card()])
    const ask = vi.fn(async () => 'OK')
    const po = new Po({ config: () => config(), board, ask })
    po.observe('conv-1', result)
    await flush()
    expect(ask).not.toHaveBeenCalled()
  })

  it('desligado na configuração não chama o modelo', async () => {
    const board = fakeBoard([card()])
    const ask = vi.fn(async () => 'OK')
    const po = new Po({ config: () => config({ enabled: false }), board, ask })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', result)
    await flush()
    expect(ask).not.toHaveBeenCalled()
  })

  it('respeita o cooldown entre turnos da mesma conversa', async () => {
    const board = fakeBoard([card()])
    const ask = vi.fn(async () => 'OK')
    let now = 1_000_000
    const po = new Po({ config: () => config(), board, ask, now: () => now })

    po.noteUserMessage('conv-1', 'C:/p', 'um')
    po.observe('conv-1', result)
    await flush()

    now += 5_000
    po.noteUserMessage('conv-1', 'C:/p', 'dois')
    po.observe('conv-1', result)
    await flush()
    expect(ask).toHaveBeenCalledTimes(1)

    now += 120_000
    po.noteUserMessage('conv-1', 'C:/p', 'três')
    po.observe('conv-1', result)
    await flush()
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('quadro vazio não gasta chamada ao modelo', async () => {
    const board = fakeBoard([])
    const ask = vi.fn(async () => 'OK')
    const po = new Po({ config: () => config(), board, ask })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', result)
    await flush()
    expect(ask).not.toHaveBeenCalled()
  })

  it('espera a ingestão do snapshot antes de julgar', async () => {
    const board = fakeBoard([card()])
    const po = new Po({ config: () => config(), board, ask: vi.fn(async () => 'OK') })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', result)
    await flush()
    expect(board.settled).toHaveBeenCalledWith('conv-1')
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

  it('cria o cartão da tarefa que surgiu e nunca foi declarada', async () => {
    const board = fakeBoard([card()])
    const po = new Po({
      config: () => config(),
      board,
      ask: vi.fn(async () => 'NOVA | Documentar o quadro | o agente disse que falta documentar')
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

  it('dispose esquece a conversa', async () => {
    const board = fakeBoard([card()])
    const ask = vi.fn(async () => 'OK')
    const po = new Po({ config: () => config(), board, ask })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.dispose('conv-1')
    po.observe('conv-1', result)
    await flush()
    expect(ask).not.toHaveBeenCalled()
  })

  it('mantém Claude como única tentativa quando ele conclui', async () => {
    const board = fakeBoard([card()])
    const runClaude = vi.fn(async () => ({ provider: 'claude' as const, state: 'completed' as const, text: 'OK' }))
    const runLuna = vi.fn()
    const po = new Po({ config: () => config(), board, runClaude, runLuna })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', result)
    await flush()

    expect(runClaude).toHaveBeenCalledTimes(1)
    expect(runLuna).not.toHaveBeenCalled()
  })

  it.each(['claude_plan', 'claude_auth', 'claude_authorization'] as const)('troca uma vez para Luna somente por %s estruturado', async (reason) => {
    const board = fakeBoard([card()])
    const runClaude = vi.fn(async () => ({ provider: 'claude' as const, state: 'failed' as const, reason }))
    const runLuna = vi.fn(async (request, started) => {
      started()
      return { provider: 'gpt-luna' as const, state: 'completed' as const, text: 'CONCLUIR bi-1 | confirmado pela Luna' }
    })
    const diagnostics: PoProviderDiagnostic[] = []
    const po = new Po({ config: () => config(), board, runClaude, runLuna, diagnose: (event) => diagnostics.push(event) })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', result)
    await flush()

    expect(runLuna).toHaveBeenCalledTimes(1)
    expect(board.applyPo).toHaveBeenCalledTimes(1)
    // A auditoria também ANUNCIA O FIM: sem isso o elenco mostraria o PO
    // trabalhando para sempre depois de um turno.
    expect(diagnostics.map(({ phase }) => phase)).toEqual([
      'claude-started',
      'claude-unavailable',
      'po-provider-switch',
      'gpt-luna-started',
      'audit-finished'
    ])
    expect(diagnostics.slice(1, 4)).toEqual([
      expect.objectContaining({ phase: 'claude-unavailable', actualProvider: 'claude', fallbackReason: reason }),
      expect.objectContaining({ phase: 'po-provider-switch', actualProvider: 'gpt-luna', fallbackReason: reason }),
      expect.objectContaining({ phase: 'gpt-luna-started', actualProvider: 'gpt-luna', fallbackReason: reason })
    ])
    // O fim conta o que foi de fato escrito no quadro, e pela rota vencedora.
    expect(diagnostics[4]).toEqual(
      expect.objectContaining({ phase: 'audit-finished', actualProvider: 'gpt-luna', appliedOps: 1 })
    )
  })

  it('faz uma única chamada Luna por account_on_hold estruturado do SDK', async () => {
    const reason = classifyClaudeObserverFailure({ type: 'assistant', error: 'account_on_hold' })
    if (reason !== 'claude_plan') throw new Error('account_on_hold precisa ser elegível ao failover')

    const board = fakeBoard([card()])
    const runClaude = vi.fn(async () => ({ provider: 'claude' as const, state: 'failed' as const, reason }))
    const runLuna = vi.fn(async (_request, started) => {
      started()
      return { provider: 'gpt-luna' as const, state: 'completed' as const, text: 'OK' }
    })
    const po = new Po({ config: () => config(), board, runClaude, runLuna })
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', result)
    await flush()

    expect(runClaude).toHaveBeenCalledTimes(1)
    expect(runLuna).toHaveBeenCalledTimes(1)
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
    const seen: unknown[] = []
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

    expect(seen).toEqual([expect.objectContaining({
      cwd: 'C:/a',
      conversationId: 'conv-1',
      projectId: 'project-a',
      correlationId: 'correlation-a',
      model: 'claude-sonnet-5'
    })])
  })

  it('preserva a evidência do turno quando o próximo começa durante a fila do quadro', async () => {
    const board = fakeBoard([card()])
    let releaseSettled: (() => void) | undefined
    board.settled.mockImplementation(() => new Promise<void>((resolve) => {
      releaseSettled = resolve
    }))
    const runClaude = vi.fn(async (_request: PoObserverRequest) => ({ provider: 'claude' as const, state: 'completed' as const, text: 'OK' }))
    const po = new Po({ config: () => config(), board, runClaude })

    po.noteUserMessage('conv-1', 'C:/turn-a', 'pedido do turno A')
    po.observe('conv-1', toolUse('Edit', { file_path: 'src/turn-a.ts' }))
    po.observe('conv-1', result)
    expect(releaseSettled).toBeDefined()

    po.noteUserMessage('conv-1', 'C:/turn-b', 'pedido do turno B')
    po.observe('conv-1', toolUse('Bash', { command: 'teste-do-turno-b' }))
    releaseSettled!()
    await flush()

    expect(board.list).toHaveBeenCalledWith('C:/turn-a', { conversationId: 'conv-1' })
    const request = runClaude.mock.calls[0]?.[0]
    expect(request).toBeDefined()
    if (!request) throw new Error('Claude não recebeu o pedido do PO')
    expect(request.prompt).toContain('pedido do turno A')
    expect(request.prompt).toContain('src/turn-a.ts')
    expect(request.prompt).not.toContain('pedido do turno B')
    expect(request.prompt).not.toContain('teste-do-turno-b')
  })
})
