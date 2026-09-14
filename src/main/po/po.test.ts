// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { BoardConfig, BoardItem, ChatEvent } from '../../shared/ipc'
import type { BoardService } from '../board/boardService'
import { Po } from './po'

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
})
