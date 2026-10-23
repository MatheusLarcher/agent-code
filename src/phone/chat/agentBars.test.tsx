/**
 * As faixas do trabalho paralelo no celular: os subagentes rodando (papel, resumo
 * do SDK e tempo), que vêm no estado publicado pelo PC e somem quando acabam.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { client, toasts } from '../app/runtime'
import { resetApp } from '../app/testSupport'
import type { ConvSummary } from '../core/types'
import { BackgroundTasksCard, SubagentStrip } from './AgentBars'
import { ChatView } from './ChatView'

const conv = (extra: Partial<ConvSummary> = {}): ConvSummary => ({ id: 'c1', title: 'Loja', cwd: '/p', busy: true, connected: true, updatedAt: 1, ...extra })

beforeEach(resetApp)
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('BackgroundTasksCard (celular)', () => {
  const tasks = [
    { id: 'b1', type: 'local_bash', description: 'npm run dev' },
    { id: 'a2', type: 'local_agent', description: 'Revisar o login' }
  ]

  it('"Tarefas em segundo plano (N)", uma linha por tarefa; o parar manda só o id daquela', async () => {
    const stop = vi.spyOn(client, 'stopTask').mockResolvedValue(true)
    const { container, getByLabelText } = render(<BackgroundTasksCard conv={conv({ backgroundTasks: tasks })} />)
    expect(container.querySelector('.bg-tasks-title')?.textContent).toBe('Tarefas em segundo plano (2)')
    expect([...container.querySelectorAll('.bg-task-desc')].map((d) => d.textContent)).toEqual(['npm run dev', 'Revisar o login'])
    await act(async () => fireEvent.click(getByLabelText('Parar a tarefa npm run dev')))
    expect(stop).toHaveBeenCalledExactlyOnceWith('b1')
    expect(toasts.get().list).toEqual([])
  })

  it('o PC não conseguiu (ou caiu a conexão): toast de erro', async () => {
    vi.spyOn(client, 'stopTask').mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('offline'))
    const { getByLabelText } = render(<BackgroundTasksCard conv={conv({ backgroundTasks: tasks })} />)
    await act(async () => fireEvent.click(getByLabelText('Parar a tarefa npm run dev')))
    await act(async () => fireEvent.click(getByLabelText('Parar a tarefa Revisar o login')))
    const errors = toasts.get().list.filter((t) => t.tipo === 'erro').map((t) => t.text)
    expect(errors).toEqual(['Não consegui parar a tarefa em segundo plano.', 'Não consegui parar a tarefa em segundo plano.'])
  })

  it('sem tarefa, o cartão some', () => {
    expect(render(<BackgroundTasksCard conv={conv()} />).container.firstChild).toBeNull()
  })
})

describe('SubagentStrip', () => {
  it('uma linha por subagente rodando: papel · resumo e o tempo desde o início', () => {
    const now = Date.now()
    const { container } = render(
      <SubagentStrip
        conv={conv({
          subagents: [
            { id: 't1', label: 'Executor', summary: 'Analisando o módulo de autenticação', startedAt: now - 84_000 },
            { id: 't2', label: 'Crítico', startedAt: now - 5_000 }
          ]
        })}
      />
    )
    const rows = [...container.querySelectorAll('.subagent-row')]
    expect(rows.map((r) => r.querySelector('.subagent-text')?.textContent)).toEqual(['Executor · Analisando o módulo de autenticação', 'Crítico'])
    expect(rows[0].querySelector('.subagent-t')?.textContent).toMatch(/^1min 2[45]s$/)
    expect(rows[1].querySelector('.subagent-t')?.textContent).toMatch(/^[56]s$/)
  })

  it('sem subagente rodando, a faixa some', () => {
    expect(render(<SubagentStrip conv={conv()} />).container.firstChild).toBeNull()
    expect(render(<SubagentStrip conv={conv({ subagents: [] })} />).container.firstChild).toBeNull()
  })

  it('a conversa aberta mostra a faixa a partir do estado publicado', () => {
    client.store.set({
      conversations: [conv({ subagents: [{ id: 't1', label: 'Executor', summary: 'Rodando os testes', startedAt: Date.now() }] })],
      convId: 'c1',
      messages: [],
      historyLoading: false,
      loaded: true
    })
    const { container } = render(<ChatView />)
    expect(container.querySelector('.subagent-strip .subagent-text')?.textContent).toBe('Executor · Rodando os testes')
  })
})
