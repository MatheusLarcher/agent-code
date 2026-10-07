// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { boardItemStatus, type BoardConfig, type BoardItem, type ChatEvent } from '../../shared/ipc'
import { BoardService } from '../board/boardService'
import { SqliteRepository } from '../persistence/sqliteRepository'
import type { BoardPoCreate } from '../persistence/types'
import { Po } from './po'
import { applyPoVerdict, type PoApplyDeps } from './poApply'
import { PO_DEFAULT_COMPLETE_REASON } from './poCloseDefault'
import { pendencyTitle, shapePendencies } from './poPendency'
import { PO_AWAITING_AUTHORIZATION_REASON } from './poPrompt'
import { parsePoVerdict } from './poVerdict'

function card(over: Partial<BoardItem> = {}): BoardItem {
  return {
    id: 'bi-pedido',
    projectId: 'p',
    projectCwd: 'C:/p',
    conversationId: 'c',
    origin: 'po',
    sourceId: null,
    sourceTitle: 'Implementar a fase 1 do escritório',
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

const AWAIT = PO_AWAITING_AUTHORIZATION_REASON

describe('veredito — NOVA com o cartão de origem', () => {
  const ids = ['bi-pedido', 'bi-outro']

  it('no fechamento, `NOVA <id> |` liga a pendência; id desconhecido vira NOVA comum', () => {
    const ops = parsePoVerdict(
      [`NOVA bi-pedido | Commitar a fase 1 | ${AWAIT}`, `NOVA bi-inventado | Fazer deploy da fase 1 | ${AWAIT}`].join('\n'),
      ids,
      'close'
    )
    expect(ops).toEqual([
      { kind: 'create', title: 'Commitar a fase 1', reason: AWAIT, status: 'pending', parentId: 'bi-pedido' },
      { kind: 'create', title: 'Fazer deploy da fase 1', reason: AWAIT, status: 'pending' }
    ])
  })

  it('na abertura e no FEITA o id é ignorado (não há pendência ali)', () => {
    expect(parsePoVerdict('NOVA bi-pedido | Corrigir o login | pedido', ids, 'open')).toEqual([
      { kind: 'create', title: 'Corrigir o login', reason: 'pedido', status: 'in_progress' }
    ])
    expect(parsePoVerdict('FEITA bi-pedido | Publicar o EXE | feito', ids, 'close')).toEqual([
      { kind: 'create', title: 'Publicar o EXE', reason: 'feito', status: 'completed' }
    ])
  })
})

describe('shapePendencies — o pai inferido e o título que diz QUAL tarefa', () => {
  const pedido = card()

  it('sem id, a única conclusão do veredito (explícita ou pelo padrão) é o pai', () => {
    const explicit = shapePendencies(parsePoVerdict(`CONCLUIR bi-pedido | entregue\nNOVA | Commitar a fase 1 do escritório | ${AWAIT}`, ['bi-pedido'], 'close'), [], [pedido])
    expect(explicit[1]).toMatchObject({ kind: 'create', parentId: 'bi-pedido', title: 'Commitar a fase 1 do escritório' })
    const byDefault = shapePendencies(parsePoVerdict(`NOVA | Verificar no app rodando | ${AWAIT}`, ['bi-pedido'], 'close'), [pedido], [pedido])
    expect(byDefault[0]).toMatchObject({ parentId: 'bi-pedido' })
  })

  it('com duas conclusões não dá para saber de qual: fica sem pai', () => {
    const other = card({ id: 'bi-outro', sourceTitle: 'Outra coisa' })
    const ops = shapePendencies(
      parsePoVerdict(`CONCLUIR bi-pedido | ok\nCONCLUIR bi-outro | ok\nNOVA | Commitar tudo de uma vez | ${AWAIT}`, ['bi-pedido', 'bi-outro'], 'close'),
      [],
      [pedido, other]
    )
    expect(ops[2]).not.toHaveProperty('parentId')
  })

  it('título curto ganha o título do pai; o que já diz a tarefa fica igual', () => {
    expect(pendencyTitle('Commitar', pedido)).toBe('Commitar — Implementar a fase 1 do escritório')
    expect(pendencyTitle('Fazer deploy', pedido)).toBe('Fazer deploy — Implementar a fase 1 do escritório')
    expect(pendencyTitle('Commitar a fase 1', pedido)).toBe('Commitar a fase 1')
    expect(pendencyTitle('Commitar', undefined)).toBe('Commitar')
  })

  it('a escrita leva o pai e o título completo para o cartão novo', async () => {
    const created: BoardPoCreate[] = []
    const deps: PoApplyDeps = {
      board: {
        list: vi.fn(async () => [pedido]),
        applyPo: vi.fn(async () => pedido),
        createPoItem: vi.fn(async (input: BoardPoCreate) => {
          created.push(input)
          return card({ id: 'bi-novo', sourceTitle: input.title })
        })
      },
      listConvTasks: async () => [],
      linkableLedgerTasks: async () => []
    }
    const target = { convId: 'c', cwd: 'C:/p', projectId: 'p', phase: 'close' as const, startedAt: 0, returned: [pedido] }
    await applyPoVerdict(deps, target, `NOVA bi-pedido | Commitar | ${AWAIT}`, [pedido], { applied: 0, touched: [] })
    expect(created).toEqual([
      expect.objectContaining({ title: 'Commitar — Implementar a fase 1 do escritório', status: 'pending', parentId: 'bi-pedido', reason: AWAIT })
    ])
  })
})

describe('pendência de ponta a ponta no SQLite real: entregue → pendência → "commita" → concluída', () => {
  const CWD = process.cwd()
  const CONV = 'conv-pendencia'
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('o pedido conclui, a pendência nasce ligada a ele, a abertura a põe em andamento e o fechamento a conclui', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-code-pendencia-'))
    dirs.push(dir)
    const repository = new SqliteRepository(dir, join(dir, 'agent-code.db'), 'device-a')
    await repository.initialize()
    const config = (): BoardConfig => ({ requirePlan: true, po: { enabled: true, model: 'claude-sonnet-5-5' } })
    const board = new BoardService({ repository: () => repository, poSettled: (id): Promise<void> => po.settled(id), poWaitMs: 2_000 })
    const cards = async (): Promise<BoardItem[]> => (await board.list(CWD, { conversationId: CONV })) ?? []
    const byTitle = async (start: string): Promise<BoardItem> => (await cards()).find((c) => (c.poTitle ?? c.sourceTitle).startsWith(start)) as BoardItem
    let clock = 1_000_000
    const po: Po = new Po({
      config,
      board,
      now: () => clock,
      gateActive: async () => false,
      listConvTasks: async () => [],
      scheduleFlush: () => () => undefined,
      ask: async (prompt) => {
        const close = prompt.includes('AÇÕES DESTE TURNO')
        if (!close) {
          if (prompt.includes('QUADRO ATUAL:\n(vazio)')) return 'NOVA | Implementar a fase 1 do escritório | pedido do usuário'
          const pendencia = await byTitle('Commitar')
          return prompt.includes('PEDIDO DO USUÁRIO:\ncommita') && pendencia ? `ANDAMENTO ${pendencia.id} | o usuário autorizou o commit` : 'OK'
        }
        const pedido = await byTitle('Implementar')
        // Turno 1 (tipo c): entregue + pendência. Turno 2: OK (o padrão conclui).
        return boardItemStatus(pedido) === 'in_progress' ? `CONCLUIR ${pedido.id} | código entregue, testes verdes\nNOVA | Commitar | ${AWAIT}` : 'OK'
      }
    })
    const emit = (event: ChatEvent): void => {
      board.observe(CONV, CWD, event)
      po.observe(CONV, event)
    }
    const idle = async (): Promise<void> => {
      await board.settled(CONV)
      await po.settled(CONV)
      await board.turnClosed(CONV)
      await po.settled(CONV)
    }
    const userSays = async (text: string): Promise<void> => {
      clock += 61_000
      po.noteUserMessage(CONV, CWD, text)
      await board.resumeTurn(CONV, CWD)
      await po.settled(CONV)
    }
    const result: ChatEvent = { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 }

    await userSays('implementa a fase 1 do escritório')
    emit({ kind: 'assistant-text', id: 'a', text: 'Fase 1 pronta, testes verdes. Falta commitar. Commito?', final: true })
    emit(result)
    await idle()

    const pedido = await byTitle('Implementar')
    const pendencia = await byTitle('Commitar')
    expect(boardItemStatus(pedido)).toBe('completed')
    expect(pendencia).toMatchObject({
      sourceTitle: 'Commitar — Implementar a fase 1 do escritório',
      parentId: pedido.id,
      poReason: AWAIT
    })
    expect(boardItemStatus(pendencia)).toBe('pending')

    await userSays('commita')
    expect(boardItemStatus(await byTitle('Commitar'))).toBe('in_progress')
    emit({ kind: 'assistant-text', id: 'a', text: 'Commit feito: abc123 "feat: fase 1 do escritório".', final: true })
    emit(result)
    await idle()

    const done = await byTitle('Commitar')
    expect(done).toMatchObject({ poStatus: 'completed', poReason: PO_DEFAULT_COMPLETE_REASON, parentId: pedido.id })
    expect(boardItemStatus(await byTitle('Implementar'))).toBe('completed')
    await repository.close()
  })
})
