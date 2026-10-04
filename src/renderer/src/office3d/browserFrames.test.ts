import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserFrames, decodeFrame, LIVE_MS, MAX_CONVS } from './browserFrames'
import { fakeBrowserApi, jpegFrame as jpeg } from './testBrowserApi'

afterEach(() => vi.unstubAllGlobals())

describe('BrowserFrames: o quadro é da conversa ativa na hora em que chega', () => {
  it('guarda o último quadro e o estado de cada conversa; ao vivo só a ativa com quadro recente', () => {
    const api = fakeBrowserApi()
    let active: string | null = 'a'
    let now = 1_000
    const arrived: string[] = []
    const fr = new BrowserFrames(api, () => active, (id) => arrived.push(id), () => now)
    api.frame(jpeg('A1'))
    api.state({ url: 'http://localhost:5173/', title: 'Loja' })
    active = 'b'
    api.frame(jpeg('B1'))
    expect(arrived).toEqual(['a', 'b'])
    expect(fr.frame('a')?.data).toBe('A1')
    expect(fr.frame('b')?.data).toBe('B1')
    expect(fr.state('a')).toEqual({ url: 'http://localhost:5173/', title: 'Loja' })
    expect(fr.state('b')).toBeNull()
    expect(fr.live('b')).toBe(true)
    expect(fr.live('a')).toBe(false) // não é mais a ativa: o quadro guardado é o "último quadro"
    now += LIVE_MS
    expect(fr.live('b')).toBe(false)
    // Sem conversa ativa (demo ou nenhuma), o quadro é ignorado.
    active = null
    api.frame(jpeg('X'))
    expect(arrived).toHaveLength(2)
  })

  it(`no máximo ${MAX_CONVS} conversas: a usada há mais tempo sai`, () => {
    const api = fakeBrowserApi()
    let active = ''
    const fr = new BrowserFrames(api, () => active, () => {})
    for (let i = 0; i <= MAX_CONVS; i++) {
      active = `c${i}`
      api.frame(jpeg(`F${i}`))
    }
    expect(fr.size).toBe(MAX_CONVS)
    expect(fr.frame('c0')).toBeNull()
    expect(fr.frame(`c${MAX_CONVS}`)?.data).toBe(`F${MAX_CONVS}`)
  })

  it('dispose tira os ouvintes de onBrowserFrame e onBrowserState e esquece tudo', () => {
    const api = fakeBrowserApi()
    const fr = new BrowserFrames(api, () => 'a', () => {})
    expect(api.listeners()).toBe(2)
    api.frame(jpeg())
    fr.dispose()
    expect(api.listeners()).toBe(0)
    expect(fr.frame('a')).toBeNull()
    // Sem api (testes, preload antigo): nada liga, nada quebra.
    expect(() => new BrowserFrames(null, () => 'a', () => {}).dispose()).not.toThrow()
  })
})

describe('decodeFrame', () => {
  it('sem createImageBitmap devolve null; com ele, reduz quadros largos', async () => {
    vi.stubGlobal('createImageBitmap', undefined)
    expect(await decodeFrame({ data: 'AAAA', width: 10, height: 10, mime: 'image/png', at: 0, seq: 1 })).toBeNull()
    const create = vi.fn(async () => ({ width: 960, height: 540, close: vi.fn() }) as unknown as ImageBitmap)
    vi.stubGlobal('createImageBitmap', create)
    await decodeFrame({ data: btoa('jpeg'), width: 1920, height: 1080, mime: 'image/jpeg', at: 0, seq: 1 })
    expect(create).toHaveBeenCalledWith(expect.any(Blob), expect.objectContaining({ resizeWidth: 960, resizeHeight: 540 }))
    await decodeFrame({ data: btoa('png'), width: 400, height: 800, mime: 'image/png', at: 0, seq: 1 })
    expect(create).toHaveBeenLastCalledWith(expect.any(Blob))
  })
})
