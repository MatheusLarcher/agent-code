// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SetupTask } from '@shared/setupTasks'
import { requestSetupTask, useSetupAssistant } from './setupAssistant'

const task: SetupTask = { id: 'chrome-extension', display: 'Instale a extensão.', prompt: 'passos…' }

function Listener({ run }: { run: (t: SetupTask) => void }): null {
  useSetupAssistant(run)
  return null
}

afterEach(cleanup)

describe('setupAssistant', () => {
  it('entrega a tarefa a quem escuta e avisa a tela que foi aceita', () => {
    const run = vi.fn()
    render(<Listener run={run} />)
    expect(requestSetupTask(task)).toBe(true)
    expect(run).toHaveBeenCalledWith(task)
  })

  it('sem ninguém escutando, a tela fica sabendo', () => {
    expect(requestSetupTask(task)).toBe(false)
  })

  it('para de escutar ao desmontar e ignora evento sem tarefa válida', () => {
    const run = vi.fn()
    const { unmount } = render(<Listener run={run} />)
    window.dispatchEvent(new CustomEvent('agentcode:setup-task', { detail: { id: 'x' } }))
    expect(run).not.toHaveBeenCalled()
    unmount()
    expect(requestSetupTask(task)).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('usa sempre a função mais recente do App', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(<Listener run={first} />)
    rerender(<Listener run={second} />)
    requestSetupTask(task)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
