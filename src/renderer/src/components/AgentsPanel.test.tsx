import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { AgentsPanel } from './AgentsPanel'
import { buildCrew } from '../crew'
import type { AgentTrack } from '../agentTracks'

afterEach(cleanup)

function track(over: Partial<AgentTrack> = {}): AgentTrack {
  return {
    id: 't1',
    label: 'executor: implementar o failover',
    subagentType: 'executor',
    status: 'running',
    startedAt: Date.now() - 5_000,
    stepCount: 2,
    steps: [
      {
        id: 's1',
        name: 'Grep',
        input: { pattern: 'rota' },
        startedAt: Date.now() - 4_000,
        endedAt: Date.now() - 3_000,
        result: 'achou 3'
      },
      { id: 's2', name: 'Read', input: { file_path: 'C:\\proj\\src\\rotas.ts' }, startedAt: Date.now() - 1_000 }
    ],
    ...over
  }
}

/** O elenco montado pelo App — o painel só o renderiza. */
function crewOf(over: Partial<Parameters<typeof buildCrew>[0]> = {}): ReturnType<typeof buildCrew> {
  return buildCrew({
    tracks: {},
    busy: false,
    busySince: null,
    vigia: null,
    po: null,
    poEnabled: true,
    vigiaEnabled: true,
    ...over
  })
}

const base = {
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
  turns: [],
  projectName: 'projeto',
  onOpenBoard: vi.fn(),
  width: 480,
  crew: crewOf()
}

// jsdom não tem ResizeObserver (usado pelo mapa embutido no modo Projeto).
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
    expect(document.querySelector('.crew-roster')).toBeNull()
  })

  it('o elenco inteiro está em cena mesmo com ninguém trabalhando', () => {
    render(<AgentsPanel {...base} tracks={{}} />)
    for (const name of ['Principal', 'executor', 'critico', 'navegador-de-codigo', 'memoria', 'PO', 'vigia']) {
      expect(screen.getByText(name)).toBeTruthy()
    }
    // Parado é recuado, não ausente: é o contraste que faz "começou" aparecer.
    expect(document.querySelectorAll('.crew-agent.idle').length).toBeGreaterThan(0)
    expect(document.querySelector('.crew-agent.working')).toBeNull()
  })

  it('quem começa a trabalhar acende, com a ferramenta e o pulso de chegada', () => {
    // Entrou em campo agora: é o instante que o recurso existe para tornar visível.
    const recemChegado = track({ startedAt: Date.now() - 500 })
    const crew = crewOf({ tracks: { t1: recemChegado }, busy: true, busySince: Date.now() - 30_000 })
    render(<AgentsPanel {...base} crew={crew} tracks={{ t1: recemChegado }} />)
    const working = document.querySelectorAll('.crew-agent.working')
    expect(working.length).toBe(2) // principal + executor
    // A ferramenta atual aparece em destaque na linha do cartão. O seletor é
    // específico porque o Principal também tem a sua ("Agent", delegando) e o
    // mesmo nome ainda se repete na lista de passos.
    const card = [...working].find((el) => el.querySelector('.crew-name')?.textContent?.startsWith('executor'))
    expect(card?.querySelector('.crew-tool')?.textContent).toBe('Read')
    expect(screen.getByText('rotas.ts')).toBeTruthy()
    // Começou agora: o pulso de chegada está ligado.
    expect(document.querySelector('.crew-agent.just-started')).toBeTruthy()
  })

  it('cartão que está trabalhando já abre com os passos, sem precisar clicar', () => {
    const crew = crewOf({ tracks: { t1: track() } })
    render(<AgentsPanel {...base} crew={crew} tracks={{ t1: track() }} />)
    expect(document.querySelectorAll('.crew-step').length).toBe(2)
    fireEvent.click(screen.getByText('executor'))
    expect(document.querySelectorAll('.crew-step').length).toBe(0)
  })

  it('a dúvida do vigia é o único estado que pede ação', () => {
    const crew = crewOf({ vigia: { at: Date.now() - 40_000 } })
    render(<AgentsPanel {...base} crew={crew} tracks={{}} />)
    expect(screen.getByText('1 dúvida esperando você')).toBeTruthy()
    expect(document.querySelector('.crew-agent.asking')).toBeTruthy()
    expect(screen.getByText('responder')).toBeTruthy()
  })

  it('observador desligado nas Configurações some do elenco', () => {
    const crew = crewOf({ poEnabled: false, vigiaEnabled: false })
    render(<AgentsPanel {...base} crew={crew} tracks={{}} />)
    expect(screen.queryByText('PO')).toBeNull()
    expect(screen.queryByText('vigia')).toBeNull()
  })

  it('a linha do tempo mostra uma faixa por quem trabalhou', () => {
    const crew = crewOf({ tracks: { t1: track() }, busy: true, busySince: Date.now() - 9_000 })
    render(<AgentsPanel {...base} crew={crew} tracks={{ t1: track() }} />)
    fireEvent.click(screen.getByText('Linha do tempo'))
    expect(document.querySelectorAll('.crew-tl-row').length).toBe(2)
    expect(document.querySelectorAll('.crew-tl-bar.live').length).toBe(2)
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

  it('os modos são Equipe, Tarefas e Projeto', () => {
    render(<AgentsPanel {...base} tracks={{ t1: track() }} />)
    expect(screen.getByTitle('Ver a equipe')).toBeTruthy()
    expect(screen.getByTitle('Ver o mapa do projeto')).toBeTruthy()
    expect(screen.queryByTitle('Ver como lista')).toBeNull()
  })

  it('etapas do projeto: minimizar deixa só as bolinhas, e volta ao clicar', () => {
    const steps = [
      { id: '1', content: 'Primeira etapa', status: 'completed' as const, activeForm: 'Fazendo a primeira' },
      { id: '2', content: 'Segunda etapa', status: 'in_progress' as const, activeForm: 'Fazendo a segunda' }
    ]
    render(<AgentsPanel {...base} tracks={{}} projectSteps={steps} />)
    fireEvent.click(screen.getByTitle('Ver o mapa do projeto'))

    expect(screen.getByText('Primeira etapa')).toBeTruthy()
    expect(screen.getByText('Fazendo a segunda')).toBeTruthy()
    expect(screen.getByText('1/2')).toBeTruthy()

    fireEvent.click(screen.getByTitle('Minimizar as etapas'))

    expect(screen.queryByText('Primeira etapa')).toBeNull()
    expect(screen.queryByText('Fazendo a segunda')).toBeNull()
    expect(screen.getByText('1/2')).toBeTruthy()
    expect(document.querySelectorAll('.pgraph-steps.mini li i').length).toBe(2)

    fireEvent.click(screen.getByTitle('Mostrar as etapas'))
    expect(screen.getByText('Primeira etapa')).toBeTruthy()
  })

  it('trilha que terminou para de girar; a que falhou fica marcada', () => {
    const done = track({ id: 'ok', status: 'done', endedAt: Date.now() - 1_000 })
    const bad = track({ id: 'bad', subagentType: 'critico', status: 'error', endedAt: Date.now() - 500 })
    const crew = crewOf({ tracks: { ok: done, bad } })
    render(<AgentsPanel {...base} crew={crew} tracks={{ ok: done, bad }} />)
    expect(document.querySelector('.crew-agent.failed')).toBeTruthy()
    expect(screen.getByText('terminou com erro')).toBeTruthy()
    expect(document.querySelector('.crew-agent.working')).toBeNull()
  })
})
