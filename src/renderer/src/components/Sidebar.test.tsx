import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { UiProvider } from '../ui/UiProvider'
import { Sidebar } from './Sidebar'
import type { Conversation } from '../types'

afterEach(cleanup)

function makeConv(): Conversation {
  return {
    id: 'c1',
    title: 'Conversa antiga',
    cwd: 'C:/proj/meu-app',
    model: 'claude-opus-4-8',
    sdkSessionId: null,
    messages: [],
    tokens: { context: 0, output: 0, cost: 0 },
    createdAt: 1,
    updatedAt: 2
  }
}

function renderSidebar(onRename = vi.fn()): { onRename: ReturnType<typeof vi.fn> } {
  const conv = makeConv()
  // The same conversation shows up under its project AND under "Chats" — this is
  // exactly the duplicate-row condition that broke renaming.
  const projects = [{ path: conv.cwd, name: 'meu-app', conversations: [conv] }]
  const recents = [conv]
  render(
    <UiProvider>
      <Sidebar
        collapsed={false}
        onToggleCollapse={() => {}}
        projects={projects}
        recents={recents}
        activeId={conv.id}
        busyIds={new Set()}
        onSelect={() => {}}
        onNewChat={() => {}}
        onNewProject={() => {}}
        onNewChatIn={() => {}}
        onRename={onRename}
        onDelete={() => {}}
        onSelectResult={() => {}}
      />
    </UiProvider>
  )
  return { onRename }
}

describe('Sidebar — renomear conversa', () => {
  it('mostra a mesma conversa duas vezes (Projetos + Chats)', () => {
    renderSidebar()
    expect(screen.getAllByText('Conversa antiga')).toHaveLength(2)
  })

  it('duplo-clique abre exatamente UM campo de edição (não dois)', () => {
    renderSidebar()
    const titulos = screen.getAllByText('Conversa antiga')
    fireEvent.doubleClick(titulos[0])
    // Antes da correção, ambas as linhas entravam em edição → dois <input autoFocus>,
    // e o segundo roubava o foco do primeiro, disparando blur+commit e fechando a edição.
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
  })

  it('renomeia ao digitar e pressionar Enter', () => {
    const { onRename } = renderSidebar()
    fireEvent.doubleClick(screen.getAllByText('Conversa antiga')[0])
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Nome novo' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRename).toHaveBeenCalledWith('c1', 'Nome novo')
  })

  it('cancela com Esc sem renomear', () => {
    const { onRename } = renderSidebar()
    fireEvent.doubleClick(screen.getAllByText('Conversa antiga')[0])
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Não deve salvar' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onRename).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
