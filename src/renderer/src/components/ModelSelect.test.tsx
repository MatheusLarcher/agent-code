import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ModelSelect } from './ModelSelect'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const MODELS = [
  { id: 'opus-5', label: 'Opus 5' },
  { id: 'opus-55', label: 'Opus 5.5' },
  { id: 'sonnet', label: 'Sonnet 5' }
]

function setup(value = 'sonnet'): { list: HTMLElement; trigger: HTMLButtonElement; onChange: ReturnType<typeof vi.fn> } {
  const onChange = vi.fn()
  const { container } = render(<ModelSelect models={MODELS} value={value} locked={false} tip="Modelo usado nesta conversa" onChange={onChange} onLockedClick={() => {}} />)
  const trigger = container.querySelector('button.model-select') as HTMLButtonElement
  fireEvent.click(trigger)
  return { list: container.querySelector('[role="listbox"]') as HTMLElement, trigger, onChange }
}

const activeLabel = (list: HTMLElement): string | undefined => list.querySelector('.model-select-option.active')?.textContent ?? undefined

describe('ModelSelect', () => {
  it('a dica vai em data-tip, nunca no title nativo', () => {
    const { trigger } = setup()
    expect(trigger.getAttribute('data-tip')).toBe('Modelo usado nesta conversa')
    expect(trigger.hasAttribute('title')).toBe(false)
  })

  it('sem busca por letra em andamento, o espaço escolhe a opção ativa', () => {
    const { list, onChange } = setup()
    fireEvent.keyDown(list, { key: 'Home' })
    fireEvent.keyDown(list, { key: ' ' })
    expect(onChange).toHaveBeenCalledWith('opus-5')
    expect(list.hidden).toBe(true)
  })

  it('com busca por letra em andamento, o espaço entra na busca em vez de escolher', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-27T12:00:00Z'))
    const { list, onChange } = setup()
    for (const key of ['o', 'p', 'u', 's', ' ', '5', '.']) {
      fireEvent.keyDown(list, { key })
      vi.advanceTimersByTime(100)
    }
    expect(onChange).not.toHaveBeenCalled()
    expect(list.hidden).toBe(false)
    expect(activeLabel(list)).toBe('Opus 5.5')
  })

  it('passada a janela da busca, o espaço volta a escolher', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-27T12:00:00Z'))
    const { list, onChange } = setup()
    fireEvent.keyDown(list, { key: 'o' })
    expect(activeLabel(list)).toBe('Opus 5')
    vi.advanceTimersByTime(700)
    fireEvent.keyDown(list, { key: ' ' })
    expect(onChange).toHaveBeenCalledWith('opus-5')
  })
})
