/**
 * O loading do agente (ChatLoader) e a linha ao vivo (ChatLive): o modo
 * compactar, a pausa fora da tela/janela escondida e as regras do CSS (só
 * transform/opacity, nada de box-shadow animado, parado com reduced-motion).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { liveness } from '../liveness'
import { ChatLive, QUIET_AFTER_MS, sinceText, thinkingDetail } from './ChatLive'
import { ChatLoader } from './ChatLoader'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  liveness.clear('c1')
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
    // Compactando, nada de "último sinal".
    expect(live.querySelector('.chat-live-signal')).toBeNull()
  })
})

describe('ChatLive — o agente está vivo?', () => {
  const T0 = 1_800_000_000_000
  const user = (ago: number) => ({ kind: 'user', id: 'u1', text: 'oi', ts: T0 - ago })
  const tool = (ago: number, result?: unknown) => ({
    kind: 'tool-use',
    id: 't1',
    name: 'Bash',
    input: { command: 'npm test' },
    parentToolUseId: null,
    ts: T0 - ago,
    ...(result === undefined ? {} : { result })
  })
  const think = (text: string, ago: number, final = false) => ({ kind: 'thinking', id: 'th1', text, final, parentToolUseId: null, ts: T0 - ago })
  const text = (sel: string, root: Element): string | null | undefined => root.querySelector(sel)?.textContent
  const live = (): Element => document.querySelector('.chat-live')!

  const freeze = (): void => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  }

  it('sem convId: só o rótulo e o tempo do turno (nada de sinal)', () => {
    freeze()
    render(<ChatLive messages={[user(5000)]} />)
    expect(text('.chat-live-text', live())).toBe('Pensando…')
    expect(live().querySelector('.chat-live-signal')).toBeNull()
    expect(live().querySelector('.chat-live-elapsed')).toBeNull()
    expect(text('.chat-live-time', live())).toBe('0:05')
  })

  it('ferramenta principal rodando: "Rodando os testes…" com "há M:SS" dela, sem "último sinal"; o tempo do turno segue', () => {
    freeze()
    liveness.note('c1', T0 - 1000)
    render(<ChatLive messages={[user(90_000), tool(65_000)]} convId="c1" />)
    expect(text('.chat-live-text', live())).toBe('Rodando os testes…')
    expect(text('.chat-live-elapsed', live())).toBe('há 1:05')
    expect(live().querySelector('.chat-live-signal')).toBeNull()
    expect(text('.chat-live-time', live())).toBe('1:30')
  })

  it('ferramenta concluída, sem raciocínio: "último sinal há Xs" = o maior entre a store e a última mensagem', () => {
    freeze()
    liveness.note('c1', T0 - 12_000)
    render(<ChatLive messages={[user(90_000), tool(40_000, { isError: false, text: 'ok' })]} convId="c1" />)
    expect(text('.chat-live-text', live())).toBe('Pensando…')
    expect(live().querySelector('.chat-live-elapsed')).toBeNull()
    const signal = live().querySelector('.chat-live-signal')!
    expect(signal.textContent).toBe('último sinal há 12 s')
    expect(signal.classList.contains('quiet')).toBe(false)
  })

  it('o sinal da última mensagem vence a store quando é mais novo; passando de 20 s em silêncio, vira "quiet"', () => {
    freeze()
    liveness.note('c1', T0 - 30_000)
    render(<ChatLive messages={[user(90_000), tool(40_000, { isError: false, text: 'ok' }), { kind: 'assistant-text', id: 'a1', text: 'x', ts: T0 - 3000 }]} convId="c1" />)
    expect(text('.chat-live-signal', live())).toBe('último sinal há 3 s')
    act(() => void vi.advanceTimersByTime(QUIET_AFTER_MS))
    const signal = live().querySelector('.chat-live-signal')!
    expect(signal.textContent).toBe('último sinal há 23 s')
    expect(signal.classList.contains('quiet')).toBe(true)
  })

  it('heartbeat com thinkingSince: "Pensando…" com "há M:SS" do bloco aberto e sem "último sinal"', () => {
    freeze()
    liveness.note('c1', T0 - 1000)
    liveness.setThinking('c1', T0 - 5000)
    render(<ChatLive messages={[user(30_000)]} convId="c1" />)
    expect(text('.chat-live-text', live())).toBe('Pensando…')
    expect(text('.chat-live-elapsed', live())).toBe('há 0:05')
    expect(live().querySelector('.chat-live-signal')).toBeNull()
    // O bloco fechou (thinkingSince null) e nada roda: o sinal volta.
    act(() => {
      liveness.setThinking('c1', null)
      vi.advanceTimersByTime(1000)
    })
    expect(live().querySelector('.chat-live-elapsed')).toBeNull()
    expect(text('.chat-live-signal', live())).toBe('último sinal há 2 s')
  })

  it('raciocínio ao vivo no fim do turno: a última linha dele ao lado, cortada em ~90 caracteres', () => {
    freeze()
    liveness.setThinking('c1', T0 - 2000)
    const long = `Primeira linha\n\n${'a'.repeat(120)}`
    render(<ChatLive messages={[user(30_000), think(long, 2000)]} convId="c1" />)
    const detail = text('.chat-live-detail', live())!
    expect(detail.endsWith('…')).toBe(true)
    expect(detail.length).toBe(90)
    expect(detail.startsWith('aaaa')).toBe(true)
    expect(thinkingDetail([user(1), think('x\n  última  \n', 1)])).toBe('última')
    expect(thinkingDetail([user(1), think('', 1)])).toBeNull()
    expect(thinkingDetail([user(1), tool(1)])).toBeNull()
  })

  it('esperando o usuário: o rótulo da espera, sem shimmer (classe waiting), sem sinal nem tempo de atividade', () => {
    freeze()
    liveness.note('c1', T0 - 40_000)
    liveness.setThinking('c1', T0 - 5000)
    render(<ChatLive messages={[user(60_000), tool(10_000)]} convId="c1" waiting="permission" />)
    expect(live().classList.contains('waiting')).toBe(true)
    expect(live().getAttribute('aria-label')).toBe('Agente esperando: Aguardando sua permissão…')
    expect(text('.chat-live-text', live())).toBe('Aguardando sua permissão…')
    expect(live().querySelector('.chat-live-signal')).toBeNull()
    expect(live().querySelector('.chat-live-elapsed')).toBeNull()
    expect(text('.chat-live-time', live())).toBe('1:00')
    cleanup()
    render(<ChatLive messages={[user(60_000)]} convId="c1" waiting="question" />)
    expect(text('.chat-live-text', live())).toBe('Aguardando sua resposta…')
  })

  it('sinceText: segundos abaixo de um minuto, m:ss daí em diante', () => {
    expect(sinceText(0)).toBe('há 0 s')
    expect(sinceText(59_900)).toBe('há 59 s')
    expect(sinceText(60_000)).toBe('há 1:00')
    expect(sinceText(3_725_000)).toBe('há 1:02:05')
  })
})
