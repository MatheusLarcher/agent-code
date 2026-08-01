import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { AgentsPanel } from './AgentsPanel'
import type { AgentTrack, TrackMap } from '../agentTracks'

afterEach(cleanup)

function track(over: Partial<AgentTrack> = {}): AgentTrack {
  return {
    id: 't1',
    label: 'Explore: mapear rotas',
    status: 'running',
    startedAt: Date.now() - 5_000,
    stepCount: 2,
    steps: [
      { id: 's1', name: 'Grep', input: { pattern: 'rota' }, startedAt: Date.now() - 4_000, endedAt: Date.now() - 3_000, result: 'achou 3' },
      { id: 's2', name: 'Read', input: { file_path: 'C:\\proj\\src\\rotas.ts' }, startedAt: Date.now() - 1_000 }
    ],
    ...over
  }
}

const base = {
  busy: false,
  busySince: null,
  backgroundTasks: [],
  pendingPermissions: [],
  onFocusPermission: vi.fn(),
  loading: false,
  onClose: vi.fn(),
  projectEntries: [],
  projectTruncated: false,
  projectMissing: [],
  projectSteps: [],
  touches: [],
  projectName: 'projeto',
  width: 480
}

// jsdom não tem ResizeObserver (usado pelo mapa embutido no modo Fluxo).
class RO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO

describe('AgentsPanel', () => {
  it('mostra o skeleton enquanto carrega — e nenhum conteúdo real ainda', () => {
    render(<AgentsPanel {...base} loading tracks={{ t1: track() }} />)
    expect(document.querySelectorAll('.agents-skeleton .sk-track').length).toBeGreaterThan(0)
    expect(screen.queryByText('Explore: mapear rotas')).toBeNull()
  })

  it('lista a trilha com o que ela está executando agora', () => {
    render(<AgentsPanel {...base} tracks={{ t1: track() }} />)
    expect(screen.getByText('Explore: mapear rotas')).toBeTruthy()
    expect(screen.getByText('Read')).toBeTruthy() // ferramenta atual
    expect(screen.getByText('src/rotas.ts')).toBeTruthy() // detalhe legível, não o input cru
    expect(screen.getByText('2 ações')).toBeTruthy()
    expect(document.querySelector('.agent-track.running')).toBeTruthy()
  })

  it('trilha recém-aberta diz "iniciando", nunca "concluído"', () => {
    render(<AgentsPanel {...base} tracks={{ t1: track({ stepCount: 0, steps: [] }) }} />)
    expect(screen.getByText('iniciando…')).toBeTruthy()
    expect(screen.queryByText('concluído')).toBeNull()
  })

  it('expandir mostra os passos daquele subagente', () => {
    render(<AgentsPanel {...base} tracks={{ t1: track() }} />)
    expect(screen.queryByText('achou 3')).toBeNull()
    fireEvent.click(screen.getByText('Explore: mapear rotas'))
    expect(screen.getByText('achou 3')).toBeTruthy()
    expect(document.querySelectorAll('.agent-step').length).toBe(2)
  })

  it('sem subagente, explica o que vai aparecer ali (estado vazio ≠ carregando)', () => {
    render(<AgentsPanel {...base} tracks={{}} />)
    expect(screen.getByText(/Nenhum subagente foi disparado/)).toBeTruthy()
    expect(document.querySelector('.agents-skeleton')).toBeNull()
  })

  it('agente principal reflete o turno em andamento', () => {
    const { rerender } = render(<AgentsPanel {...base} tracks={{}} />)
    expect(screen.getByText('Ocioso')).toBeTruthy()
    rerender(<AgentsPanel {...base} tracks={{ t1: track() }} busy busySince={Date.now() - 3_000} />)
    expect(screen.getByText('Trabalhando na sua tarefa')).toBeTruthy()
    expect(screen.getByText('coordenando 1 subagente')).toBeTruthy()
  })

  it('mostra quem está travado esperando resposta e leva até lá', () => {
    const onFocus = vi.fn()
    render(
      <AgentsPanel
        {...base}
        tracks={{}}
        onFocusPermission={onFocus}
        pendingPermissions={[
          { convId: 'c9', title: 'CRM', request: { id: 'p1', toolName: 'Bash', input: {} } }
        ]}
      />
    )
    fireEvent.click(screen.getByText('CRM'))
    expect(onFocus).toHaveBeenCalledWith('c9')
  })

  it('só existem os modos Lista e Projeto — o fluxo foi removido', () => {
    render(<AgentsPanel {...base} tracks={{ t1: track() }} />)
    expect(screen.queryByTitle('Ver como fluxo')).toBeNull()
    expect(screen.queryByTitle('Expandir o fluxo')).toBeNull()
    expect(screen.getByTitle('Ver como lista')).toBeTruthy()
    expect(screen.getByTitle('Ver o mapa do projeto')).toBeTruthy()
  })

  it('etapas do projeto: minimizar deixa só as bolinhas, e volta ao clicar', () => {
    const steps = [
      { id: '1', content: 'Primeira etapa', status: 'completed' as const, activeForm: 'Fazendo a primeira' },
      { id: '2', content: 'Segunda etapa', status: 'in_progress' as const, activeForm: 'Fazendo a segunda' }
    ]
    render(<AgentsPanel {...base} tracks={{}} projectSteps={steps} />)
    fireEvent.click(screen.getByTitle('Ver o mapa do projeto'))

    // aberto: texto das etapas na tela (a atual usa o activeForm)
    expect(screen.getByText('Primeira etapa')).toBeTruthy()
    expect(screen.getByText('Fazendo a segunda')).toBeTruthy()
    expect(screen.getByText('1/2')).toBeTruthy()

    fireEvent.click(screen.getByTitle('Minimizar as etapas'))

    // minimizado: o texto SAI do DOM, sobram a contagem e as bolinhas
    expect(screen.queryByText('Primeira etapa')).toBeNull()
    expect(screen.queryByText('Fazendo a segunda')).toBeNull()
    expect(screen.getByText('1/2')).toBeTruthy()
    expect(document.querySelectorAll('.pgraph-steps.mini li i').length).toBe(2)

    fireEvent.click(screen.getByTitle('Mostrar as etapas'))
    expect(screen.getByText('Primeira etapa')).toBeTruthy()
  })

  it('trilha concluída para de girar e a com erro fica marcada', () => {
    const map: TrackMap = {
      ok: track({ id: 'ok', label: 'terminada', status: 'done', endedAt: Date.now() }),
      bad: track({ id: 'bad', label: 'quebrada', status: 'error', endedAt: Date.now() })
    }
    render(<AgentsPanel {...base} tracks={map} />)
    expect(document.querySelector('.agent-track.error')).toBeTruthy()
    expect(screen.getByText('terminou com erro')).toBeTruthy()
    // nenhuma barra de progresso sobrando numa trilha que já acabou
    expect(document.querySelectorAll('.agent-track-progress').length).toBe(0)
  })
})
