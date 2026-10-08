// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { BoardConfig, BoardItem, ChatEvent } from '../../shared/ipc'
import type { BoardService } from '../board/boardService'
import { etapaIdFromTitle } from '../handoffTracking/handoffCardMatch'
import type { BoardPoCreate, BoardPoWrite } from '../persistence/types'
import { Po } from './po'
import { applyPoVerdict, type PoApplyDeps, type PoApplyTarget } from './poApply'
import { buildPoPrompt, PO_MAX_ORPHANS, PO_MAX_TITLE_CHARS, PO_ORPHAN_SECTION, type PoOrphanEtapa } from './poPrompt'
import { PO_MAX_OPS } from './poPromptText'
import { buildPoRequest } from './poRequest'
import { parsePoVerdict, rejectUnsafeOps } from './poVerdict'

/**
 * As etapas do prompt SEM cartão no Quadro: o fechamento do PO recebe a lista
 * (`orphanEtapas`, ligada ao acompanhamento dos envios) e cria o cartão `[id]`
 * de cada uma — FEITA com evidência de que foi feita, NOVA sem ela. O prefixo
 * é o que liga o cartão à etapa, então ele atravessa o corte de título, a
 * barreira de duplicata e o teto de operações.
 */

function card(id: string, over: Partial<BoardItem> = {}): BoardItem {
  return {
    id,
    projectId: 'p',
    projectCwd: 'C:/p',
    conversationId: 'conv-1',
    origin: 'agent',
    sourceId: id,
    sourceTitle: `tarefa ${id}`,
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

const ORPHANS: PoOrphanEtapa[] = [
  { etapaId: 'etapa-2', titulo: 'Criar o endpoint de exportação' },
  { etapaId: 'etapa-3', titulo: 'Testar a exportação' }
]

const digestInput = {
  userText: 'Prompt 1 do plano',
  cards: [{ id: 'bi-1', title: '[etapa-1] Modelar a tabela', status: 'completed' as const }],
  calls: [{ tool: 'Write', detail: 'src/export.ts' }]
}

describe('digest do fechamento — a seção ETAPAS DO PROMPT SEM CARTÃO', () => {
  it('lista `[id] título` e a regra FEITA/NOVA só no fechamento e só com órfãs', () => {
    const prompt = buildPoPrompt({ ...digestInput, phase: 'close', orphans: ORPHANS })
    expect(prompt).toContain(`${PO_ORPHAN_SECTION}\n- [etapa-2] Criar o endpoint de exportação\n- [etapa-3] Testar a exportação`)
    expect(prompt).toContain('FEITA | [id] Título |')
    expect(prompt).toContain('NOVA | [id] Título |')

    expect(buildPoPrompt({ ...digestInput, phase: 'close' })).not.toContain(PO_ORPHAN_SECTION)
    expect(buildPoPrompt({ ...digestInput, phase: 'close', orphans: [] })).not.toContain(PO_ORPHAN_SECTION)
    expect(buildPoPrompt({ ...digestInput, phase: 'open', orphans: ORPHANS })).not.toContain(PO_ORPHAN_SECTION)
    // Sem órfãs o prompt é exatamente o de antes.
    expect(buildPoPrompt({ ...digestInput, phase: 'close', orphans: [] })).toBe(buildPoPrompt({ ...digestInput, phase: 'close' }))
  })

  it('teto próprio: no máximo PO_MAX_ORPHANS linhas, cada `[id] título` no corte do título do cartão (o prefixo fica)', () => {
    const many = Array.from({ length: PO_MAX_ORPHANS + 3 }, (_, i) => ({ etapaId: `e${i}`, titulo: `Etapa ${i} ${'x'.repeat(200)}` }))
    const prompt = buildPoPrompt({ ...digestInput, phase: 'close', orphans: many })
    const lines = prompt.split('\n').filter((line) => /^- \[e\d+\]/.test(line))
    expect(lines).toHaveLength(PO_MAX_ORPHANS)
    for (const line of lines) {
      expect(line.length - 2).toBeLessThanOrEqual(PO_MAX_TITLE_CHARS)
      expect(etapaIdFromTitle(line.slice(2))).toMatch(/^e\d+$/)
    }
  })

  it('buildPoRequest leva as órfãs ao prompt do fechamento', () => {
    const base = {
      config: { po: { model: 'm' } } as never,
      convId: 'c',
      cwd: 'C:/p',
      projectId: 'p',
      cards: [],
      userText: 'oi',
      calls: [],
      ledgerTasks: [],
      background: [],
      returned: [],
      correlationId: 'x',
      orphans: ORPHANS
    }
    expect(buildPoRequest({ ...base, phase: 'close' }).prompt).toContain('- [etapa-3] Testar a exportação')
    expect(buildPoRequest({ ...base, phase: 'open' }).prompt).not.toContain(PO_ORPHAN_SECTION)
  })
})

describe('parser — o prefixo [id] da etapa sem cartão', () => {
  const orphanIds = ORPHANS.map((o) => o.etapaId)

  it('FEITA nasce concluída e NOVA "a fazer", com o título `[id] …` intacto e a etapa marcada', () => {
    const raw = [
      'FEITA | [etapa-2] Criar o endpoint de exportação | as ações mostram src/export.ts escrito e o teste verde',
      'NOVA | [ETAPA-3] Testar a exportação | a resposta não fala de teste'
    ].join('\n')
    expect(parsePoVerdict(raw, [], 'close', orphanIds)).toEqual([
      {
        kind: 'create',
        title: '[etapa-2] Criar o endpoint de exportação',
        reason: 'as ações mostram src/export.ts escrito e o teste verde',
        status: 'completed',
        etapaId: 'etapa-2'
      },
      { kind: 'create', title: '[ETAPA-3] Testar a exportação', reason: 'a resposta não fala de teste', status: 'pending', etapaId: 'etapa-3' }
    ])
  })

  it('o corte de título não remove o prefixo — o casamento da etapa continua achando o cartão', () => {
    const long = `[etapa-2] ${'Criar o endpoint de exportação '.repeat(6)}`
    const [op] = parsePoVerdict(`FEITA | ${long} | feito`, [], 'close', orphanIds)
    expect(op).toMatchObject({ kind: 'create', etapaId: 'etapa-2' })
    expect(op.kind === 'create' && op.title.length).toBe(PO_MAX_TITLE_CHARS)
    expect(op.kind === 'create' && etapaIdFromTitle(op.title)).toBe('etapa-2')
    // Sem a lista, o prefixo também fica no título (só não marca a etapa).
    expect(parsePoVerdict('FEITA | [etapa-2] Criar | feito', [])).toEqual([
      { kind: 'create', title: '[etapa-2] Criar', reason: 'feito', status: 'completed' }
    ])
  })

  it('uma linha por etapa, fora do teto de operações; o teto continua valendo para o resto', () => {
    const regular = Array.from({ length: PO_MAX_OPS + 2 }, (_, i) => `NOVA | Tarefa ${i} | motivo`)
    const raw = [
      ...regular,
      'FEITA | [etapa-2] Criar o endpoint | feito',
      'NOVA | [etapa-2] Outro título para a mesma etapa | repetida',
      'NOVA | [etapa-3] Testar | falta'
    ].join('\n')
    const ops = parsePoVerdict(raw, [], 'close', orphanIds)
    expect(ops.filter((op) => op.kind === 'create' && !op.etapaId)).toHaveLength(PO_MAX_OPS)
    expect(ops.flatMap((op) => (op.kind === 'create' && op.etapaId ? [op.title] : []))).toEqual([
      '[etapa-2] Criar o endpoint',
      '[etapa-3] Testar'
    ])
    // Sem órfãs, nada muda: o teto corta tudo o que vem depois.
    expect(parsePoVerdict(raw, [], 'close')).toHaveLength(PO_MAX_OPS)
  })

  it('só no fechamento, e só a etapa listada: id de fora da lista e cartão de origem não marcam', () => {
    expect(parsePoVerdict('NOVA | [etapa-2] Criar | falta', [], 'open', orphanIds)).toEqual([
      { kind: 'create', title: '[etapa-2] Criar', reason: 'falta', status: 'in_progress' }
    ])
    expect(parsePoVerdict('NOVA | [etapa-9] Inventada | falta', [], 'close', orphanIds)).toEqual([
      { kind: 'create', title: '[etapa-9] Inventada', reason: 'falta', status: 'pending' }
    ])
    // A etapa não é pendência de outro cartão: o id de origem não vira pai.
    expect(parsePoVerdict('NOVA bi-1 | [etapa-2] Criar | falta', ['bi-1'], 'close', orphanIds)).toEqual([
      { kind: 'create', title: '[etapa-2] Criar', reason: 'falta', status: 'pending', etapaId: 'etapa-2' }
    ])
  })
})

describe('barreiras — a duplicata por título não barra a etapa sem cartão', () => {
  it('o cartão de título igual de OUTRO plano (o casamento o descartou) não barra; o cartão comum continua barrado', () => {
    const cards = [card('bi-velho', { sourceTitle: '[etapa-2] Criar o endpoint', sourceStatus: 'completed' })]
    const orphan = { kind: 'create' as const, title: '[etapa-2] Criar o endpoint', reason: 'feito', status: 'completed' as const, etapaId: 'etapa-2' }
    const common = { kind: 'create' as const, title: '[etapa-2] Criar o endpoint', reason: 'feito', status: 'completed' as const }
    expect(rejectUnsafeOps([orphan], cards)).toEqual([orphan])
    expect(rejectUnsafeOps([common], cards)).toEqual([])
    // Na mesma resposta, a cópia continua barrada.
    expect(rejectUnsafeOps([orphan, { ...orphan, etapaId: 'etapa-2' }], [])).toEqual([orphan])
  })
})

function applyDeps(fresh: BoardItem[], still: PoOrphanEtapa[] | Error) {
  const board = {
    list: vi.fn(async () => fresh),
    applyPo: vi.fn(async (_input: BoardPoWrite): Promise<BoardItem | null> => null),
    createPoItem: vi.fn(async (input: BoardPoCreate) => card('bi-po-1', { origin: 'po', sourceTitle: input.title }))
  }
  const orphanEtapas = vi.fn(async () => {
    if (still instanceof Error) throw still
    return still
  })
  return { board, orphanEtapas, linkableLedgerTasks: async () => [] } as PoApplyDeps & { board: typeof board; orphanEtapas: typeof orphanEtapas }
}

const target: PoApplyTarget = { convId: 'conv-1', cwd: 'C:/p', projectId: 'p', phase: 'close', startedAt: 0, returned: [], orphans: ORPHANS }
const progress = () => ({ applied: 0, touched: [] as string[] })

describe('aplicação — o cartão da etapa no quadro de agora', () => {
  it('cria com o título exato, sem pai inferido, depois de reconferir pelo casamento que a etapa segue sem cartão', async () => {
    const parent = card('bi-1', { sourceStatus: 'in_progress' })
    const d = applyDeps([parent], ORPHANS)
    const verdict = 'CONCLUIR bi-1 | entregue\nNOVA | [etapa-3] Testar a exportação | a resposta não fala de teste'
    await applyPoVerdict(d, target, verdict, [parent], progress())
    expect(d.orphanEtapas).toHaveBeenCalledWith('conv-1')
    expect(d.board.createPoItem).toHaveBeenCalledWith({
      projectId: 'p',
      projectCwd: 'C:/p',
      conversationId: 'conv-1',
      title: '[etapa-3] Testar a exportação',
      status: 'pending',
      reason: 'a resposta não fala de teste'
    })
  })

  it('a etapa que ganhou cartão durante a consulta (ou a reconferência que falha) não é criada', async () => {
    const verdict = 'FEITA | [etapa-2] Criar o endpoint de exportação | feito\nFEITA | Outra coisa feita | feito'
    const gone = applyDeps([], [ORPHANS[1]])
    await applyPoVerdict(gone, target, verdict, [], progress())
    expect(gone.board.createPoItem.mock.calls.map(([input]) => input.title)).toEqual(['Outra coisa feita'])

    const broken = applyDeps([], new Error('banco caiu'))
    await applyPoVerdict(broken, target, verdict, [], progress())
    expect(broken.board.createPoItem.mock.calls.map(([input]) => input.title)).toEqual(['Outra coisa feita'])
  })
})

const config = (enabled = true): BoardConfig => ({ requirePlan: true, po: { enabled, model: 'm' } })
const result: ChatEvent = { kind: 'result', id: 'r', isError: false, text: 'Pronto: src/export.ts criado.', durationMs: 1 }

function fakeBoard() {
  return {
    settled: vi.fn(async () => undefined),
    list: vi.fn(async () => [] as BoardItem[]),
    projectId: vi.fn(async () => 'p'),
    applyPo: vi.fn(async () => null),
    createPoItem: vi.fn(async (input: BoardPoCreate) => card('bi-po-1', { origin: 'po', sourceTitle: input.title }))
  } as unknown as BoardService & { createPoItem: ReturnType<typeof vi.fn> }
}

async function closeTurn(po: Po): Promise<void> {
  po.noteUserMessage('conv-1', 'C:/p', 'Prompt 1 do plano')
  po.observe('conv-1', result)
  await po.settled('conv-1')
}

describe('Po — o fechamento recebe as órfãs', () => {
  it('só o fechamento pergunta; o prompt leva a seção e o FEITA vira cartão `[id]`', async () => {
    const board = fakeBoard()
    const orphanEtapas = vi.fn(async () => ORPHANS)
    const ask = vi.fn(async (prompt: string) =>
      prompt.includes(PO_ORPHAN_SECTION) ? 'FEITA | [etapa-2] Criar o endpoint de exportação | a resposta diz src/export.ts criado' : 'OK'
    )
    const po = new Po({ config: () => config(), board, ask, orphanEtapas, gateActive: async () => false })
    await closeTurn(po)
    expect(orphanEtapas).toHaveBeenCalledTimes(2) // o digest e a reconferência antes de escrever
    expect(ask.mock.calls.filter(([prompt]) => prompt.includes(PO_ORPHAN_SECTION))).toHaveLength(1)
    expect(board.createPoItem).toHaveBeenCalledWith(
      expect.objectContaining({ title: '[etapa-2] Criar o endpoint de exportação', status: 'completed' })
    )
  })

  it('com órfãs o gate não decide (ele não as vê); sem órfãs, o "não" dele vale como sempre', async () => {
    const gate = vi.fn(async () => false)
    const ask = vi.fn(async () => 'OK')
    const withOrphans = new Po({ config: () => config(), board: fakeBoard(), ask, gate, orphanEtapas: async () => ORPHANS })
    await closeTurn(withOrphans)
    expect(ask).toHaveBeenCalledTimes(1)

    const without = new Po({ config: () => config(), board: fakeBoard(), ask, gate, orphanEtapas: async () => [] })
    await closeTurn(without)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('PO desligado: nada é lido nem criado; a ponte que falha só tira a seção', async () => {
    const off = vi.fn(async () => ORPHANS)
    const board = fakeBoard()
    await closeTurn(new Po({ config: () => config(false), board, ask: vi.fn(async () => 'OK'), orphanEtapas: off }))
    expect(off).not.toHaveBeenCalled()
    expect(board.createPoItem).not.toHaveBeenCalled()

    const ask = vi.fn(async (_prompt: string) => 'OK')
    const failing = vi.fn(async (): Promise<PoOrphanEtapa[]> => {
      throw new Error('banco caiu')
    })
    await closeTurn(new Po({ config: () => config(), board: fakeBoard(), ask, orphanEtapas: failing, gateActive: async () => false }))
    expect(ask).toHaveBeenCalledTimes(2)
    expect(ask.mock.calls.some(([prompt]) => String(prompt).includes(PO_ORPHAN_SECTION))).toBe(false)
  })
})
