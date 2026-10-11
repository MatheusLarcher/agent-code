import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { watchRendererGone, type RendererEvents } from './rendererLifecycle'

function make() {
  const wc = new EventEmitter()
  const onGone = vi.fn()
  watchRendererGone(wc as unknown as RendererEvents, onGone)
  return { wc, onGone }
}

describe('watchRendererGone', () => {
  it('F5 / navegação do frame principal: a tela sumiu', () => {
    const { wc, onGone } = make()
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(onGone).toHaveBeenCalledTimes(1)
  })

  it('iframe inserido (prévia de HTML, srcdoc) não conta como recarga', () => {
    const { wc, onGone } = make()
    wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    wc.emit('did-start-loading')
    expect(onGone).not.toHaveBeenCalled()
  })

  it('history.pushState (mesmo documento) não conta como recarga', () => {
    const { wc, onGone } = make()
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(onGone).not.toHaveBeenCalled()
  })

  it('processo do renderer morreu: a tela sumiu', () => {
    const { wc, onGone } = make()
    wc.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(onGone).toHaveBeenCalledTimes(1)
  })
})
