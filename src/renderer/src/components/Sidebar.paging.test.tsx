import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { UiProvider } from '../ui/UiProvider'
import { Sidebar, type SidebarProject } from './Sidebar'
import type { Conversation } from '../types'

afterEach(cleanup)

function convo(id: string, updatedAt: number): Conversation {
  return {
    id,
    title: `Conversa ${id}`,
    cwd: 'C:/proj/meu-app',
    model: 'claude-opus-5',
    sdkSessionId: null,
    messages: [],
    tokens: { context: 0, output: 0, cost: 0 },
    createdAt: 1,
    updatedAt
  }
}

function renderProjects(projects: SidebarProject[], onLoadMore = vi.fn()): ReturnType<typeof vi.fn> {
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
        onLoadMore={onLoadMore}
        onRename={() => {}}
        onDelete={() => {}}
        onSelectResult={() => {}}
      />
    </UiProvider>
  )
  return onLoadMore
}

describe('Sidebar — só a primeira página de cada projeto vem carregada', () => {
  it('o contador mostra o total REAL e o "Mostrar mais" pede o resto do projeto', () => {
    const loaded = [convo('c1', 6), convo('c2', 5), convo('c3', 4)]
    const onLoadMore = renderProjects([
      { path: loaded[0].cwd, name: 'meu-app', conversations: loaded, total: 11, hasMore: true }
    ])
    // Three rows on screen, but the badge says 11 — what the database holds.
    expect(screen.getAllByText(/^Conversa c/)).toHaveLength(3)
    expect(screen.getByTitle('Total de conversas do projeto').textContent).toBe('11')
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mais 8' }))
    expect(onLoadMore).toHaveBeenCalledWith(loaded[0].cwd)
  })

  it('projeto totalmente carregado não mostra o botão; enquanto carrega, fica desabilitado', () => {
    const loaded = [convo('c1', 2)]
    renderProjects([{ path: loaded[0].cwd, name: 'meu-app', conversations: loaded, total: 1, hasMore: false }])
    expect(screen.queryByRole('button', { name: /Mostrar mais/ })).toBeNull()
    cleanup()
    renderProjects([
      { path: loaded[0].cwd, name: 'meu-app', conversations: loaded, total: 4, hasMore: true, loadingMore: true }
    ])
    const busy = screen.getByRole('button', { name: 'Carregando…' }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
  })
})
