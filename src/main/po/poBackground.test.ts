// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { BackgroundTask, BoardConfig, BoardItem, ChatEvent } from '../../shared/ipc'
import type { BoardService } from '../board/boardService'
import { Po } from './po'
import {
  buildPoDigest,
  PO_MAX_BACKGROUND_LINE_CHARS,
  PO_MAX_BACKGROUND_TASKS,
  PO_MAX_DIGEST_CHARS,
  PO_SYSTEM_PROMPT_CLOSE
} from './poPrompt'

/**
 * O PO diante do trabalho DELEGADO: o turno do agente principal acabou, mas um
 * subagente (ou um Bash) continua rodando em segundo plano. O digest do
 * fechamento tem que dizer isso, e a regra tem que segurar o CONCLUIR — o
 * trabalho do cartão está acontecendo, não terminou nem foi abandonado.
 */

const LABEL = 'TRABALHO EM SEGUNDO PLANO AINDA RODANDO:'

function card(over: Partial<BoardItem> = {}): BoardItem {
  return {
    id: 'bi-1',
    projectId: 'p',
    projectCwd: 'C:/p',
    conversationId: 'conv-1',
    origin: 'agent',
    sourceId: '1',
    sourceTitle: 'Exportação de XML',
    sourceStatus: 'in_progress',
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

const config = (): BoardConfig => ({ requirePlan: true, po: { enabled: true, model: 'claude-sonnet-5-5' } })

function fakeBoard(cards: BoardItem[]) {
  return {
    settled: vi.fn(async () => undefined),
    list: vi.fn(async () => [...cards]),
    projectId: vi.fn(async () => 'p'),
    applyPo: vi.fn(async () => null),
    createPoItem: vi.fn(async () => null)
  } as unknown as BoardService
}

const result: ChatEvent = { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 }
const subagente: BackgroundTask = { id: 'bg-1', type: 'local_agent', description: 'Implementar a exportação de XML' }
const background = (tasks: BackgroundTask[]): ChatEvent => ({ kind: 'background-tasks', tasks })

const isClose = (prompt: string): boolean => prompt.includes('AÇÕES DESTE TURNO')
function closes(ask: ReturnType<typeof vi.fn>): string[] {
  return ask.mock.calls.map((call) => String(call[0])).filter(isClose)
}

function section(digest: string): string {
  return digest.split(`${LABEL}\n`)[1]?.split('\n\n')[0] ?? ''
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('Po — fechamento com trabalho em segundo plano', () => {
  it('o digest do fechamento lista o que continua rodando no instante do result', async () => {
    const ask = vi.fn(async () => 'OK')
    const po = new Po({ config, board: fakeBoard([card()]), ask })
    po.noteUserMessage('conv-1', 'C:/p', 'implementa a exportação de XML')
    po.observe('conv-1', background([subagente, { id: 'bg-2', type: 'local_bash', description: '' }]))
    po.observe('conv-1', result)
    await flush()

    const digest = closes(ask)[0] ?? ''
    // Sem descrição, vale o tipo — a linha nunca sai em branco.
    expect(section(digest)).toBe('- Implementar a exportação de XML\n- local_bash')
    // E o prompt que acompanha esse digest é o que sabe o que fazer com ele.
    expect(digest).toContain('TRABALHO EM SEGUNDO PLANO AINDA RODANDO')
  })

  it('snapshot vazio (a última tarefa terminou) não gera seção — o fechamento volta a ser o de sempre', async () => {
    const ask = vi.fn(async () => 'OK')
    const po = new Po({ config, board: fakeBoard([card()]), ask })
    po.noteUserMessage('conv-1', 'C:/p', 'implementa a exportação de XML')
    po.observe('conv-1', background([subagente]))
    po.observe('conv-1', background([]))
    po.observe('conv-1', result)
    await flush()

    expect(closes(ask)[0]).not.toContain(LABEL)
  })

  it('o snapshot chega ANTES da mensagem do usuário (e depois do result anterior) e ainda assim conta', async () => {
    const ask = vi.fn(async () => 'OK')
    let now = 1_000_000
    const po = new Po({ config, board: fakeBoard([card()]), ask, now: () => now })
    // Fora de turno: sem pedido ainda, e o `result` anterior já disparou.
    po.observe('conv-1', background([subagente]))
    po.noteUserMessage('conv-1', 'C:/p', 'como está?')
    po.observe('conv-1', result)
    await flush()
    expect(section(closes(ask)[0] ?? '')).toBe('- Implementar a exportação de XML')

    now += 120_000
    po.observe('conv-1', background([]))
    po.noteUserMessage('conv-1', 'C:/p', 'e agora?')
    po.observe('conv-1', result)
    await flush()
    expect(closes(ask)[1]).not.toContain(LABEL)
  })

  it('o snapshot é por conversa', async () => {
    const ask = vi.fn(async () => 'OK')
    const po = new Po({ config, board: fakeBoard([card()]), ask })
    po.observe('conv-2', background([subagente]))
    po.noteUserMessage('conv-1', 'C:/p', 'x')
    po.observe('conv-1', result)
    await flush()

    expect(closes(ask)[0]).not.toContain(LABEL)
  })

  it('o flush do cooldown usa o estado de AGORA, não o de quando o turno foi adiado', async () => {
    const ask = vi.fn(async () => 'OK')
    const scheduled: (() => void)[] = []
    let now = 1_000_000
    const po = new Po({
      config,
      board: fakeBoard([card()]),
      ask,
      now: () => now,
      scheduleFlush: (_delay, fn) => {
        scheduled.push(fn)
        return () => undefined
      }
    })
    po.noteUserMessage('conv-1', 'C:/p', 'primeiro')
    po.observe('conv-1', result)
    await flush()

    // Segundo turno dentro do cooldown: adiado, com o subagente rodando.
    now += 5_000
    po.noteUserMessage('conv-1', 'C:/p', 'segundo')
    po.observe('conv-1', background([subagente]))
    po.observe('conv-1', result)
    await flush()
    expect(closes(ask)).toHaveLength(1)

    // O subagente terminou antes de a janela abrir: o flush não pode dizer
    // que ele ainda está rodando.
    po.observe('conv-1', background([]))
    now += 120_000
    for (const fn of scheduled.splice(0)) fn()
    await flush()
    const flushed = closes(ask).at(-1) ?? ''
    expect(flushed).toContain('segundo')
    expect(flushed).not.toContain(LABEL)
  })
})

describe('digest — seção de trabalho em segundo plano', () => {
  it('só aparece no fechamento — na abertura o turno ainda não aconteceu', () => {
    const open = buildPoDigest({ phase: 'open', userText: 'x', cards: [], calls: [], background: ['subagente'] })
    expect(open).not.toContain(LABEL)
    const close = buildPoDigest({ phase: 'close', userText: 'x', cards: [], calls: [], background: ['subagente'] })
    expect(section(close)).toBe('- subagente')
  })

  it('sem tarefa, sem seção: o digest fica exatamente como era', () => {
    const base = { phase: 'close' as const, userText: 'x', cards: [], calls: [] }
    expect(buildPoDigest({ ...base, background: [] })).toBe(buildPoDigest(base))
    expect(buildPoDigest({ ...base, background: ['   '] })).toBe(buildPoDigest(base))
  })

  it('tem teto de tarefas e de linha, e o pior caso cabe em PO_MAX_DIGEST_CHARS', () => {
    const digest = buildPoDigest({
      phase: 'close',
      userText: 'x',
      cards: [],
      calls: [],
      background: Array.from({ length: PO_MAX_BACKGROUND_TASKS + 4 }, (_, i) => `tarefa-${i} ${'d'.repeat(500)}`)
    })
    const lines = section(digest).split('\n')
    expect(lines).toHaveLength(PO_MAX_BACKGROUND_TASKS)
    expect(lines[0].startsWith('- tarefa-0 ddd')).toBe(true)
    expect(lines.every((line) => line.length === 2 + PO_MAX_BACKGROUND_LINE_CHARS)).toBe(true)
    expect(digest.length).toBeLessThanOrEqual(PO_MAX_DIGEST_CHARS)
  })
})

describe('prompt de fechamento — o card delegado continua em andamento', () => {
  it('manda não CONCLUIR sem prova de término o trabalho que está com um subagente rodando', () => {
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('TRABALHO EM SEGUNDO PLANO AINDA RODANDO')
    expect(PO_SYSTEM_PROMPT_CLOSE).toMatch(/continua EM ANDAMENTO/)
    expect(PO_SYSTEM_PROMPT_CLOSE).toMatch(/não use CONCLUIR[^.]*sem prova de término/i)
  })
})
