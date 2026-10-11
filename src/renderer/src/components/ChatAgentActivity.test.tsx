import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UiProvider } from '../ui/UiProvider'
import type { AgentTrack, TrackMap } from '../agentTracks'
import { ChatAgentActivity } from './ChatAgentActivity'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const track = (over: Partial<AgentTrack>): AgentTrack => ({
  id: 't1', label: 'Explore: achar o reducer', subagentType: 'Explore', status: 'running', startedAt: Date.now(), stepCount: 0, steps: [], ...over
})
const map = (...tracks: AgentTrack[]): TrackMap => Object.fromEntries(tracks.map((t) => [t.id, t]))
const view = (tracks?: TrackMap) => render(<UiProvider><ChatAgentActivity tracks={tracks} /></UiProvider>)

describe('ChatAgentActivity (atividade dos agentes na aba Conversa)', () => {
  it('sem trilhas não desenha nada', () => {
    const { container } = view({})
    expect(container.querySelector('.chat-agent-activity')).toBeNull()
    cleanup()
    expect(view(undefined).container.querySelector('.chat-agent-activity')).toBeNull()
  })

  it('um cartão por trilha (não agrupa por papel), com tarefa, estado e atividade atual', () => {
    view(map(
      track({ id: 'a', steps: [{ id: 's', name: 'Grep', input: { pattern: 'reduceTracks' }, startedAt: 1 }], stepCount: 1 }),
      track({ id: 'b', label: 'Explore: mapear o preload', startedAt: Date.now() - 1000 })
    ))
    const cards = screen.getAllByRole('button', { expanded: false })
    expect(cards).toHaveLength(2)
    expect(cards[0].textContent).toContain('achar o reducer')
    expect(cards[0].textContent).toContain('trabalhando')
    expect(cards[0].textContent).toContain('Agora: busca reduceTracks')
    expect(cards[1].textContent).toContain('mapear o preload')
    expect(cards[1].textContent).toContain('aguardando')
    // Tudo rodando: nada de aviso de histórico temporário ainda.
    expect(screen.queryByText(/Histórico temporário desta sessão/)).toBeNull()
  })

  it('expande por clique/teclado (aria-expanded) e mostra o histórico de ações e o resultado, sem segredo', () => {
    view(map(track({
      status: 'done', endedAt: Date.now(), stepCount: 70,
      steps: [
        { id: 's1', name: 'Read', input: { file_path: 'C:/p/src/a.ts' }, startedAt: 1, endedAt: 2, result: 'linha' },
        { id: 's2', name: 'mcp__memory__memory_secret_get', input: { name: 'api' }, startedAt: 2, endedAt: 3, result: 'sk-live-123' }
      ],
      task: { id: 'k', status: 'completed', summary: 'Achei em agentTracks.ts' }
    })))
    const head = screen.getByRole('button', { expanded: false })
    expect(head.textContent).toContain('concluído')
    expect(screen.getByText(/Histórico temporário desta sessão/)).toBeTruthy()
    expect(document.querySelector('.tool-card')).toBeNull()
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('true')
    const region = document.getElementById(head.getAttribute('aria-controls')!)!
    expect(region.querySelectorAll('.tool-card')).toHaveLength(2)
    expect(region.textContent).toContain('Mostrando as últimas 2 de 70 ações')
    expect(region.textContent).toContain('Achei em agentTracks.ts')
    // Abre o resultado da ação do cofre: o valor nunca aparece.
    region.querySelectorAll<HTMLButtonElement>('.tool-head').forEach((b) => fireEvent.click(b))
    expect(document.body.textContent).not.toContain('sk-live-123')
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.tool-card')).toBeNull()
  })

  it('erro e interrompido têm o próprio estado', () => {
    view(map(
      track({ id: 'e', status: 'error', endedAt: Date.now() }),
      track({ id: 's', status: 'done', endedAt: Date.now(), task: { id: 'k', status: 'stopped' } })
    ))
    const text = screen.getAllByRole('button').map((b) => b.textContent).join(' ')
    expect(text).toContain('erro')
    expect(text).toContain('interrompido')
  })

  it('atualiza ao vivo: nova ação aparece e o tempo corre enquanto há trilha rodando', () => {
    vi.useFakeTimers()
    const start = Date.now()
    const t = track({ startedAt: start })
    const { rerender } = view(map(t))
    expect(screen.getByRole('button').textContent).toContain('0s')
    act(() => { vi.advanceTimersByTime(3000) })
    expect(screen.getByRole('button').textContent).toContain('3s')
    rerender(<UiProvider><ChatAgentActivity tracks={map({ ...t, stepCount: 1, steps: [{ id: 'x', name: 'Bash', input: { command: 'npm test' }, startedAt: start }] })} /></UiProvider>)
    expect(screen.getByRole('button').textContent).toContain('Agora: bash npm test')
    expect(screen.getByRole('button').textContent).toContain('1 ação')
  })
})
