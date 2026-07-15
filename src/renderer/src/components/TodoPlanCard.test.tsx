import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TodoPlan } from '../types'
import { TodoPlanCard } from './TodoPlanCard'

afterEach(cleanup)

const activePlan: TodoPlan = {
  active: true,
  items: [
    { content: 'Reproduzir o bug', status: 'completed', activeForm: 'Reproduzindo o bug' },
    { content: 'Corrigir a validação', status: 'in_progress', activeForm: 'Corrigindo a validação' },
    { content: 'Adicionar teste', status: 'pending', activeForm: 'Adicionando teste' }
  ]
}

describe('TodoPlanCard', () => {
  it('fechado (padrão) mostra a tarefa atual, contagem e pontinhos — sem o texto de todos os itens', () => {
    render(<TodoPlanCard plan={activePlan} />)
    expect(screen.getByText('Corrigindo a validação')).toBeTruthy()
    expect(screen.getByText('1/3')).toBeTruthy()
    expect(document.querySelectorAll('.todo-plan-dot')).toHaveLength(3)
    // A lista completa (com o texto no infinitivo de cada item) só aparece expandida.
    expect(screen.queryByText('Corrigir a validação')).toBeNull()
  })

  it('clicar no cabeçalho expande a lista completa; clicar de novo recolhe', () => {
    render(<TodoPlanCard plan={activePlan} />)
    const head = screen.getByRole('button')
    fireEvent.click(head)
    expect(screen.getByText('Reproduzir o bug')).toBeTruthy()
    expect(screen.getByText('Corrigir a validação')).toBeTruthy()
    expect(screen.getByText('Adicionar teste')).toBeTruthy()

    fireEvent.click(head)
    expect(screen.queryByText('Reproduzir o bug')).toBeNull()
  })

  it('plano concluído (active:false, tudo completed) recolhe pra resumo "N/N concluído" sem spinner', () => {
    const donePlan: TodoPlan = {
      active: false,
      items: activePlan.items.map((t) => ({ ...t, status: 'completed' }))
    }
    render(<TodoPlanCard plan={donePlan} />)
    expect(screen.getByText('3/3 concluído')).toBeTruthy()
    expect(document.querySelector('.spinner')).toBeNull()
    expect(document.querySelector('.todo-plan-check-all')).toBeTruthy()
  })

  it('turno terminado com itens ainda pendentes (interrompido) também recolhe, refletindo o estado parcial', () => {
    const interruptedPlan: TodoPlan = { active: false, items: activePlan.items }
    render(<TodoPlanCard plan={interruptedPlan} />)
    // Sem tarefa in_progress "ativa" pra mostrar (active:false) — cai no resumo.
    expect(screen.getByText('1/3 concluído')).toBeTruthy()
  })

  it('card ainda é clicável (expansível) mesmo depois de concluído/recolhido', () => {
    const donePlan: TodoPlan = {
      active: false,
      items: activePlan.items.map((t) => ({ ...t, status: 'completed' }))
    }
    render(<TodoPlanCard plan={donePlan} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Reproduzir o bug')).toBeTruthy()
  })
})
