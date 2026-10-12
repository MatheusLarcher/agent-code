/**
 * Aba Quadro: o projeto da conversa mais recente por padrão, a lista da coluna,
 * "Mover para…" pelo board:move (o cartão troca de coluna), arquivar, PC sem o
 * quadro (available:false), erro com "Tentar de novo", releitura no board:changed
 * e o "Scrum Master" em tela cheia que fecha no voltar do Android.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Channels, type BoardItem, type ProjectBoard } from '@shared/ipc'
import { client, nav } from '../app/runtime'
import { resetApp } from '../app/testSupport'
import type { ConvSummary } from '../core/types'
import { installBridgeApi } from '../office/bridgeApi'
import { handleBack } from '../shell/backButton'
import { BOARD_MAX_AGE_MS, BoardTab, boardUi, recentBoardItems } from './BoardTab'

const ALFA = 'C:\\proj\\alfa'
const BETA = 'C:\\proj\\beta'

const item = (o: Partial<BoardItem> & Pick<BoardItem, 'id' | 'sourceTitle'>): BoardItem => ({
  projectId: 'p-alfa', projectCwd: ALFA, conversationId: 'c-alfa', origin: 'todo', sourceStatus: 'pending',
  poTitle: null, poNote: null, poStatus: null, poReason: null, dismissedAt: null, revision: 1,
  // Datas de agora: o quadro do celular só mostra os últimos 14 dias.
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...o
} as BoardItem)

const conv = (id: string, cwd: string, updatedAt: number): ConvSummary =>
  ({ id, title: `Conversa ${id}`, cwd, busy: false, connected: true, updatedAt, queued: [] }) as unknown as ConvSummary

type Ipc = (channel: string, args: unknown[]) => unknown
let ipc: Ipc
let calls: Array<{ channel: string; args: unknown[] }>

const flush = (): Promise<void> => act(async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
})

describe('recentBoardItems', () => {
  it('só os últimos 14 dias, do mais novo ao mais antigo', () => {
    const now = Date.parse('2026-10-20T12:00:00.000Z')
    const at = (ms: number): string => new Date(now - ms).toISOString()
    const day = 24 * 60 * 60 * 1000
    const list = [
      item({ id: 'velho', sourceTitle: 'v', updatedAt: at(BOARD_MAX_AGE_MS + 1) }),
      item({ id: 'meio', sourceTitle: 'm', updatedAt: at(5 * day) }),
      item({ id: 'novo', sourceTitle: 'n', updatedAt: at(1000) }),
      item({ id: 'limite', sourceTitle: 'l', updatedAt: at(BOARD_MAX_AGE_MS) })
    ]
    expect(recentBoardItems(list, now).map((it) => it.id)).toEqual(['novo', 'meio', 'limite'])
  })
})

describe('Aba Quadro', () => {
  let board: ProjectBoard
  beforeEach(() => {
    resetApp()
    boardUi.set({ cwd: null, column: 'pending', dismissed: false })
    nav.set({ tab: 'quadro', chatOpen: false })
    client.store.set({
      base: 'http://pc', token: 'tk', loaded: true, projects: [BETA, ALFA],
      conversations: [conv('c-beta', BETA, 1), conv('c-alfa', ALFA, 9)], convId: null, messages: []
    })
    board = {
      available: true,
      items: [item({ id: 'b1', sourceTitle: 'Corrigir login' }), item({ id: 'b2', sourceTitle: 'Subir build', sourceStatus: 'in_progress' })]
    }
    calls = []
    ipc = (channel, args) => {
      if (channel === Channels.boardList) return board
      if (channel === Channels.boardMove) {
        const [id, to] = args as [string, BoardItem['poStatus']]
        board = { ...board, items: board.items.map((it) => (it.id === id ? { ...it, poStatus: to } : it)) }
        return { ok: true, message: 'Movido.' }
      }
      if (channel === Channels.boardDismiss) return { ok: true }
      if (channel === Channels.boardItemEvents) return []
      if (channel === Channels.boardPrints) return { ok: true, prints: [] }
      return null
    }
    vi.spyOn(client, 'request').mockImplementation((async (path: string, opts?: { body?: { channel: string; args: unknown[] } }) => {
      if (path !== '/api/ipc' || !opts?.body) throw new Error('rota inesperada ' + path)
      calls.push(opts.body)
      const result = ipc(opts.body.channel, opts.body.args)
      if (result instanceof Error) return { ok: false, error: result.message }
      return { ok: true, result }
    }) as never)
    delete (window as unknown as { api?: unknown }).api
    installBridgeApi(client)
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    client.eventTaps.clear()
    delete (window as unknown as { api?: unknown }).api
  })

  it('lê o quadro do projeto da conversa mais recente e lista a coluna "A fazer"', async () => {
    render(<BoardTab />)
    await flush()
    expect(calls[0]).toEqual({ channel: Channels.boardList, args: [{ projectCwd: ALFA, includeDismissed: false }] })
    expect((screen.getByLabelText('Projeto') as HTMLSelectElement).value).toBe(ALFA)
    expect(screen.getByText('Corrigir login')).toBeTruthy()
    expect(screen.queryByText('Subir build')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /Fazendo/ }))
    expect(screen.getByText('Subir build')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /Concluído/ }))
    expect(screen.getByText(/Nenhum cartão em/)).toBeTruthy()
  })

  it('trocar o projeto relê o quadro do outro', async () => {
    render(<BoardTab />)
    await flush()
    fireEvent.change(screen.getByLabelText('Projeto'), { target: { value: BETA } })
    await flush()
    expect(calls.at(-1)).toEqual({ channel: Channels.boardList, args: [{ projectCwd: BETA, includeDismissed: false }] })
  })

  it('"Mover para…" chama board:move e o cartão muda de coluna', async () => {
    render(<BoardTab />)
    await flush()
    fireEvent.click(screen.getByText('Corrigir login'))
    await flush()
    const sheet = screen.getByRole('dialog', { name: 'Cartão do quadro' })
    expect(sheet.textContent).toContain('Mover para…')
    fireEvent.click(screen.getByRole('button', { name: 'Fazendo' }))
    await flush()
    expect(calls).toContainEqual({ channel: Channels.boardMove, args: ['b1', 'in_progress'] })
    // Na coluna "A fazer" não está mais; em "Fazendo", sim.
    fireEvent.click(screen.getByTitle('Fechar'))
    expect(screen.queryByText('Corrigir login')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /Fazendo/ }))
    expect(screen.getByText('Corrigir login')).toBeTruthy()
  })

  it('PC recusa o mover: o cartão volta para a coluna de antes', async () => {
    const base = ipc
    ipc = (channel, args) => (channel === Channels.boardMove ? { ok: false, message: 'Cartão mudou no PC.' } : base(channel, args))
    render(<BoardTab />)
    await flush()
    fireEvent.click(screen.getByText('Corrigir login'))
    fireEvent.click(screen.getByRole('button', { name: 'Concluído' }))
    await flush()
    fireEvent.click(screen.getByTitle('Fechar'))
    expect(screen.getByText('Corrigir login')).toBeTruthy()
  })

  it('arquivar chama board:dismiss', async () => {
    render(<BoardTab />)
    await flush()
    fireEvent.click(screen.getByText('Corrigir login'))
    await flush()
    fireEvent.click(screen.getByRole('button', { name: /Dispensar cartão/ }))
    await flush()
    expect(calls).toContainEqual({ channel: Channels.boardDismiss, args: ['b1', true] })
  })

  it('available:false mostra o quadro indisponível', async () => {
    board = { available: false, items: [] }
    render(<BoardTab />)
    await flush()
    expect(screen.getByText('Quadro indisponível')).toBeTruthy()
    expect(screen.queryByRole('tab', { name: /A fazer/ })).toBeNull()
  })

  it('erro na leitura: mensagem e "Tentar de novo" relê', async () => {
    let fail = true
    const base = ipc
    ipc = (channel, args) => (channel === Channels.boardList && fail ? new Error('banco fora do ar') : base(channel, args))
    render(<BoardTab />)
    await flush()
    expect(screen.getByRole('alert').textContent).toContain('banco fora do ar')
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    await flush()
    expect(screen.getByText('Corrigir login')).toBeTruthy()
  })

  it('board:changed pela ponte relê o quadro', async () => {
    render(<BoardTab />)
    await flush()
    board = { ...board, items: [...board.items, item({ id: 'b3', sourceTitle: 'Novo cartão' })] }
    act(() => {
      for (const tap of client.eventTaps) tap({ convId: 'office', event: { kind: 'app-ipc', channel: Channels.boardChanged, payload: {} } } as never)
    })
    await flush()
    expect(screen.getByText('Novo cartão')).toBeTruthy()
  })

  it('"Scrum Master" abre o diário em tela cheia; o voltar fecha', async () => {
    render(<BoardTab />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: /Scrum Master/ }))
    await flush()
    expect(screen.getByRole('dialog', { name: 'Diário do Scrum Master' })).toBeTruthy()
    act(() => {
      handleBack()
    })
    expect(screen.queryByRole('dialog', { name: 'Diário do Scrum Master' })).toBeNull()
  })
})
