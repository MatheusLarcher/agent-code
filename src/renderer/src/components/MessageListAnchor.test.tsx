import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { UIMessage } from '../types'
import { UiProvider } from '../ui/UiProvider'
import { MessageList } from './MessageList'
import { scrollTopToKeepEnd } from './MessageListAnchor'

describe('scrollTopToKeepEnd — a decisão pura', () => {
  it('quem estava no fim volta ao fim quando a caixa encolhe', () => {
    // Caixa de 400 → 300px (o rodapé cresceu 100px); o fim agora é 1700.
    expect(scrollTopToKeepEnd({ scrollTop: 1600, scrollHeight: 2000, clientHeight: 300 }, true)).toBe(1700)
  })

  it('quem tinha rolado para cima fica onde estava', () => {
    expect(scrollTopToKeepEnd({ scrollTop: 900, scrollHeight: 2000, clientHeight: 300 }, false)).toBeNull()
  })

  it('já no fim (ou com diferença sub-pixel), não mexe', () => {
    expect(scrollTopToKeepEnd({ scrollTop: 1700, scrollHeight: 2000, clientHeight: 300 }, true)).toBeNull()
    expect(scrollTopToKeepEnd({ scrollTop: 1699.5, scrollHeight: 2000, clientHeight: 300 }, true)).toBeNull()
  })

  it('conteúdo menor que a caixa: o fim é o topo', () => {
    expect(scrollTopToKeepEnd({ scrollTop: 40, scrollHeight: 200, clientHeight: 300 }, true)).toBe(0)
  })
})

// jsdom não tem ResizeObserver nem layout: o observador é um dublê que o teste
// dispara, e as medidas da caixa são definidas à mão.
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  target: Element | null = null
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }
  observe(el: Element): void {
    this.target = el
  }
  unobserve(): void {}
  disconnect(): void {
    this.target = null
  }
  fire(): void {
    this.callback([], this as unknown as ResizeObserver)
  }
}

beforeEach(() => {
  FakeResizeObserver.instances = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const tts = { speakingId: null, onToggleSpeak: (): void => {} }
const messages: UIMessage[] = Array.from({ length: 12 }, (_, i) => ({ kind: 'user', id: `u${i}`, text: `Mensagem ${i}` }))

function setBox(el: HTMLElement, box: { scrollTop?: number; clientHeight: number }): void {
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, value: 2_000 },
    clientHeight: { configurable: true, value: box.clientHeight },
    ...(box.scrollTop === undefined ? {} : { scrollTop: { configurable: true, writable: true, value: box.scrollTop } })
  })
}

function mountList(): { list: HTMLElement; observer: FakeResizeObserver } {
  const view = render(
    <UiProvider>
      <MessageList messages={messages} busy={false} tts={tts} onRetry={() => {}} />
    </UiProvider>
  )
  const list = view.container.querySelector<HTMLElement>('.message-list')!
  const observer = FakeResizeObserver.instances.find((o) => o.target === list)!
  return { list, observer }
}

describe('MessageList — âncora no fim quando o rodapé muda de altura', () => {
  it('observa a própria caixa de rolagem', () => {
    const { observer } = mountList()
    expect(observer).toBeTruthy()
  })

  it('usuário no fim: a lista encolhe e volta ao fim (a última mensagem não fica cortada)', () => {
    const { list, observer } = mountList()
    setBox(list, { scrollTop: 1_600, clientHeight: 400 })
    fireEvent.scroll(list) // estava no fim (0px do fim)

    setBox(list, { clientHeight: 300 }) // o composer ganhou 100px
    observer.fire()

    expect(list.scrollTop).toBe(1_700)
  })

  it('usuário lendo o histórico: a lista encolhe e ele fica onde estava', () => {
    const { list, observer } = mountList()
    setBox(list, { scrollTop: 600, clientHeight: 400 })
    fireEvent.scroll(list) // 1000px acima do fim

    setBox(list, { clientHeight: 300 })
    observer.fire()

    expect(list.scrollTop).toBe(600)
  })

  it('para de observar ao desmontar', () => {
    const { observer } = mountList()
    cleanup()
    expect(observer.target).toBeNull()
  })
})
