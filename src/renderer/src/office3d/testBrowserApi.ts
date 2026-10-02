// Fixture dos testes do projetor (não é usado pelo app): o pedaço do window.api
// com os quadros e o estado do navegador, com os ouvintes contados.
import type { BrowserFrame, BrowserState } from '@shared/ipc'
import type { BrowserFeedApi } from './browserFrames'

export interface FakeBrowserApi extends BrowserFeedApi {
  frame(f: BrowserFrame): void
  state(s: Partial<BrowserState>): void
  /** Ouvintes ligados agora (quadro + estado). */
  listeners(): number
}

export function fakeBrowserApi(): FakeBrowserApi {
  const frames = new Set<(f: BrowserFrame) => void>()
  const states = new Set<(s: BrowserState) => void>()
  return {
    onBrowserFrame(cb) {
      frames.add(cb)
      return () => void frames.delete(cb)
    },
    onBrowserState(cb) {
      states.add(cb)
      return () => void states.delete(cb)
    },
    frame: (f) => frames.forEach((cb) => cb(f)),
    state: (s) => states.forEach((cb) => cb({ url: '', title: '', loading: false, canGoBack: false, canGoForward: false, launched: true, tabs: [], ...s })),
    listeners: () => frames.size + states.size
  }
}

export const jpegFrame = (data = 'AAAA'): BrowserFrame => ({ data, width: 1280, height: 720, mime: 'image/jpeg' })
