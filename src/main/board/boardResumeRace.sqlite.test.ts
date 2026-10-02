// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatEvent } from '../../shared/ipc'
import { SqliteRepository } from '../persistence/sqliteRepository'
import type { BoardItem, BoardQuery } from '../persistence/types'
import { BoardService } from './boardService'

/**
 * A corrida da conversa "Modelos OpenAI, tradução redimensionável" (01/10):
 * o PO passou do teto de 30 s, o fim de turno rebaixou o cartão, e o CONCLUIR
 * atrasado foi gravado ENTRE a leitura e a escrita da promoção da mensagem
 * seguinte — que gravou "em andamento" por cima do "concluído".
 */

const CWD = process.cwd()
const CONV = 'conv-race'
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const result: ChatEvent = { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 }

async function world() {
  const cache = await mkdtemp(join(tmpdir(), 'agent-code-race-'))
  tempDirs.push(cache)
  const repository = new SqliteRepository(cache, join(cache, 'agent-code.db'), 'device-a')
  await repository.initialize()
  // Logo depois da PRÓXIMA leitura da conversa, roda `between` — o escritor
  // concorrente que grava antes de quem leu escrever. A leitura do projeto
  // inteiro (faxina de concluídos, em `list`) vem antes e não conta.
  let between: ((items: BoardItem[]) => Promise<void>) | null = null
  const list = repository.listBoardItems.bind(repository)
  repository.listBoardItems = async (query: BoardQuery): Promise<BoardItem[]> => {
    const items = await list(query)
    if (query.conversationId === undefined) return items
    const hook = between
    between = null
    if (hook) await hook(items)
    return items
  }
  const board = new BoardService({ repository: () => repository })
  const created = await repository.createBoardPoItem({
    projectId: await board.projectId(CWD),
    projectCwd: CWD,
    conversationId: CONV,
    title: 'Adicionar TTS com Kokoro',
    status: 'in_progress',
    reason: 'pedido novo de trabalho'
  })
  return { repository, board, card: created, armBetween: (hook: typeof between) => (between = hook) }
}

describe('retomada × CONCLUIR atrasado do PO', () => {
  it('a promoção não reabre o cartão que o PO concluiu entre a leitura e a escrita', async () => {
    const w = await world()
    w.board.observe(CONV, CWD, result)
    await w.board.turnClosed(CONV)
    expect((await w.repository.getBoardItem(w.card.id))?.poStatus).toBe('pending')

    w.armBetween(async () => {
      await w.repository.applyBoardPo({ id: w.card.id, poStatus: 'completed', poReason: 'Kokoro implementado e testado' })
    })
    await w.board.resumeTurn(CONV, CWD)

    expect(await w.repository.getBoardItem(w.card.id)).toMatchObject({
      poStatus: 'completed',
      poReason: 'Kokoro implementado e testado'
    })
  })

  it('sem escritor concorrente, a promoção continua acontecendo', async () => {
    const w = await world()
    w.board.observe(CONV, CWD, result)
    await w.board.turnClosed(CONV)
    await w.board.resumeTurn(CONV, CWD)
    expect((await w.repository.getBoardItem(w.card.id))?.poStatus).toBe('in_progress')
  })
})
