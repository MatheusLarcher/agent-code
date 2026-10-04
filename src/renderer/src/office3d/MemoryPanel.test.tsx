import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MemoryListItem } from '@shared/memoryPanel'
import { MemoryPanel } from './MemoryPanel'
import type { UsageEvent } from './memoryUsage'
import type { MemoryPanelData } from './useMemoryPanel'

const NOW = new Date(2026, 9, 4, 15, 0).getTime()
const item = (relPath: string, extra: Partial<MemoryListItem> = {}): MemoryListItem => ({ relPath, title: `Título ${relPath}`, hook: `gancho ${relPath}`, folder: relPath.includes('/') ? relPath.split('/')[0] : '', scope: 'user', projectCwd: null, revision: 3, status: 'active', updatedAt: new Date(NOW - 86_400_000).toISOString(), ...extra })
const ev = (relPath: string | null, how: UsageEvent['how'], minutesAgo: number, convId = 'a'): UsageEvent => ({ relPath, convId, agent: convId === 'a' ? 'Loja' : 'Portal', project: 'C:\\loja', how, at: NOW - minutesAgo * 60_000 })

function data(extra: Partial<MemoryPanelData> = {}): MemoryPanelData {
  return {
    items: [item('2D/vps.md'), item('raiz.md'), item('nunca.md')],
    events: [ev('2D/vps.md', 'escolhida', 3), ev('raiz.md', 'gravada', 10, 'b')],
    conflicts: new Set(['nunca.md']),
    bodies: new Map(),
    read: vi.fn(async () => 'acesso: {{secret:vps_2d}}'),
    loading: false,
    ...extra
  }
}

describe('o painel de Memórias (só leitura)', () => {
  it('em cima o uso (quem está na estante fixado, o agente leva a câmera), embaixo todas agrupadas pela pasta', () => {
    const fly = vi.fn()
    render(<MemoryPanel data={data()} atShelf={[{ convId: 'c', name: 'Testes' }]} onClose={vi.fn()} onFlyToAgent={fly} onOpenConversation={vi.fn()} now={NOW} />)
    const uses = screen.getByTestId('mp-uses')
    expect(within(uses).getByTestId('mp-at-shelf').textContent).toContain('Testes')
    expect(within(uses).getAllByTestId('mp-use').map((l) => l.textContent)).toEqual([
      expect.stringContaining('Título 2D/vps.md · escolhida pelo app'),
      expect.stringContaining('Título raiz.md · gravada')
    ])
    fireEvent.click(within(uses).getByRole('button', { name: /Portal/ }))
    expect(fly).toHaveBeenCalledWith('b')
    expect(screen.getAllByTestId('mp-mem').map((b) => b.textContent?.split('gancho')[0])).toEqual(['Título raiz.md', 'Título nunca.md', 'Título 2D/vps.md'])
    expect([...document.querySelectorAll('.mp-folder-name')].map((e) => e.textContent)).toEqual(['raiz', '2D/'])
    // Nenhum botão de gravar/editar/aposentar.
    expect(screen.queryByRole('button', { name: /editar|salvar|aposentar|excluir/i })).toBeNull()
  })

  it('filtros e chips valem para as duas partes: período, como foi usada, Em conflito, busca', () => {
    render(<MemoryPanel data={data()} atShelf={[]} onClose={vi.fn()} onFlyToAgent={vi.fn()} onOpenConversation={vi.fn()} now={NOW} />)
    fireEvent.click(screen.getByRole('button', { name: 'gravada' }))
    expect(screen.getAllByTestId('mp-use')).toHaveLength(1)
    expect(screen.getAllByTestId('mp-mem').map((b) => b.textContent)).toEqual([expect.stringContaining('Título raiz.md')])
    fireEvent.click(screen.getByRole('button', { name: 'gravada' }))
    fireEvent.click(screen.getByRole('button', { name: /Em conflito/ }))
    expect(screen.getAllByTestId('mp-mem').map((b) => b.textContent)).toEqual([expect.stringContaining('Título nunca.md')])
    fireEvent.click(screen.getByRole('button', { name: /Em conflito/ }))
    fireEvent.change(screen.getByLabelText('Buscar nas memórias'), { target: { value: 'vps' } })
    expect(screen.getAllByTestId('mp-mem')).toHaveLength(1)
  })

  it('abrir uma memória: o texto (o segredo só como marca) e onde foi usada, com o link para a conversa; ✕ fecha', () => {
    const d = data()
    const open = vi.fn()
    const close = vi.fn()
    const v = render(<MemoryPanel data={d} atShelf={[]} onClose={close} onFlyToAgent={vi.fn()} onOpenConversation={open} now={NOW} />)
    fireEvent.click(screen.getAllByTestId('mp-mem').find((b) => b.textContent?.includes('2D/vps.md'))!)
    expect(d.read).toHaveBeenCalledWith('2D/vps.md')
    v.rerender(<MemoryPanel data={{ ...d, bodies: new Map([['2D/vps.md', 'acesso: {{secret:vps_2d}}']]) }} atShelf={[]} onClose={close} onFlyToAgent={vi.fn()} onOpenConversation={open} now={NOW} />)
    const detail = screen.getByTestId('mp-detail')
    expect(detail.textContent).toContain('{{secret:vps_2d}}')
    fireEvent.click(within(detail).getByRole('button', { name: 'Loja' }))
    expect(open).toHaveBeenCalledWith('a')
    fireEvent.click(screen.getByRole('button', { name: 'Fechar as Memórias' }))
    expect(close).toHaveBeenCalled()
  })
})
