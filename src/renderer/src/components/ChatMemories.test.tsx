import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { UIMessage } from '../types'
import type { ContextTurnDetail } from '@shared/contextSnapshot'
import { ChatMemoryAttachment, useChatMemoryHistory } from './ChatMemories'

const messages: UIMessage[] = [{ kind: 'user', id: 'u1', text: 'Pedido' }, {
  kind: 'tool-use', id: 'r1', name: 'Read', input: { file_path: 'D:/mem/arquivo.md' },
  parentToolUseId: null, turnIds: ['old-turn'], result: { isError: false, text: 'SEGREDO não deve aparecer' }
} as UIMessage]
const stored: ContextTurnDetail = {
  convId: 'a', turnId: 'old-turn', pc: 'teste', startedAt: 1, model: 'claude-opus-5-5', models: [],
  provider: 'claude', request: 'Pedido', blockCount: 0, totalBytes: 0, memoriesSent: ['arquivo.md', 'outra.md'],
  complete: true, blocks: [], usage: null, secrets: []
}
let revealed: unknown[]
beforeEach(() => {
  revealed = []
  Object.assign(window, { api: {
    getCacheInfo: vi.fn(async () => ({ memoriesDir: 'D:/mem' })),
    listContextTurns: vi.fn(async () => []),
    readContextTurn: vi.fn(async () => ({ ...stored })),
    onContextTurnsChanged: vi.fn(() => () => undefined),
    revealFile: vi.fn(async (r: unknown) => { revealed.push(r); return { ok: true, message: 'Arquivo selecionado' } })
  } })
})
afterEach(cleanup)
function History({ convId = 'a' }: { convId?: string }): JSX.Element {
  const history = useChatMemoryHistory(convId, messages)
  return <ChatMemoryAttachment entries={history.byUser.get('u1') ?? []} error={history.error} onRetry={history.reload} />
}
describe('cartão de memórias no histórico', () => {
  it('reaproveita metadados antigos e invalida apenas o turno notificado', async () => {
    const listeners: Array<(e: { convId: string; turnId: string }) => void> = []
    window.api.onContextTurnsChanged = vi.fn((fn) => { listeners.push(fn); return () => undefined })
    const view = render(<History />)
    await screen.findByRole('button', { name: /2 memórias/ })
    expect(window.api.readContextTurn).toHaveBeenCalledTimes(1)
    view.rerender(<History />)
    listeners[0]({ convId: 'a', turnId: 'other' })
    await new Promise(r => setTimeout(r, 500))
    await waitFor(() => expect(window.api.listContextTurns).toHaveBeenCalledTimes(2))
    expect(window.api.readContextTurn).toHaveBeenCalledTimes(1)
    listeners[0]({ convId: 'a', turnId: 'old-turn' })
    await waitFor(() => expect(window.api.readContextTurn).toHaveBeenCalledTimes(2))
  })
  it('exibe memória enviada antes da primeira resposta e preserva após remount', async () => {
    function Pending(): JSX.Element {
      const history = useChatMemoryHistory('a', [{ kind: 'user', id: 'pending', text: 'Pedido', sdkUuid: 'old-turn' }])
      return <ChatMemoryAttachment entries={history.byUser.get('pending') ?? []} onRetry={history.reload} />
    }
    const first = render(<Pending />)
    await screen.findByRole('button', { name: /2 memórias/ })
    first.unmount()
    render(<Pending />)
    await screen.findByRole('button', { name: /2 memórias/ })
  })
  it('recupera turno fora dos dez recentes, diferencia proveniência e revela só pelo contrato seguro', async () => {
    render(<History />)
    fireEvent.click(await screen.findByRole('button', { name: /2 memórias/ }))
    expect(screen.getByText('Fornecida no contexto · Lida pelo agente')).toBeTruthy()
    expect(screen.getByText('Fornecida no contexto')).toBeTruthy()
    expect(screen.queryByText(/SEGREDO/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar arquivo.md na pasta' }))
    await screen.findByText('Arquivo selecionado')
    expect(revealed).toEqual([{ mode: 'folder', memory: 'arquivo.md' }])
  })
  it('mantém lista após remount e não vaza conversa anterior ao trocar', async () => {
    const view = render(<History />)
    await screen.findByRole('button', { name: /2 memórias/ })
    view.unmount()
    const next = render(<History />)
    await screen.findByRole('button', { name: /2 memórias/ })
    window.api.readContextTurn = vi.fn(async () => null)
    window.api.getCacheInfo = vi.fn(async () => ({ memoriesDir: null })) as never
    next.rerender(<History convId="b" />)
    await waitFor(() => expect(screen.queryByRole('button', { name: /2 memórias/ })).toBeNull())
  })
  it('mostra falha de reveal e permite recuperar leitura falha sem inventar lista', async () => {
    window.api.listContextTurns = vi.fn(async () => { throw new Error('offline') })
    render(<History />)
    fireEvent.click(await screen.findByRole('button', { name: 'Tentar novamente' }))
    window.api.listContextTurns = vi.fn(async () => [])
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    fireEvent.click(await screen.findByRole('button', { name: /2 memórias/ }))
    window.api.revealFile = vi.fn(async () => ({ ok: false, message: 'arquivo.md não existe mais', missing: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar arquivo.md na pasta' }))
    await screen.findByRole('alert')
    expect(screen.getByText('arquivo.md não existe mais')).toBeTruthy()
  })
})
