import { afterEach, describe, expect, it, vi } from 'vitest'
import { accentHue, createSignTexture, fileUrl, iconSource, initialOf } from './sign'

afterEach(() => vi.restoreAllMocks())

describe('iconSource', () => {
  it('data URL e URLs viram imagem', () => {
    expect(iconSource('data:image/png;base64,AAAA', 'x')).toEqual({ kind: 'image', src: 'data:image/png;base64,AAAA' })
    expect(iconSource('https://a/b.png', 'x')).toEqual({ kind: 'image', src: 'https://a/b.png' })
  })

  it('caminho local vira file:///', () => {
    expect(iconSource('C:\\proj\\icon.png', 'x')).toEqual({ kind: 'image', src: 'file:///C:/proj/icon.png' })
    expect(iconSource('/home/u/icon.svg', 'x')).toEqual({ kind: 'image', src: 'file:///home/u/icon.svg' })
  })

  it('emoji ou glifo curto', () => {
    expect(iconSource('🚀', 'x')).toEqual({ kind: 'glyph', text: '🚀' })
    expect(iconSource('⚙️', 'x')).toEqual({ kind: 'glyph', text: '⚙️' })
  })

  it('sem ícone (ou texto qualquer): inicial do nome', () => {
    expect(iconSource(null, 'agent-code')).toEqual({ kind: 'initial', text: 'A' })
    expect(iconSource('', 'éclair')).toEqual({ kind: 'initial', text: 'É' })
    expect(iconSource('isto não é ícone', '_9lives')).toEqual({ kind: 'initial', text: '9' })
    expect(initialOf('---')).toBe('?')
  })
})

describe('sign helpers', () => {
  it('fileUrl normaliza barras', () => {
    expect(fileUrl('C:\\a\\b c.png')).toBe('file:///C:/a/b c.png')
  })
  it('accentHue é estável e em 0..359', () => {
    expect(accentHue('c:/x')).toBe(accentHue('c:/x'))
    const h = accentHue('c:/y')
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThan(360)
  })

  it('textura em alta resolução, com anisotropia; dispose libera a textura', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const s = createSignTexture('agent-code', null, 'r', 8, () => {})
    expect(s.texture.image.width).toBe(1024)
    expect(s.texture.anisotropy).toBe(8)
    const spy = vi.fn()
    s.texture.addEventListener('dispose', spy)
    s.dispose()
    expect(spy).toHaveBeenCalled()
  })
})
