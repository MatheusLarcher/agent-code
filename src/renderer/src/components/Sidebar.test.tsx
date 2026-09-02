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

describe('Sidebar — busca por projeto', () => {
  function makeSearchConv(id: string, title: string, updatedAt: number, text?: string): Conversation {
    return {
      ...makeConv(),
      id,
      title,
      updatedAt,
      messages: text ? [{ id: `${id}-msg`, kind: 'user', text }] : []
    }
  }

  function renderSearch(projects: Array<{ path: string; name: string; conversations: Conversation[] }>, onSelectResult = vi.fn()) {
    render(
      <UiProvider>
        <Sidebar
          collapsed={false}
          onToggleCollapse={() => {}}
          projects={projects}
          recents={[]}
          activeId={null}
          busyIds={new Set()}
          onSelect={() => {}}
          onNewChat={() => {}}
          onNewProject={() => {}}
          onNewChatIn={() => {}}
          onRename={() => {}}
          onDelete={() => {}}
          onSelectResult={onSelectResult}
        />
      </UiProvider>
    )
    return onSelectResult
  }

  it('filtra a árvore de projetos em vez de virar uma lista de resultados', () => {
    renderSearch([
      { path: 'C:/meu-app', name: 'meu-app', conversations: [makeSearchConv('a', 'Outra conversa', 1, 'nada')] },
      { path: 'C:/outro', name: 'outro', conversations: [makeSearchConv('b', 'Conversa recente', 999, 'sem relação')] }
    ])
    fireEvent.change(screen.getByPlaceholderText('Buscar conversas ou projetos…'), { target: { value: 'meu-app' } })
    // O projeto que casa continua sendo um nó da árvore, com suas conversas dentro.
    expect(screen.getByText('meu-app')).toBeTruthy()
    expect(screen.getByText('Outra conversa')).toBeTruthy()
    // O que não casa sai da árvore.
    expect(screen.queryByText('outro')).toBeNull()
    expect(screen.queryByText('Conversa recente')).toBeNull()
  })

  it('mantém o projeto na árvore quando só uma conversa dele casa', () => {
    renderSearch([
      {
        path: 'C:/outro',
        name: 'outro',
        conversations: [makeSearchConv('a', 'Orçamento', 2), makeSearchConv('b', 'Nada a ver', 1)]
      }
    ])
    fireEvent.change(screen.getByPlaceholderText('Buscar conversas ou projetos…'), { target: { value: 'orcamento' } })
    expect(screen.getByText('outro')).toBeTruthy()
    expect(screen.getByText('Orçamento')).toBeTruthy()
    expect(screen.queryByText('Nada a ver')).toBeNull()
  })

  it('busca projeto sem acento e passa null ao abrir resultado de projeto', () => {
    const onSelectResult = renderSearch([{ path: 'C:/relatorios', name: 'Relatórios', conversations: [makeSearchConv('c2', 'Resumo', 1)] }])
    fireEvent.change(screen.getByPlaceholderText('Buscar conversas ou projetos…'), { target: { value: 'relatorios' } })
    fireEvent.click(screen.getByText('Resumo'))
    expect(onSelectResult).toHaveBeenCalledWith('c2', null)
  })

  it('recolhe e expande todos os projetos num clique', () => {
    renderSearch([
      { path: 'C:/a', name: 'a', conversations: [makeSearchConv('c1', 'Conversa A', 1)] },
      { path: 'C:/b', name: 'b', conversations: [makeSearchConv('c2', 'Conversa B', 1)] }
    ])
    fireEvent.click(screen.getByTitle('Recolher todos os projetos'))
    expect(screen.queryByText('Conversa A')).toBeNull()
    expect(screen.queryByText('Conversa B')).toBeNull()
    fireEvent.click(screen.getByTitle('Expandir todos os projetos'))
    expect(screen.getByText('Conversa A')).toBeTruthy()
    expect(screen.getByText('Conversa B')).toBeTruthy()
  })

  it('mantém o id da mensagem ao abrir resultado de prompt', () => {
    const onSelectResult = renderSearch([{ path: 'C:/outro', name: 'outro', conversations: [makeSearchConv('c3', 'Resumo', 1, 'preciso procurar orçamento')] }])
    fireEvent.change(screen.getByPlaceholderText('Buscar conversas ou projetos…'), { target: { value: 'orçamento' } })
    fireEvent.click(screen.getByText('Resumo'))
    expect(onSelectResult).toHaveBeenCalledWith('c3', 'c3-msg')
  })
})
