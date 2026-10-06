/** Avisos curtos (toasts) com tipo: cor por tipo, fecham no toque, somem sozinhos com fade-out. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { dismissToast, nav, toast, toasts } from '../app/runtime'
import { Toasts } from './Toasts'

/** Quanto o fade-out dura antes de o aviso sair da lista (runtime.ts). */
const FADE_MS = 220
const AUTO_MS = 4500

const noticeEl = (container: HTMLElement, text: string): HTMLElement | undefined =>
  Array.from(container.querySelectorAll<HTMLElement>('.toast')).find((el) => el.textContent === text)

const tick = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('Toasts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    toasts.set({ list: [] })
  })
  afterEach(() => {
    cleanup()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('toast com tipo ganha a classe do tipo (sucesso, erro, aviso)', () => {
    const { container } = render(<Toasts />)
    act(() => {
      toast('deu certo', 'sucesso')
      toast('deu errado', 'erro')
      toast('atenção', 'aviso')
    })
    expect(container.querySelector('.toast.sucesso')?.textContent).toBe('deu certo')
    expect(container.querySelector('.toast.erro')?.textContent).toBe('deu errado')
    expect(container.querySelector('.toast.aviso')?.textContent).toBe('atenção')
  })

  it('toast sem tipo não ganha classe de tipo (o visual neutro de sempre)', () => {
    const { container } = render(<Toasts />)
    act(() => toast('neutro'))
    const el = noticeEl(container, 'neutro')
    expect(el).toBeDefined()
    expect(el?.className).toBe('toast')
  })

  it('só o erro é anunciado como alerta; os outros ficam no container de status', () => {
    const { container } = render(<Toasts />)
    act(() => {
      toast('tudo certo', 'sucesso')
      toast('falhou', 'erro')
    })
    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(1)
    expect(alerts[0].textContent).toBe('falhou')
    expect(container.querySelector('.toasts')?.getAttribute('role')).toBe('status')
    expect(noticeEl(container, 'tudo certo')?.getAttribute('role')).toBeNull()
  })

  it('um toque fecha: marca "leaving" na hora e só some depois do fade-out', () => {
    const { container } = render(<Toasts />)
    act(() => toast('x', 'sucesso'))
    fireEvent.click(noticeEl(container, 'x') as HTMLElement)
    expect(noticeEl(container, 'x')?.className).toBe('toast sucesso leaving')
    tick(FADE_MS - 20)
    expect(noticeEl(container, 'x')).toBeDefined() // ainda no fade
    tick(40)
    expect(noticeEl(container, 'x')).toBeUndefined()
    expect(container.querySelector('.toasts')).toBeNull() // lista vazia: nada na tela
  })

  it('some sozinho depois de ~4,5 s, também com o fade-out', () => {
    const { container } = render(<Toasts />)
    act(() => toast('some sozinho', 'aviso'))
    tick(AUTO_MS - 100)
    expect(noticeEl(container, 'some sozinho')?.classList.contains('leaving')).toBe(false)
    tick(100)
    expect(noticeEl(container, 'some sozinho')?.classList.contains('leaving')).toBe(true)
    tick(FADE_MS)
    expect(noticeEl(container, 'some sozinho')).toBeUndefined()
  })

  it('o tempo (ms) continua o terceiro argumento de toast()', () => {
    const { container } = render(<Toasts />)
    act(() => toast('rápido', 'aviso', 1000))
    tick(1000)
    expect(noticeEl(container, 'rápido')?.classList.contains('leaving')).toBe(true)
  })

  it('fechado no toque, o temporizador de 4,5 s encontra o aviso já fora e não mexe em nada', () => {
    act(() => toast('um', 'sucesso'))
    const id = toasts.get().list[0].id
    act(() => dismissToast(id))
    tick(FADE_MS)
    expect(toasts.get().list).toEqual([])
    const before = toasts.get()
    tick(AUTO_MS)
    expect(toasts.get()).toBe(before) // nenhum "set" novo: a tela não é avisada à toa
  })

  it('dismissToast de um id que não existe, ou de um aviso que já está saindo, não mexe na lista', () => {
    act(() => toast('a', 'sucesso'))
    const id = toasts.get().list[0].id
    const same = toasts.get()
    dismissToast(9999)
    expect(toasts.get()).toBe(same)
    act(() => dismissToast(id))
    const leaving = toasts.get()
    expect(leaving.list[0].leaving).toBe(true)
    dismissToast(id) // 2º toque durante o fade
    expect(toasts.get()).toBe(leaving)
  })

  it('com o leitor de QR aberto, os avisos sobem (não cobrem a dica nem o Cancelar do leitor)', () => {
    const { container } = render(<Toasts />)
    act(() => toast('um aviso'))
    expect(container.querySelector('.toasts')?.classList.contains('over-scanner')).toBe(false)
    act(() => nav.set({ scanOpen: true }))
    expect(container.querySelector('.toasts')?.classList.contains('over-scanner')).toBe(true)
    act(() => nav.set({ scanOpen: false }))
    expect(container.querySelector('.toasts')?.classList.contains('over-scanner')).toBe(false)
  })

  it('no máximo 3 avisos na tela (os mais novos)', () => {
    const { container } = render(<Toasts />)
    act(() => {
      toast('1')
      toast('2')
      toast('3')
      toast('4')
    })
    expect(Array.from(container.querySelectorAll('.toast')).map((el) => el.textContent)).toEqual(['2', '3', '4'])
  })
})
