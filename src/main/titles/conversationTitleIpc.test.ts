// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { Channels } from '../../shared/ipc'
import { TITLE_INPUT_MAX_CHARS } from './conversationTitle'
import { registerConversationTitleIpc, type TitleIpcListener } from './conversationTitleIpc'

function setup(suggest: (text: string) => Promise<string | null>) {
  const handlers = new Map<string, TitleIpcListener>()
  const spy = vi.fn(suggest)
  registerConversationTitleIpc({ handle: (channel, listener) => handlers.set(channel, listener), suggest: spy })
  const call = (payload: unknown): Promise<unknown> =>
    Promise.resolve(handlers.get(Channels.conversationSuggestTitle)!(null, payload))
  return { handlers, spy, call }
}

describe('conversation:suggestTitle', () => {
  it('registra o canal e devolve { ok: true, title }', async () => {
    const { handlers, spy, call } = setup(async () => 'Checkout com Pix')
    expect(Channels.conversationSuggestTitle).toBe('conversation:suggestTitle')
    expect(handlers.has(Channels.conversationSuggestTitle)).toBe(true)
    await expect(call({ text: 'monta o checkout' })).resolves.toEqual({ ok: true, title: 'Checkout com Pix' })
    expect(spy).toHaveBeenCalledWith('monta o checkout', undefined)
  })

  it('payload inválido é recusado na fronteira, sem chamar o modelo', async () => {
    const { spy, call } = setup(async () => 'x')
    for (const bad of [undefined, null, 'texto solto', { text: 42 }, { text: 'a', extra: true }, { text: '   ' }]) {
      await expect(call(bad)).resolves.toEqual({ ok: false })
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it('corta o texto em TITLE_INPUT_MAX_CHARS', async () => {
    const { spy, call } = setup(async () => 'Longo')
    await call({ text: 'b'.repeat(TITLE_INPUT_MAX_CHARS + 500) })
    expect(spy.mock.calls[0][0]).toHaveLength(TITLE_INPUT_MAX_CHARS)
  })

  it('sem título ou com exceção → { ok: false }, nunca lança', async () => {
    await expect(setup(async () => null).call({ text: 'oi' })).resolves.toEqual({ ok: false })
    await expect(setup(async () => '').call({ text: 'oi' })).resolves.toEqual({ ok: false })
    await expect(
      setup(async () => {
        throw new Error('boom')
      }).call({ text: 'oi' })
    ).resolves.toEqual({ ok: false })
  })
})
