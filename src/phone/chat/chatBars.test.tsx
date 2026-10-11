/**
 * A barra de plano no celular (TodoPlan): numa conversa de handoff (`conv.etapas`)
 * mostra o PLACAR DO PLANO que o main leu do banco — prontas/total das etapas do
 * roteiro e a lista delas — e a lista do agente só recolhida, como detalhe; sem
 * `etapas`, a lista do agente (TodoWrite) como sempre foi.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { RemoteEtapasProgress } from '@shared/ipc'
import { resetApp } from '../app/testSupport'
import type { ConvSummary } from '../core/types'
import { TodoPlan } from './ChatBars'

type Step = RemoteEtapasProgress['steps'][number]
type AgentItem = NonNullable<ConvSummary['todoPlan']>['items'][number]

const step = (n: number, state: Step['state'], motivo: string | null = null): Step => ({ id: `e${n}`, titulo: `Etapa ${n}`, n, state, motivo })
const ETAPAS: RemoteEtapasProgress = {
  planSlug: 'checkout',
  planTitulo: 'Checkout',
  prompt: { n: 2, m: 3 },
  envioStatus: 'em_execucao',
  total: 10,
  prontas: 9,
  incompletas: 1,
  atual: 7,
  steps: Array.from({ length: 10 }, (_, i) => (i === 6 ? step(7, 'trinca', 'faltou o teste de integração') : step(i + 1, 'pronto')))
}
/** A lista do agente de hoje, que recomeçou a numeração: 25 itens, 10 feitos — o "10/25" que o placar corrige. */
const AGENT = {
  active: true,
  items: Array.from({ length: 25 }, (_, i): AgentItem => ({
    content: `Tarefa ${i + 1}`,
    status: i < 10 ? 'completed' : i === 10 ? 'in_progress' : 'pending',
    activeForm: `Fazendo ${i + 1}`
  }))
}
const conv = (extra: Partial<ConvSummary> = {}): ConvSummary => ({ id: 'c1', title: 'Loja', cwd: '/p', busy: true, connected: true, updatedAt: 1, ...extra })

beforeEach(resetApp)
afterEach(cleanup)

describe('TodoPlan no celular — conversa de handoff (conv.etapas)', () => {
  it('o cabeçalho conta as etapas do PLANO (9/10), nunca a lista do agente (10/25); subtítulo com o plano e "Prompt 2 de 3"', () => {
    const { container } = render(<TodoPlan conv={conv({ etapas: ETAPAS, todoPlan: AGENT })} />)
    expect(container.querySelector('.etapas-plan')).not.toBeNull()
    expect(container.querySelector('.todo-title')?.textContent).toBe('◔ 9/10 etapas')
    expect(container.querySelector('.etapas-sub')?.textContent).toBe('Checkout · Prompt 2 de 3')
    expect(container.textContent).not.toContain('10/25')
  })

  it('a lista das etapas na ordem n com a marca por estado, a trinca com o motivo em linha menor e a atual destacada', () => {
    const { container } = render(<TodoPlan conv={conv({ etapas: { ...ETAPAS, steps: [...ETAPAS.steps].reverse() } })} />)
    const items = [...container.querySelectorAll<HTMLElement>('.todo-item.etapa')]
    expect(items).toHaveLength(10)
    expect(items.map((el) => el.querySelector('.etapa-titulo')?.textContent)).toEqual(Array.from({ length: 10 }, (_, i) => `${i + 1}. Etapa ${i + 1}`))
    expect(items.map((el) => el.querySelector('.todo-mark')?.textContent).join('')).toBe('✓✓✓✓✓✓✗✓✓✓')
    expect(items[6].className).toBe('todo-item etapa trinca atual')
    expect(items[6].querySelector('.etapa-motivo')?.textContent).toBe('faltou o teste de integração')
    expect(container.querySelectorAll('.etapa-motivo')).toHaveLength(1)
    expect(container.querySelectorAll('.todo-item.atual')).toHaveLength(1)
  })

  it('marcas: pronto ✓, massa ●, fila/planta ○, trinca ✗; parado mostra ○ e tudo pronto ✓; recolhida, a atual vai ao título', () => {
    const mix: RemoteEtapasProgress = {
      ...ETAPAS,
      total: 5,
      prontas: 1,
      incompletas: 1,
      atual: 2,
      steps: [step(1, 'pronto'), step(2, 'massa'), step(3, 'fila'), step(4, 'planta'), step(5, 'trinca')]
    }
    const { container } = render(<TodoPlan conv={conv({ etapas: mix, busy: false })} />)
    expect([...container.querySelectorAll('.todo-item.etapa .todo-mark')].map((m) => m.textContent)).toEqual(['✓', '●', '○', '○', '✗'])
    expect(container.querySelector('.todo-title')?.textContent).toBe('○ 1/5 etapas')
    fireEvent.click(container.querySelector('.todo-head')!)
    expect(container.querySelector('.todo-title')?.textContent).toBe('○ 1/5 · Etapa 2')
    expect(container.querySelector('.todo-list')).toBeNull()
    cleanup()
    const pronto: RemoteEtapasProgress = { ...ETAPAS, prontas: 10, incompletas: 0, atual: null, steps: ETAPAS.steps.map((s) => ({ ...s, state: 'pronto', motivo: null })) }
    const done = render(<TodoPlan conv={conv({ etapas: pronto, busy: false })} />)
    expect(done.container.querySelector('.todo-title')?.textContent).toBe('✓ 10/10 etapas')
  })

  it('a lista do agente fica recolhida em "Tarefas do agente (25)" e abre no toque — detalhe, nunca o contador', () => {
    const { container } = render(<TodoPlan conv={conv({ etapas: ETAPAS, todoPlan: AGENT })} />)
    const head = container.querySelector<HTMLElement>('.agent-todo-head')
    expect(head?.textContent).toBe('Tarefas do agente (25) ▸')
    expect(container.querySelector('.agent-todo-list')).toBeNull()
    fireEvent.click(head!)
    expect(container.querySelectorAll('.agent-todo-list .todo-item')).toHaveLength(25)
    expect(container.querySelectorAll('.agent-todo-list .todo-item.completed')).toHaveLength(10)
    expect(container.querySelector('.todo-title')?.textContent).toBe('◔ 9/10 etapas')
    cleanup()
    // Sem lista do agente: sem o bloco.
    const only = render(<TodoPlan conv={conv({ etapas: ETAPAS })} />)
    expect(only.container.querySelector('.agent-todo')).toBeNull()
  })
})

describe('TodoPlan no celular — sem conv.etapas (o comportamento de hoje)', () => {
  it('conta a lista do agente e lista as tarefas como sempre; sem lista, nada', () => {
    const plan = {
      active: true,
      items: [
        { content: 'Ler o código', status: 'completed', activeForm: 'Lendo o código' },
        { content: 'Editar', status: 'in_progress', activeForm: 'Editando' },
        { content: 'Testar', status: 'pending', activeForm: 'Testando' }
      ] as AgentItem[]
    }
    const { container } = render(<TodoPlan conv={conv({ todoPlan: plan })} />)
    expect(container.querySelector('.etapas-plan, .etapas-sub, .agent-todo')).toBeNull()
    expect(container.querySelector('.todo-title')?.textContent).toBe('◔ 1/3 etapas')
    const items = [...container.querySelectorAll<HTMLElement>('.todo-list > .todo-item')]
    expect(items.map((el) => el.className)).toEqual(['todo-item completed', 'todo-item in_progress', 'todo-item pending'])
    expect(items.map((el) => el.querySelector('.todo-mark')?.textContent)).toEqual(['✓', '●', '○'])
    expect(items.map((el) => el.querySelector('.todo-text')?.textContent)).toEqual(['Ler o código', 'Editando', 'Testar'])
    fireEvent.click(container.querySelector('.todo-head')!)
    expect(container.querySelector('.todo-title')?.textContent).toBe('◔ 1/3 · Editando')
    expect(container.querySelector('.todo-list')).toBeNull()
    cleanup()
    const idle = render(<TodoPlan conv={conv({ todoPlan: { ...plan, active: false } })} />)
    expect(idle.container.querySelector('.todo-title')?.textContent).toBe('✓ 1/3 etapas')
    cleanup()
    expect(render(<TodoPlan conv={conv()} />).container.innerHTML).toBe('')
    cleanup()
    expect(render(<TodoPlan conv={conv({ todoPlan: { active: false, items: [] } })} />).container.innerHTML).toBe('')
  })
})
