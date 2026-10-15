/**
 * O loading do agente (ChatLoader) e a linha ao vivo (ChatLive): o modo
 * compactar, a pausa fora da tela/janela escondida e as regras do CSS (só
 * transform/opacity, nada de box-shadow animado, parado com reduced-motion).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { ChatLive } from './ChatLive'
import { ChatLoader } from './ChatLoader'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ChatLoader', () => {
  it('núcleo + três pontos em órbita, decorativo (aria-hidden), sem emoji nem glifo', () => {
    const { container } = render(<ChatLoader />)
    const el = container.querySelector('.chat-live-loader')!
    expect(el.getAttribute('aria-hidden')).toBe('true')
    expect(el.classList.contains('compacting')).toBe(false)
    expect(el.querySelector('.cl-core')).toBeTruthy()
    expect(el.querySelectorAll('.cl-orbit > span')).toHaveLength(3)
    expect(el.textContent).toBe('')
  })

  it('compactando: a classe que troca a animação para "espremer"', () => {
    const { container } = render(<ChatLoader compacting className="x" />)
    expect(container.querySelector('.chat-live-loader.compacting.x')).toBeTruthy()
  })

  it('pausa fora da tela (IntersectionObserver) e com a janela escondida', () => {
    let notify: (entries: Array<{ isIntersecting: boolean }>) => void = () => {}
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: typeof notify) {
          notify = cb
        }
        observe(): void {}
        disconnect(): void {}
      }
    )
    const { container } = render(<ChatLoader />)
    const el = (): Element => container.querySelector('.chat-live-loader')!
    expect(el().hasAttribute('data-paused')).toBe(false)
    act(() => notify([{ isIntersecting: false }]))
    expect(el().hasAttribute('data-paused')).toBe(true)
    act(() => notify([{ isIntersecting: true }]))
    expect(el().hasAttribute('data-paused')).toBe(false)

    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => void document.dispatchEvent(new Event('visibilitychange')))
    expect(el().hasAttribute('data-paused')).toBe(true)
    vis.mockReturnValue('visible')
    act(() => void document.dispatchEvent(new Event('visibilitychange')))
    expect(el().hasAttribute('data-paused')).toBe(false)
  })

  it('CSS: anima só transform/opacity, pausa com [data-paused] e para com prefers-reduced-motion', () => {
    // Sem os comentários (o do topo cita o box-shadow para dizer que não há).
    const css = readFileSync(resolve(__dirname, 'chatLoader.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const frames = [...css.matchAll(/@keyframes\s+[\w-]+\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1])
    expect(frames.length).toBeGreaterThanOrEqual(4)
    for (const body of frames) {
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1])
      expect(props.every((p) => p === 'transform' || p === 'opacity')).toBe(true)
    }
    expect(css).not.toMatch(/box-shadow/)
    expect(css).toMatch(/\[data-paused\][\s\S]*animation-play-state:\s*paused/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation:\s*none/)
  })
})

describe('ChatLive', () => {
  const msgs = [{ kind: 'user', id: 'u1', text: 'oi', ts: Date.now() - 5000 }]

  it('trabalhando: o loading normal e o "agora"', () => {
    const { container } = render(<ChatLive messages={msgs} />)
    const live = container.querySelector('.chat-live')!
    expect(live.classList.contains('compacting')).toBe(false)
    expect(live.querySelector('.chat-live-text')?.textContent).toBe('Pensando…')
    expect(live.querySelector('.chat-live-loader:not(.compacting)')).toBeTruthy()
  })

  it('compactando: "Compactando a conversa…" e o relógio contando desde o início da compactação', () => {
    const { container } = render(<ChatLive messages={msgs} compactingSince={Date.now() - 12_000} />)
    const live = container.querySelector('.chat-live.compacting')!
    expect(live.getAttribute('aria-label')).toBe('Compactando a conversa')
    expect(live.querySelector('.chat-live-text')?.textContent).toBe('Compactando a conversa…')
    expect(live.querySelector('.chat-live-time')?.textContent).toBe('0:12')
    expect(live.querySelector('.chat-live-loader.compacting')).toBeTruthy()
  })
})
