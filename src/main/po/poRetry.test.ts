// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { BoardConfig, BoardItem, ChatEvent } from '../../shared/ipc'
import type { BoardService } from '../board/boardService'
import { Po, PO_MAX_RETRIES, PO_RETRY_DELAY_MS } from './po'
import { requeueTurn, restoreTaken, type PoTurnSnapshot } from './poQueue'

/**
 * A retentativa: uma análise que passou do cooldown e não chegou ao fim agenda
 * sozinha uma nova análise, em vez de deixar a evidência parada na fila até um
 * próximo turno que pode nunca chegar.
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

const config = (): BoardConfig => ({ requirePlan: true, po: { enabled: true, model: 'claude-sonnet-5' } })

/** `down` desliga o quadro (list → null) sem trocar o dublê. */
function fakeBoard() {
  const control = { down: false }
  const board = {
    settled: vi.fn(async () => undefined),
    list: vi.fn(async () => (control.down ? null : [card()])),
    projectId: vi.fn(async () => 'p'),
    applyPo: vi.fn(async () => null),
    createPoItem: vi.fn(async () => null)
  } as unknown as BoardService & { applyPo: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> }
  return { board, control }
}

const result: ChatEvent = { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 }
const toolUse = (name: string, input: unknown): ChatEvent => ({ kind: 'tool-use', id: `t-${name}`, name, input, parentToolUseId: null })
const isClose = (prompt: string): boolean => prompt.includes('AÇÕES DESTE TURNO')

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
  const retries = () => scheduled.filter((entry) => entry.delayMs === PO_RETRY_DELAY_MS)
  return { scheduleFlush, scheduled, retries }
}

/** Um `ask` em que o FECHAMENTO falha enquanto `failing.close` for verdadeiro;
 *  a abertura sempre responde OK, para isolar a fila do fechamento. */
function flakyAsk(answer = 'CONCLUIR bi-1 | o arquivo foi escrito e o teste passou') {
  const failing = { close: true }
  const closes: string[] = []
  const ask = vi.fn(async (prompt: string) => {
    if (!isClose(prompt)) return 'OK'
    closes.push(prompt)
    if (failing.close) throw new Error('Claude indisponível')
    return answer
  })
  return { ask, failing, closes }
}

describe('Po — retentativa quando a auditoria falha', () => {
  it('a falha agenda a retentativa daqui a 60 s pelo scheduleFlush injetado', async () => {
    const { board } = fakeBoard()
    const { ask } = flakyAsk()
    const { scheduleFlush, retries } = fakeScheduler()
    const po = new Po({ config, board, ask, now: () => 1_000_000, scheduleFlush })

    po.noteUserMessage('conv-1', 'C:/p', 'termina a tabela')
    po.observe('conv-1', result)
    await flush()

    expect(PO_RETRY_DELAY_MS).toBe(60_000)
    expect(retries()).toHaveLength(1)
    expect(retries()[0].cancelled).toBe(false)
  })

  it('a retentativa bem-sucedida aplica o CONCLUIR com a evidência do turno que falhou', async () => {
    const { board } = fakeBoard()
    const { ask, failing, closes } = flakyAsk()
    let now = 1_000_000
    const { scheduleFlush, retries } = fakeScheduler()
    const po = new Po({ config, board, ask, now: () => now, scheduleFlush })

    po.noteUserMessage('conv-1', 'C:/p', 'termina a tabela do quadro')
    po.observe('conv-1', toolUse('Edit', { file_path: 'src/quadro.ts' }))
    po.observe('conv-1', result)
    await flush()
    expect(board.applyPo).not.toHaveBeenCalled()

    // Ninguém manda mais nada: é a retentativa, não um próximo turno, que julga.
    failing.close = false
    now += PO_RETRY_DELAY_MS
    retries()[0].fn()
    await flush()

    expect(closes).toHaveLength(2)
    expect(closes[1]).toContain('termina a tabela do quadro')
    expect(closes[1]).toContain('src/quadro.ts')
    expect(board.applyPo).toHaveBeenCalledWith({
      id: 'bi-1',
      poStatus: 'completed',
      poReason: 'o arquivo foi escrito e o teste passou'
    })
    // Auditou: nada mais fica agendado.
    expect(retries()).toHaveLength(1)
  })

  it(`para depois de ${PO_MAX_RETRIES} retentativas falhas — a evidência fica na fila para o próximo turno`, async () => {
    const { board } = fakeBoard()
    const { ask, failing, closes } = flakyAsk()
    let now = 1_000_000
    const { scheduleFlush, retries } = fakeScheduler()
    const po = new Po({ config, board, ask, now: () => now, scheduleFlush })

    po.noteUserMessage('conv-1', 'C:/p', 'termina a tabela do quadro')
    po.observe('conv-1', result)
    await flush()

    for (let attempt = 0; attempt < PO_MAX_RETRIES; attempt += 1) {
      now += PO_RETRY_DELAY_MS
      retries()[attempt].fn()
      await flush()
    }
    // A análise original + as retentativas, e nenhuma retentativa a mais.
    expect(closes).toHaveLength(1 + PO_MAX_RETRIES)
    expect(retries()).toHaveLength(PO_MAX_RETRIES)

    // O próximo turno real ainda recebe o que ficou na fila.
    failing.close = false
    now += 120_000
    po.noteUserMessage('conv-1', 'C:/p', 'e agora?')
    po.observe('conv-1', result)
    await flush()
    expect(closes.at(-1)).toContain('termina a tabela do quadro')
    expect(closes.at(-1)).toContain('e agora?')
  })

  it('um turno REAL novo zera o contador: esgotado o teto, a falha seguinte volta a agendar', async () => {
    const { board } = fakeBoard()
    const { ask } = flakyAsk()
    let now = 1_000_000
    const { scheduleFlush, retries } = fakeScheduler()
    const po = new Po({ config, board, ask, now: () => now, scheduleFlush })

    po.noteUserMessage('conv-1', 'C:/p', 'primeiro')
    po.observe('conv-1', result)
    await flush()
    for (let attempt = 0; attempt < PO_MAX_RETRIES; attempt += 1) {
      now += PO_RETRY_DELAY_MS
      retries()[attempt].fn()
      await flush()
    }
    expect(retries()).toHaveLength(PO_MAX_RETRIES)

    now += 120_000
    po.noteUserMessage('conv-1', 'C:/p', 'segundo')
    po.observe('conv-1', result)
    await flush()

    expect(retries()).toHaveLength(PO_MAX_RETRIES + 1)
    expect(retries().at(-1)?.cancelled).toBe(false)
  })

  it('dispose cancela a retentativa pendente e faz a última chance, sem reagendar nada depois', async () => {
    const { board } = fakeBoard()
    const { ask, closes } = flakyAsk()
    const { scheduleFlush, scheduled, retries } = fakeScheduler()
    const po = new Po({ config, board, ask, now: () => 1_000_000, scheduleFlush })

    po.noteUserMessage('conv-1', 'C:/p', 'termina a tabela do quadro')
    po.observe('conv-1', result)
    await flush()
    expect(retries()).toHaveLength(1)

    po.dispose('conv-1')
    await po.settled('conv-1')
    await flush()

    expect(retries()[0].cancelled).toBe(true)
    // A última chance rodou (e falhou de novo), mas a conversa já não existe:
    // nenhum temporizador novo pode revivê-la.
    expect(closes).toHaveLength(2)
    expect(closes[1]).toContain('termina a tabela do quadro')
    expect(scheduled).toHaveLength(1)
  })

  it('quadro indisponível também agenda a retentativa, e ela julga quando o quadro volta', async () => {
    const { board, control } = fakeBoard()
    const { ask, failing, closes } = flakyAsk()
    failing.close = false
    let now = 1_000_000
    const { scheduleFlush, retries } = fakeScheduler()
    const po = new Po({ config, board, ask, now: () => now, scheduleFlush })

    control.down = true
    po.noteUserMessage('conv-1', 'C:/p', 'termina a tabela do quadro')
    po.observe('conv-1', result)
    await flush()
    expect(closes).toHaveLength(0)
    // Uma por fase: a abertura também não conseguiu ler o quadro.
    expect(retries()).toHaveLength(2)

    control.down = false
    now += PO_RETRY_DELAY_MS
    retries().forEach((entry) => entry.fn())
    await flush()

    expect(closes).toHaveLength(1)
    expect(closes[0]).toContain('termina a tabela do quadro')
    expect(board.applyPo).toHaveBeenCalledWith(expect.objectContaining({ id: 'bi-1', poStatus: 'completed' }))
  })

  it('sem segundo temporizador na fase: um flush do cooldown já agendado leva a evidência', async () => {
    const { board } = fakeBoard()
    let releaseClose = (): void => {}
    const closeHeld = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    const ask = vi.fn(async (prompt: string) => {
      if (!isClose(prompt)) return 'OK'
      await closeHeld
      throw new Error('Claude indisponível')
    })
    let now = 1_000_000
    const { scheduleFlush, scheduled, retries } = fakeScheduler()
    const po = new Po({ config, board, ask, now: () => now, scheduleFlush })

    po.noteUserMessage('conv-1', 'C:/p', 'turno A')
    po.observe('conv-1', result)
    await flush()

    // Enquanto o fechamento de A está no modelo, o turno B cai no cooldown e
    // arma o flush das duas fases.
    now += 5_000
    po.noteUserMessage('conv-1', 'C:/p', 'turno B')
    po.observe('conv-1', result)
    await flush()
    expect(scheduled).toHaveLength(2)

    releaseClose()
    await po.settled('conv-1')

    expect(retries()).toHaveLength(0)
    expect(scheduled).toHaveLength(2)
  })
})

describe('Po — a volta para a fila respeita a ordem cronológica', () => {
  it('saída ANTES de retirar a fila (quadro indisponível): o turno de agora vai para o FIM', async () => {
    const { board, control } = fakeBoard()
    const { ask, failing, closes } = flakyAsk('OK')
    failing.close = false
    let now = 1_000_000
    const { scheduleFlush, retries } = fakeScheduler()
    const po = new Po({ config, board, ask, now: () => now, scheduleFlush })

    po.noteUserMessage('conv-1', 'C:/p', 'primeiro')
    po.observe('conv-1', result)
    await flush()

    now += 5_000
    po.noteUserMessage('conv-1', 'C:/p', 'pedido antigo')
    po.observe('conv-1', result)
    await flush()

    control.down = true
    now += 120_000
    po.noteUserMessage('conv-1', 'C:/p', 'pedido que falhou')
    po.observe('conv-1', result)
    await flush()

    control.down = false
    now += PO_RETRY_DELAY_MS
    retries().forEach((entry) => entry.fn())
    await flush()

    // Antes da correção, o turno de agora voltava NA FRENTE do acumulado antigo.
    expect(closes.at(-1)).toContain('(1) pedido antigo (2) pedido que falhou')
  })

  it('requeueTurn põe o turno no fim; restoreTaken põe o acumulado retirado na frente do que chegou depois', () => {
    const turn = (userText: string): PoTurnSnapshot => ({ userText, cwd: 'C:/p', calls: [{ tool: 'Edit', detail: userText }] })
    const queue = { texts: ['antigo'], calls: [{ tool: 'Edit', detail: 'antigo' }] }

    expect(requeueTurn(queue, turn('agora'))?.texts).toEqual(['antigo', 'agora'])
    expect(restoreTaken({ texts: ['chegou depois'], calls: [] }, queue, turn('agora'))?.texts).toEqual([
      'antigo',
      'agora',
      'chegou depois'
    ])
  })

  it('o turno vazio do flush/retentativa não deixa entrada vazia na fila', () => {
    const empty: PoTurnSnapshot = { userText: '', cwd: 'C:/p', calls: [] }
    const queue = { texts: ['antigo'], calls: [] }

    expect(requeueTurn(queue, empty)).toBe(queue)
    expect(requeueTurn(null, empty)).toBeNull()
    expect(restoreTaken(null, queue, empty)?.texts).toEqual(['antigo'])
    expect(restoreTaken(null, null, empty)).toBeNull()
  })
})
