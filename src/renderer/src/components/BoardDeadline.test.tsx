import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { BOARD_PO_AWAITING_REASON, boardItemAwaitingBadge, type BoardItem } from '@shared/ipc'
import { entrega, envio } from '../handoffTracking/handoffFixtures'
import { boardProgress } from './BoardPanel'
import { cardDeadlines, DeadlineTag, useCardDeadlines } from './BoardDeadline'
import { RightPaneTabs } from './RightPaneTabs'

/**
 * O quadro como lugar único: o selo "Aguardando você" também na pendência do
 * PO que espera autorização, o número na aba, e o prazo da etapa no cartão
 * ("12 de 40 min", atrasada em vermelho) lido da entrega ligada a ele.
 */

afterEach(cleanup)

const card = (over: Partial<BoardItem> = {}): BoardItem =>
  ({
    id: 'c1',
    projectId: 'p',
    projectCwd: 'C:/p',
    conversationId: 'conv',
    origin: 'po',
    sourceId: null,
    sourceTitle: 'Commitar a fase 1',
    sourceStatus: 'pending',
    activeForm: null,
    seq: 0,
    poTitle: null,
    poNote: null,
    poStatus: null,
    poReason: BOARD_PO_AWAITING_REASON,
    poAt: null,
    dismissedAt: null,
    revision: 1,
    createdAt: '2026-10-06T10:00:00.000Z',
    updatedAt: '2026-10-06T10:00:00.000Z',
    ...over
  }) as BoardItem

describe('"Aguardando você" — o que precisa do usuário', () => {
  it('a pendência do PO que espera autorização ganha o selo; concluída ou dispensada, não', () => {
    expect(boardItemAwaitingBadge(card())).toEqual({ kind: 'result', label: 'Aguardando você' })
    expect(boardItemAwaitingBadge(card({ sourceStatus: 'completed' }))).toBeNull()
    expect(boardItemAwaitingBadge(card({ dismissedAt: '2026-10-06T11:00:00.000Z' }))).toBeNull()
    expect(boardItemAwaitingBadge(card({ poReason: 'autorizado: o commit sai sozinho, como rotina na fila' }))).toBeNull()
  })

  it('o número na aba do quadro: quantos cartões esperam você', () => {
    const items = [card(), card({ id: 'c2', sourceStatus: 'completed' }), card({ id: 'c3', poReason: null })]
    expect(boardProgress(items)).toEqual({ done: 1, total: 3, awaiting: 1 })
    render(<RightPaneTabs active="board" onSelect={() => {}} onCollapse={() => {}} liveAgents={0} browserTabs={0} boardProgress={{ done: 1, total: 3, awaiting: 1 }} />)
    expect(screen.getByTitle('1 cartão espera você').textContent).toBe('1')
  })
})

describe('o prazo da etapa no cartão', () => {
  const envios = [
    envio({
      entregas: [
        entrega({ id: 'n1', boardItemId: 'c1', estimativaPlano: 40, tempoAtivoMs: 11 * 60_000 + 1, atrasada: false }),
        entrega({ id: 'n2', boardItemId: 'c2', estimativaPlano: 30, tempoAtivoMs: 45 * 60_000, atrasada: true }),
        entrega({ id: 'n3', boardItemId: null })
      ]
    })
  ]

  it('lê da entrega ligada ao cartão: "12 de 40 min" e a marca de atrasada', () => {
    const map = cardDeadlines(envios)
    expect(map.get('c1')).toEqual({ minutos: 12, prazo: 40, atrasada: false })
    expect(map.size).toBe(2)
    render(<DeadlineTag deadline={map.get('c1')!} />)
    expect(screen.getByText('12 de 40 min').className).toBe('board-tag deadline')
    cleanup()
    render(<DeadlineTag deadline={map.get('c2')!} />)
    expect(screen.getByText('45 de 30 min · atrasada').className).toBe('board-tag deadline late')
  })

  it('useCardDeadlines relê quando o acompanhamento grava', async () => {
    let changed: (() => void) | null = null
    const api = {
      handoffList: vi.fn(async () => ({ ok: true as const, envios })),
      onHandoffChanged: vi.fn((cb: () => void) => {
        changed = cb
        return () => undefined
      })
    }
    const { result } = renderHook(() => useCardDeadlines('C:/p', api))
    await waitFor(() => expect(result.current.get('c1')?.prazo).toBe(40))
    expect(api.handoffList).toHaveBeenCalledWith({ projectCwd: 'C:/p' })
    changed!()
    await waitFor(() => expect(api.handoffList).toHaveBeenCalledTimes(2))
  })
})
