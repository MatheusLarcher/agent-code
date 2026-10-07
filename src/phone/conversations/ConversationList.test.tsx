/**
 * Aba Conversas: cada projeto começa recolhido (cabeçalho com nome, nº e sinais),
 * tocar abre/fecha, o "+" não abre/fecha, o aberto continua aberto ao voltar (só em
 * memória), a busca mostra resultados soltos e a Central fica no topo, fora dos grupos.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { client } from '../app/runtime'
import { resetApp } from '../app/testSupport'
import { CENTRAL_CONV_ID } from '../core/client'
import type { ConvSummary } from '../core/types'
import { ConversationList, openProjects } from './ConversationList'

const conv = (id: string, cwd: string, extra: Partial<ConvSummary> = {}): ConvSummary =>
  ({ id, title: `Conversa ${id}`, cwd, updatedAt: 1, ...extra }) as ConvSummary

const CONVS: ConvSummary[] = [
  conv(CENTRAL_CONV_ID, '', { title: 'Central' }),
  conv('a1', 'C:/proj/alfa', { busy: true }),
  conv('a2', 'C:/proj/alfa', { permission: { id: 'p1', toolName: 'Bash', input: {} } as unknown as ConvSummary['permission'] }),
  conv('b1', 'C:/proj/beta')
]

const header = (name: string): HTMLButtonElement =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.coll-toggle')).find((b) => b.textContent?.includes(name))!

describe('ConversationList — projetos recolhidos', () => {
  beforeEach(() => {
    resetApp()
    openProjects.set({ open: {} })
    client.store.set({ conversations: CONVS, projects: [], loaded: true, convId: '' })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('começa tudo recolhido, com nome, nº de conversas e os sinais de trabalhando e "?"', () => {
    render(<ConversationList />)
    expect(document.querySelectorAll('.hist-row:not(.central-row)')).toHaveLength(0)
    const alfa = header('alfa')
    expect(alfa.getAttribute('aria-expanded')).toBe('false')
    expect(alfa.querySelector('.coll-count')?.textContent).toBe('2')
    expect(alfa.querySelector('.coll-busy')).toBeTruthy()
    expect(alfa.querySelector('.coll-ask')?.textContent).toBe('?')
    const beta = header('beta')
    expect(beta.querySelector('.coll-count')?.textContent).toBe('1')
    expect(beta.querySelector('.coll-busy')).toBeNull()
    expect(beta.querySelector('.coll-ask')).toBeNull()
  })

  it('tocar no cabeçalho abre e fecha só aquele projeto', () => {
    render(<ConversationList />)
    fireEvent.click(header('alfa'))
    expect(header('alfa').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Conversa a1')).toBeTruthy()
    expect(screen.getByText('Conversa a2')).toBeTruthy()
    expect(screen.queryByText('Conversa b1')).toBeNull()
    fireEvent.click(header('alfa'))
    expect(screen.queryByText('Conversa a1')).toBeNull()
  })

  it('o "+" cria a conversa sem abrir/fechar o grupo', () => {
    const action = vi.spyOn(client, 'conversationAction').mockResolvedValue('' as never)
    render(<ConversationList />)
    const plus = screen.getAllByLabelText('Nova conversa neste projeto')[0]
    fireEvent.click(plus)
    expect(action).toHaveBeenCalledWith({ type: 'create', cwd: 'C:/proj/alfa' })
    expect(header('alfa').getAttribute('aria-expanded')).toBe('false')
  })

  it('o que foi aberto continua aberto ao voltar para a lista', () => {
    const first = render(<ConversationList />)
    fireEvent.click(header('beta'))
    first.unmount()
    render(<ConversationList />)
    expect(header('beta').getAttribute('aria-expanded')).toBe('true')
    expect(header('alfa').getAttribute('aria-expanded')).toBe('false')
  })

  it('a Central fica no topo, fora dos grupos', () => {
    render(<ConversationList />)
    const list = document.querySelector('.history-list')!
    expect(list.firstElementChild?.classList.contains('central-row')).toBe(true)
    expect(document.querySelector('.coll-group .central-row')).toBeNull()
  })

  it('a busca mostra os resultados soltos, sem grupos', async () => {
    vi.useFakeTimers()
    vi.spyOn(client, 'search').mockResolvedValue([
      { id: 'b1', title: 'Conversa b1', cwd: 'C:/proj/beta', snippet: 'trecho', messageId: null, updatedAt: 1 }
    ])
    render(<ConversationList />)
    fireEvent.change(screen.getByLabelText('Buscar nos meus prompts'), { target: { value: 'trecho' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(document.querySelector('.coll-group')).toBeNull()
    expect(document.querySelector('.hist-result')?.textContent).toContain('Conversa b1')
  })
})
