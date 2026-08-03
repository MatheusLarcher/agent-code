import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { UiProvider } from '../../../src/renderer/src/ui/UiProvider'
import { Sidebar } from '../../../src/renderer/src/components/Sidebar'
import type { Conversation } from '../../../src/renderer/src/types'

/** Testes de aceitação do benchmark — NÃO são vistos por quem implementa. */

afterEach(cleanup)

function conv(id: string, title: string, archived?: boolean): Conversation {
  return {
    id,
    title,
    cwd: 'C:/proj/meu-app',
    model: 'claude-opus-4-8',
    sdkSessionId: null,
    messages: [{ kind: 'user', id: `${id}-m1`, text: `prompt de ${title}` }],
    tokens: { context: 0, output: 0, cost: 0 },
    createdAt: 1,
    updatedAt: 2,
    ...(archived === undefined ? {} : { archived })
  } as Conversation
}

function renderSidebar(list: Conversation[], onArchive = vi.fn()): { onArchive: ReturnType<typeof vi.fn> } {
  render(
    <UiProvider>
      <Sidebar
        collapsed={false}
        onToggleCollapse={() => {}}
        projects={[{ path: 'C:/proj/meu-app', name: 'meu-app', conversations: list }]}
        recents={list}
        activeId={list[0]?.id ?? null}
        busyIds={new Set()}
        onSelect={() => {}}
        onNewChat={() => {}}
        onNewProject={() => {}}
        onNewChatIn={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        onSelectResult={() => {}}
        onArchive={onArchive}
      />
    </UiProvider>
  )
  return { onArchive }
}

describe('Sidebar — arquivar', () => {
  it('conversa arquivada não aparece na lista normal', () => {
    renderSidebar([conv('a', 'Visível'), conv('b', 'Escondida', true)])
    expect(screen.getAllByText('Visível').length).toBeGreaterThan(0)
    expect(screen.queryByText('Escondida')).toBeNull()
  })

  it('o botão Arquivar chama onArchive(id, true)', () => {
    const { onArchive } = renderSidebar([conv('a', 'Visível')])
    fireEvent.click(screen.getAllByTitle('Arquivar')[0])
    expect(onArchive).toHaveBeenCalledWith('a', true)
  })

  it('a seção Arquivadas conta e revela as arquivadas ao expandir', () => {
    renderSidebar([conv('a', 'Visível'), conv('b', 'Escondida', true)])
    const secao = screen.getByText(/Arquivadas \(1\)/)
    fireEvent.click(secao)
    expect(screen.getAllByText('Escondida').length).toBeGreaterThan(0)
  })

  it('sem arquivadas, a seção não aparece', () => {
    renderSidebar([conv('a', 'Visível')])
    expect(screen.queryByText(/Arquivadas/)).toBeNull()
  })

  it('desarquivar chama onArchive(id, false)', () => {
    const { onArchive } = renderSidebar([conv('a', 'Visível'), conv('b', 'Escondida', true)])
    fireEvent.click(screen.getByText(/Arquivadas \(1\)/))
    fireEvent.click(screen.getAllByTitle('Desarquivar')[0])
    expect(onArchive).toHaveBeenCalledWith('b', false)
  })

  it('a busca ignora conversa arquivada', () => {
    renderSidebar([conv('a', 'Visível'), conv('b', 'Escondida', true)])
    const busca = screen.getByPlaceholderText(/buscar/i)
    fireEvent.change(busca, { target: { value: 'prompt de' } })
    expect(screen.queryByText('Escondida')).toBeNull()
    expect(screen.getAllByText('Visível').length).toBeGreaterThan(0)
  })
})
