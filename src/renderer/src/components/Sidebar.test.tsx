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

describe('Sidebar — dock recolhido', () => {
  function renderCollapsed() {
    const projects = ['A', 'B', 'C'].map((name) => ({
      path: `C:/${name}`,
      name,
      conversations: [{ ...makeConv(), id: name }]
    }))
    render(
      <UiProvider>
        <Sidebar
          collapsed
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
          onSelectResult={() => {}}
        />
      </UiProvider>
    )
  }

  it('cresce o marcador sob o mouse e proporcionalmente os vizinhos', () => {
    renderCollapsed()
    const markers = ['A', 'B', 'C'].map((name) => screen.getByTitle(name))
    fireEvent.mouseEnter(markers[1])
    expect(markers[0].getAttribute('style')).toContain('--rail-distance: 1')
    expect(markers[1].getAttribute('style')).toContain('--rail-distance: 0')
    expect(markers[2].getAttribute('style')).toContain('--rail-distance: 1')
  })

  it('limpa o efeito ao sair da lista de marcadores', () => {
    renderCollapsed()
    const markers = ['A', 'B', 'C'].map((name) => screen.getByTitle(name))
    fireEvent.mouseEnter(markers[1])
    fireEvent.mouseLeave(markers[1].parentElement!)
    expect(markers[0].getAttribute('style')).toBe('')
    expect(markers[1].getAttribute('style')).toBe('')
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

  it('mostra o ícone do projeto quando a pasta tem um, e só nele', () => {
    const { container } = render(
      <UiProvider>
        <Sidebar
          collapsed={false}
          onToggleCollapse={() => {}}
          projects={[
            { path: 'C:/com-icone', name: 'com-icone', icon: 'data:image/png;base64,AAA', conversations: [] },
            { path: 'C:/sem-icone', name: 'sem-icone', conversations: [] }
          ]}
          recents={[]}
          activeId={null}
          busyIds={new Set()}
          onSelect={() => {}}
          onNewChat={() => {}}
          onNewProject={() => {}}
          onNewChatIn={() => {}}
          onRename={() => {}}
          onDelete={() => {}}
          onSelectResult={() => {}}
        />
      </UiProvider>
    )
    const imgs = container.querySelectorAll('img.project-icon-img')
    expect(imgs).toHaveLength(1)
    expect(imgs[0].getAttribute('src')).toBe('data:image/png;base64,AAA')
    // O projeto sem ícone continua com o glifo de pasta (nenhuma imagem quebrada).
    expect(screen.getByText('sem-icone')).toBeTruthy()
  })

  it('volta ao glifo de pasta se a imagem não decodificar', () => {
    const { container } = render(
      <UiProvider>
        <Sidebar
          collapsed={false}
          onToggleCollapse={() => {}}
          projects={[{ path: 'C:/quebrado', name: 'quebrado', icon: 'data:image/png;base64,zzz', conversations: [] }]}
          recents={[]}
          activeId={null}
          busyIds={new Set()}
          onSelect={() => {}}
          onNewChat={() => {}}
          onNewProject={() => {}}
          onNewChatIn={() => {}}
          onRename={() => {}}
          onDelete={() => {}}
          onSelectResult={() => {}}
        />
      </UiProvider>
    )
    fireEvent.error(container.querySelector('img.project-icon-img')!)
    expect(container.querySelector('img.project-icon-img')).toBeNull()
    expect(screen.getByText('quebrado')).toBeTruthy()
  })

  it('conversa de planejamento tem o glifo "Planejamento"; a normal continua com o de chat', () => {
    const planning: Conversation = {
      ...makeConv(),
      id: 'p1',
      title: 'Planejamento: Checkout',
      mode: 'planning',
      planningSlug: 'checkout'
    }
    const { container } = render(
      <UiProvider>
        <Sidebar
          collapsed={false}
          onToggleCollapse={() => {}}
          projects={[{ path: 'C:/proj', name: 'proj', conversations: [planning, makeConv()] }]}
          recents={[]}
          activeId={null}
          busyIds={new Set()}
          onSelect={() => {}}
          onNewChat={() => {}}
          onNewProject={() => {}}
          onNewChatIn={() => {}}
          onRename={() => {}}
          onDelete={() => {}}
          onSelectResult={() => {}}
        />
      </UiProvider>
    )
    const rows = container.querySelectorAll('.conv-row')
    expect(rows).toHaveLength(2)
    // Classe própria: `.planning` é a raiz da Tela de Planejamento no planning.css.
    expect(rows[0].classList.contains('planning-conv')).toBe(true)
    expect(rows[0].classList.contains('planning')).toBe(false)
    expect(rows[0].querySelector('.conv-ico')?.getAttribute('title')).toBe('Planejamento')
    expect(rows[1].classList.contains('planning-conv')).toBe(false)
    expect(rows[1].querySelector('.conv-ico')?.getAttribute('title')).toBeNull()
  })

  it('"Novo planejamento" fica ao lado do "+" do projeto e avisa qual pasta', () => {
    const onNewPlanningIn = vi.fn()
    const onNewChatIn = vi.fn()
    render(
      <UiProvider>
        <Sidebar
          collapsed={false}
          onToggleCollapse={() => {}}
          projects={[{ path: 'C:/proj', name: 'proj', conversations: [makeConv()] }]}
          recents={[]}
          activeId={null}
          busyIds={new Set()}
          onSelect={() => {}}
          onNewChat={() => {}}
          onNewProject={() => {}}
          onNewChatIn={onNewChatIn}
          onNewPlanningIn={onNewPlanningIn}
          onRename={() => {}}
          onDelete={() => {}}
          onSelectResult={() => {}}
        />
      </UiProvider>
    )
    const button = screen.getByRole('button', { name: 'Novo planejamento' })
    expect(button.previousElementSibling?.getAttribute('title')).toBe('Nova conversa neste projeto')
    fireEvent.click(button)
    expect(onNewPlanningIn).toHaveBeenCalledWith('C:/proj')
    expect(onNewChatIn).not.toHaveBeenCalled()
  })

  it('sem onNewPlanningIn, o botão de planejamento não aparece', () => {
    renderSearch([{ path: 'C:/proj', name: 'proj', conversations: [makeSearchConv('c9', 'Qualquer', 1)] }])
    expect(screen.queryByRole('button', { name: 'Novo planejamento' })).toBeNull()
  })

  it('mantém o id da mensagem ao abrir resultado de prompt', () => {
    const onSelectResult = renderSearch([{ path: 'C:/outro', name: 'outro', conversations: [makeSearchConv('c3', 'Resumo', 1, 'preciso procurar orçamento')] }])
    fireEvent.change(screen.getByPlaceholderText('Buscar conversas ou projetos…'), { target: { value: 'orçamento' } })
    fireEvent.click(screen.getByText('Resumo'))
    expect(onSelectResult).toHaveBeenCalledWith('c3', 'c3-msg')
  })
})
