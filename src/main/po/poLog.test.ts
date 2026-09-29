// @vitest-environment node
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardConfig, BoardItem, ChatEvent } from '../../shared/ipc'
import type { BoardService } from '../board/boardService'
import { Po } from './po'
import { createPoLogWriter, type PoLogEntry } from './poLog'

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

const config = (): BoardConfig => ({ requirePlan: true, po: { enabled: true, model: 'claude-sonnet-5-5' } })

function fakeBoard(cards: BoardItem[] | null, projectId = 'p') {
  return {
    settled: vi.fn(async () => undefined),
    list: vi.fn(async () => (cards ? [...cards] : null)),
    projectId: vi.fn(async () => projectId),
    applyPo: vi.fn(async () => null),
    createPoItem: vi.fn(async () => card({ id: 'bi-new' }))
  } as unknown as BoardService
}

const result: ChatEvent = { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 }
const SECRET = 'segredo-do-usuario-123'

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function setup(opts: {
  cards?: BoardItem[] | null
  projectId?: string
  ask?: (prompt: string) => Promise<string>
  gate?: () => Promise<boolean | null>
  now?: () => number
  decisionLog?: (entry: PoLogEntry) => void
}) {
  const entries: PoLogEntry[] = []
  const po = new Po({
    config,
    board: fakeBoard(opts.cards === undefined ? [card()] : opts.cards, opts.projectId),
    ask: vi.fn(opts.ask ?? (async () => 'OK')),
    ...(opts.gate ? { gate: opts.gate } : { gateActive: async () => false }),
    ...(opts.now ? { now: opts.now } : {}),
    scheduleFlush: () => () => undefined,
    decisionLog: opts.decisionLog ?? ((entry) => entries.push(entry))
  })
  return { po, entries }
}

describe('Po — diário de decisões (uma linha por rodada)', () => {
  it('registra "ok" quando a rodada chega ao fim sem aplicar nada, sem o texto do usuário', async () => {
    const { po, entries } = setup({})
    po.noteUserMessage('conv-1', 'C:/p', SECRET)
    await flush()
    expect(entries).toEqual([
      expect.objectContaining({ conversationId: 'conv-1', phase: 'open', outcome: 'ok', route: 'claude', cards: [] })
    ])
    expect(JSON.stringify(entries)).not.toContain(SECRET)
  })

  it('registra ops=N e os cartões escritos', async () => {
    const { po, entries } = setup({
      ask: async (prompt) => (prompt.includes('AÇÕES DESTE TURNO') ? 'CONCLUIR bi-1 | o teste rodou' : 'OK')
    })
    po.noteUserMessage('conv-1', 'C:/p', 'faz x')
    po.observe('conv-1', result)
    await flush()
    expect(entries.find((e) => e.phase === 'close')).toMatchObject({ outcome: 'ops=1', cards: ['bi-1'] })
  })

  it('registra o gate "não" sem rota de modelo', async () => {
    const { po, entries } = setup({ gate: async () => false })
    po.noteUserMessage('conv-1', 'C:/p', 'por que?')
    await flush()
    expect(entries).toEqual([expect.objectContaining({ outcome: 'gate-nao', route: null })])
  })

  it('registra o cooldown da segunda mensagem em menos de 60 s', async () => {
    const { po, entries } = setup({ now: () => 1_000_000 })
    po.noteUserMessage('conv-1', 'C:/p', 'um')
    await flush()
    po.noteUserMessage('conv-1', 'C:/p', 'dois')
    await flush()
    expect(entries.map((e) => e.outcome)).toEqual(['ok', 'cooldown'])
  })

  it('registra "falha" quando o modelo não responde', async () => {
    const { po, entries } = setup({
      ask: async () => {
        throw new Error('fora do ar')
      }
    })
    po.noteUserMessage('conv-1', 'C:/p', 'faz x')
    await flush()
    expect(entries).toEqual([expect.objectContaining({ outcome: 'falha', route: 'claude' })])
  })

  it('registra "quadro-indisponivel" sem quadro ou sem identidade de projeto', async () => {
    const a = setup({ cards: null })
    a.po.noteUserMessage('conv-1', 'C:/p', 'faz x')
    const b = setup({ projectId: '' })
    b.po.noteUserMessage('conv-1', 'C:/p', 'faz x')
    await flush()
    expect(a.entries).toEqual([expect.objectContaining({ outcome: 'quadro-indisponivel', route: null })])
    expect(b.entries).toEqual([expect.objectContaining({ outcome: 'quadro-indisponivel', route: null })])
  })

  it('um gravador que lança não derruba a análise', async () => {
    const applyPo = vi.fn(async () => null)
    const po = new Po({
      config,
      board: { ...fakeBoard([card()]), applyPo } as unknown as BoardService,
      ask: async (prompt) => (prompt.includes('AÇÕES DESTE TURNO') ? 'CONCLUIR bi-1 | o teste rodou' : 'OK'),
      gateActive: async () => false,
      decisionLog: () => {
        throw new Error('disco cheio')
      }
    })
    po.noteUserMessage('conv-1', 'C:/p', 'faz x')
    po.observe('conv-1', result)
    await flush()
    expect(applyPo).toHaveBeenCalledWith({ id: 'bi-1', poStatus: 'completed', poReason: 'o teste rodou' })
  })
})

describe('createPoLogWriter', () => {
  let dir = ''
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = ''
  })

  const entry: PoLogEntry = {
    at: '2026-09-29T00:00:00.000Z',
    conversationId: 'conv-1',
    phase: 'close',
    outcome: 'ops=2',
    route: 'claude',
    durationMs: 12,
    cards: ['bi-1', 'bi-2']
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  }

  it('grava uma linha JSON por entrada', async () => {
    dir = await mkdtemp(join(tmpdir(), 'po-log-'))
    const file = join(dir, 'sub', 'po-decisions.log')
    const write = createPoLogWriter(async () => file)
    write(entry)
    write({ ...entry, phase: 'open', outcome: 'gate-nao', route: null, cards: [] })
    await settle()
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toEqual([entry, { ...entry, phase: 'open', outcome: 'gate-nao', route: null, cards: [] }])
  })

  it('rotaciona para .1 quando o arquivo passa do teto', async () => {
    dir = await mkdtemp(join(tmpdir(), 'po-log-'))
    const file = join(dir, 'po-decisions.log')
    await writeFile(file, 'x'.repeat(2 * 1024 * 1024 + 1))
    const write = createPoLogWriter(async () => file)
    write(entry)
    await settle()
    expect((await stat(`${file}.1`)).size).toBeGreaterThan(2 * 1024 * 1024)
    expect(JSON.parse((await readFile(file, 'utf8')).trim())).toEqual(entry)
  })

  it('caminho não gravável não lança nem trava as próximas linhas', async () => {
    dir = await mkdtemp(join(tmpdir(), 'po-log-'))
    // Um ARQUIVO no lugar da pasta: mkdir/appendFile falham com ENOTDIR/EEXIST.
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, '')
    let target = join(blocker, 'po-decisions.log')
    const write = createPoLogWriter(async () => target)
    expect(() => write(entry)).not.toThrow()
    await settle()
    target = join(dir, 'ok.log')
    write(entry)
    await settle()
    expect(JSON.parse((await readFile(target, 'utf8')).trim())).toEqual(entry)
  })
})
