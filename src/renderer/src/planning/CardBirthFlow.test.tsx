import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UiProvider } from '../ui/UiProvider'
import { ARRIVE_MS, CardBirthFlow, FLOW_MS, STAGGER_MS, cardSelector, flowPath } from './CardBirthFlow'
import { CWD, SLUG, makeCard, makePlan, mockPlanningApi } from './planningTestUtils'
import { usePlanning, type CardBirth } from './usePlanning'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('usePlanning — cards nascidos (criados por fora)', () => {
  const wrapper = ({ children }: { children: ReactNode }) => <UiProvider>{children}</UiProvider>

  it('card novo que chega pela recarga do Manager vira uma leva; o que o usuário grava na tela não', async () => {
    const mock = mockPlanningApi()
    const { result } = renderHook(() => usePlanning(CWD, SLUG), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.born).toBeNull()

    // O usuário cria um card pela tela: já está no estado quando a recarga chega.
    await act(async () => {
      await result.current.saveCard(makeCard('meu', { tipo: 'nota' }), 0)
    })
    mock.setPlan(makePlan({ cards: [...makePlan().cards, makeCard('meu', { tipo: 'nota' })] }))
    await act(async () => mock.emitChanged({ projectCwd: CWD, slug: SLUG }))
    expect(result.current.born).toBeNull()

    // O Manager cria dois: eles formam a leva, com o tipo de cada um.
    mock.setPlan(
      makePlan({
        cards: [
          ...makePlan().cards,
          makeCard('meu', { tipo: 'nota' }),
          makeCard('risco-1', { tipo: 'ambiguidade' }),
          makeCard('dec-2', { tipo: 'decisao' })
        ]
      })
    )
    await act(async () => mock.emitChanged({ projectCwd: CWD, slug: SLUG }))
    await waitFor(() => expect(result.current.born?.cards.map((c) => c.id)).toEqual(['risco-1', 'dec-2']))
    expect(result.current.born?.cards[0].tipo).toBe('ambiguidade')
    const firstSeq = result.current.born!.seq

    // Recarga sem card novo não inventa leva.
    await act(async () => mock.emitChanged({ projectCwd: CWD, slug: SLUG }))
    expect(result.current.born?.seq).toBe(firstSeq)
  })
})

describe('CardBirthFlow', () => {
  function rect(r: Partial<DOMRect>): DOMRect {
    return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}), ...r } as DOMRect
  }

  function scene(birth: CardBirth | null, withChat = true) {
    return (
      <div className="pl-main">
        <div data-testid="pl-card-novo" className="pl-card" data-tipo="decisao" />
        {withChat && <section className="pl-chat-float" />}
        <CardBirthFlow birth={birth} />
      </div>
    )
  }

  const BIRTH: CardBirth = { seq: 1, cards: [{ id: 'novo', tipo: 'decisao' }] }

  it('esconde o card no mesmo render, corre o fluxo do chat até ele e o faz chegar', () => {
    vi.useFakeTimers()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('pl-card')) return rect({ left: 400, top: 100, width: 248, height: 120 })
      if (this.classList.contains('pl-chat-float')) return rect({ left: 200, top: 500, width: 600, height: 200 })
      return rect({ left: 0, top: 0, width: 1200, height: 800 })
    })
    const { container } = render(scene(BIRTH))
    const card = container.querySelector<HTMLElement>('.pl-card')!

    // Escondido desde o primeiro render — sem piscar antes do fluxo.
    expect(container.querySelector('style')?.textContent).toContain(`${cardSelector('novo')}:not([data-born])`)

    act(() => void vi.advanceTimersByTime(1))
    const stream = container.querySelector('svg.pl-birth-stream') as SVGElement
    expect(stream).toBeTruthy()
    // Da borda de cima do chat (centro) ao centro do card, na cor do tipo.
    expect(stream.querySelector('path')?.getAttribute('d')).toBe(flowPath(500, 500, 524, 160))
    expect(stream.style.getPropertyValue('--pl-flow')).toContain('--pl-decisao')
    expect(card.dataset.born).toBeUndefined()

    act(() => void vi.advanceTimersByTime(FLOW_MS))
    expect(card.dataset.born).toBe('arrive')
    expect(container.querySelector('style')).toBeNull()

    act(() => void vi.advanceTimersByTime(ARRIVE_MS))
    expect(card.dataset.born).toBeUndefined()
    expect(container.querySelector('svg.pl-birth-stream')).toBeNull()
  })

  it('sem chat na tela, o card chega sem fluxo; vários cards saem em cascata', () => {
    vi.useFakeTimers()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect({ width: 248, height: 120 }))
    const { container } = render(scene(BIRTH, false))
    act(() => void vi.advanceTimersByTime(1))
    expect(container.querySelector('svg.pl-birth-stream')).toBeNull()
    expect(container.querySelector<HTMLElement>('.pl-card')!.dataset.born).toBe('arrive')
    expect(STAGGER_MS).toBeGreaterThan(0)
  })

  it('nó que nunca é medido aparece mesmo assim (não fica escondido para sempre)', () => {
    vi.useFakeTimers()
    const { container } = render(scene(BIRTH)) // jsdom: tudo mede 0
    act(() => void vi.advanceTimersByTime(2_000))
    expect(container.querySelector('style')).toBeNull()
    expect(container.querySelector('svg.pl-birth-stream')).toBeNull()
  })

  it('CSS: a camada não pega clique, fica acima do chat e abaixo do editor; a chegada usa a cor do tipo', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/planning/cardBirth.css'), 'utf8')
    expect(css).toMatch(/\.pl-birth-layer \{[^}]*pointer-events: none;[^}]*\}/)
    expect(css).toMatch(/\.pl-birth-layer \{[^}]*z-index: 9;/)
    expect(css).toMatch(/\.pl-card\[data-born='arrive'\] \{[^}]*animation: pl-card-born/)
    expect(css).toMatch(/var\(--pl-tipo\)/)
    expect(css).toMatch(/prefers-reduced-motion: reduce/)
  })
})
