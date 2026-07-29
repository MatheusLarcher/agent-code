import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { AgentFlow } from './AgentFlow'
import type { AgentTrack } from '../agentTracks'

afterEach(cleanup)

// jsdom não tem ResizeObserver (o mapa usa para caber na janela).
class RO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO

function track(over: Partial<AgentTrack> = {}): AgentTrack {
  return {
    id: 't1',
    label: 'Explore: mapear rotas',
    status: 'running',
    startedAt: Date.now() - 4_000,
    stepCount: 2,
    steps: [
      { id: 's1', name: 'Grep', input: { pattern: 'rota' }, startedAt: Date.now() - 3_000, endedAt: Date.now() - 2_000 },
      { id: 's2', name: 'Read', input: { file_path: 'C:\\proj\\src\\rotas.ts' }, startedAt: Date.now() - 1_000 }
    ],
    ...over
  }
}

const base = { busy: true, busySince: Date.now() - 8_000, title: 'Refatorar rotas', onClose: vi.fn() }

describe('AgentFlow', () => {
  it('desenha a cadeia: seu pedido → agente principal → subagente → ações', () => {
    render(<AgentFlow {...base} tracks={{ t1: track() }} />)
    expect(screen.getByText('Seu pedido')).toBeTruthy()
    expect(screen.getByText('Refatorar rotas')).toBeTruthy()
    expect(screen.getByText('Agente principal')).toBeTruthy()
    expect(screen.getByText('Explore: mapear rotas')).toBeTruthy()
    expect(screen.getByText('Grep')).toBeTruthy()
    expect(screen.getByText('rotas.ts')).toBeTruthy()
  })

  it('cada nó tem sua ligação desenhada (nenhuma sobra, nenhuma faltando)', () => {
    const map = { t1: track(), t2: track({ id: 't2', label: 'outra', steps: [], stepCount: 0 }) }
    render(<AgentFlow {...base} tracks={map} />)
    // 2 ligações agente→subagente + 2 passos da primeira trilha
    expect(document.querySelectorAll('.flow-link:not(.thin)').length).toBe(3) // inclui a oculta da raiz
    expect(document.querySelectorAll('.flow-link.thin').length).toBe(2)
  })

  it('quem está rodando fica marcado como vivo', () => {
    render(<AgentFlow {...base} tracks={{ t1: track() }} />)
    expect(document.querySelector('.flow-node.agent.running')).toBeTruthy()
    expect(document.querySelector('.flow-node.step.running')).toBeTruthy()
    expect(document.querySelector('.flow-link.live')).toBeTruthy()
  })

  it('trilha concluída não fica marcada como viva', () => {
    render(
      <AgentFlow
        {...base}
        busy={false}
        tracks={{ t1: track({ status: 'done', endedAt: Date.now(), steps: [] }) }}
      />
    )
    expect(document.querySelector('.flow-node.agent.running')).toBeNull()
    expect(screen.getByText('ocioso')).toBeTruthy()
  })

  it('sem subagente, explica em vez de mostrar um mapa vazio', () => {
    render(<AgentFlow {...base} tracks={{}} />)
    expect(screen.getByText(/Ainda não há subagentes/)).toBeTruthy()
  })

  it('fecha no Esc e no botão', () => {
    const onClose = vi.fn()
    render(<AgentFlow {...base} onClose={onClose} tracks={{ t1: track() }} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTitle('Fechar (Esc)'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('mostra só as ações mais recentes de cada subagente (não vira parede)', () => {
    const steps = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      name: 'Read',
      input: { file_path: `arquivo${i}.ts` },
      startedAt: Date.now() - 1000,
      endedAt: Date.now()
    }))
    render(<AgentFlow {...base} tracks={{ t1: track({ steps, stepCount: 12 }) }} />)
    expect(document.querySelectorAll('.flow-node.step').length).toBe(5)
    expect(screen.getByText('arquivo11.ts')).toBeTruthy() // manteve as últimas
    expect(screen.queryByText('arquivo0.ts')).toBeNull()
    expect(screen.getByText(/12 ações/)).toBeTruthy() // mas o total continua honesto
  })
})
