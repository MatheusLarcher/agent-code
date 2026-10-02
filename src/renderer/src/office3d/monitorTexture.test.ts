import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatPage } from './chatPage'
import { chatPalette, paintChat, wrapText } from './chatPaint'
import { createMonitorTexture, MON_H, MON_W } from './monitorTexture'

afterEach(() => vi.restoreAllMocks())

interface Drawn {
  text: string
  x: number
  y: number
  fill: string
  font: string
  alpha: number
}

/** Contexto 2D de mentira: mede 6 px por caractere e anota cada texto com a cor e a fonte do momento. */
function fakeCtx(): { ctx: CanvasRenderingContext2D; texts: Drawn[]; fills: string[] } {
  const texts: Drawn[] = []
  const fills: string[] = []
  const noop = (): void => {}
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    lineWidth: 1,
    globalAlpha: 1,
    textBaseline: '',
    textAlign: '',
    measureText: (t: string) => ({ width: t.length * 6 }),
    fillText(text: string, x: number, y: number) {
      texts.push({ text, x, y, fill: String(this.fillStyle), font: this.font, alpha: this.globalAlpha })
    },
    fill() {
      fills.push(String(this.fillStyle))
    },
    fillRect: noop, beginPath: noop, moveTo: noop, arcTo: noop, closePath: noop, arc: noop, rect: noop,
    clip: noop, save: noop, restore: noop, stroke: noop, setLineDash: noop, setTransform: noop
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, fills }
}

const TOOL: ChatPage['lines'][number] = { kind: 'tool', verb: 'Edit', detail: 'total.ts', added: 5, removed: 4, badge: { kind: 'run', text: 'running…' }, err: false, skill: false }

describe('paintChat: o chat encolhido no monitor', () => {
  it('a ferramenta é a linha recolhida do ToolCard: ▸, verbo em negrito, detalhe, +N/−M e a pílula nas cores do chat', () => {
    const p = chatPalette()
    const { ctx, texts } = fakeCtx()
    paintChat(ctx, { title: 'Carrinho', lines: [TOOL], busy: true }, '#3fa', MON_W, MON_H)
    const at = (t: string): Drawn => texts.find((d) => d.text === t)!
    expect(at('▸').fill).toBe(p.muted)
    expect(at('Edit').fill).toBe(p.text)
    expect(at('Edit').font).toMatch(/^700 /)
    expect(at('total.ts').fill).toBe(p.muted)
    expect(at('+5').fill).toBe(p.ok)
    expect(at('−4').fill).toBe(p.err)
    expect(at('running…').fill).toBe(p.accent)
    // Na ordem do cartão, da esquerda para a direita.
    expect(['▸', 'Edit', 'total.ts', '+5', '−4', 'running…'].map((t) => at(t).x)).toEqual([...['▸', 'Edit', 'total.ts', '+5', '−4', 'running…'].map((t) => at(t).x)].sort((a, b) => a - b))
    expect(at('Carrinho').y).toBeLessThan(at('Edit').y)
  })

  it('pedido em balão de destaque com texto escuro, narração apagada em itálico, resposta no balão escuro; o mais novo embaixo', () => {
    const p = chatPalette()
    const { ctx, texts, fills } = fakeCtx()
    const page: ChatPage = {
      title: 'T',
      busy: false,
      lines: [
        { kind: 'user', text: 'arruma o carrinho' },
        { kind: 'narration', text: 'vou olhar' },
        { kind: 'tool', verb: 'Bash', detail: 'npm test', added: 0, removed: 0, badge: { kind: 'err', text: 'error' }, err: true, skill: false },
        { kind: 'answer', text: 'pronto' }
      ]
    }
    paintChat(ctx, page, '#fff', MON_W, MON_H)
    const at = (t: string): Drawn => texts.find((d) => d.text === t)!
    expect(at('arruma o carrinho').fill).toBe('#1a1a1a')
    expect(fills).toContain(p.accent)
    expect(at('vou olhar').font).toContain('italic')
    expect(at('vou olhar').alpha).toBeCloseTo(0.78)
    expect(at('pronto').fill).toBe(p.text)
    expect(fills).toContain(p.bg3)
    expect(at('error').fill).toBe(p.err)
    const ys = ['arruma o carrinho', 'vou olhar', 'npm test', 'pronto'].map((t) => at(t).y)
    expect(ys).toEqual([...ys].sort((a, b) => a - b))
    // Sem linhas mudadas, o +N/−M não aparece (como no cartão).
    expect(texts.some((d) => d.text === '+0' || d.text === '−0')).toBe(false)
  })

  it('o que não cabe sai por cima: o mais novo sempre aparece', () => {
    const { ctx, texts } = fakeCtx()
    const lines = Array.from({ length: 30 }, (_, i) => ({ ...TOOL, detail: `f${i}.ts` }))
    paintChat(ctx, { title: 'T', lines, busy: false }, '#fff', MON_W, MON_H)
    expect(texts.some((d) => d.text === 'f29.ts')).toBe(true)
    expect(texts.some((d) => d.text === 'f0.ts')).toBe(false)
  })

  it('wrapText quebra na palavra e corta a última linha com "…"', () => {
    const { ctx } = fakeCtx()
    expect(wrapText(ctx, 'um dois tres quatro cinco seis', 60, 2)).toEqual(['um dois', 'tres quat…'])
    expect(wrapText(ctx, 'curto', 60, 2)).toEqual(['curto'])
  })
})

describe('createMonitorTexture', () => {
  const page: ChatPage = { title: 'Edit', lines: [TOOL], busy: true }

  it('só redesenha quando a página (ou a cor da sala) muda', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const m = createMonitorTexture(4)
    expect(m.draw(page, '#fff')).toBe(true)
    expect(m.draw({ ...page, lines: [...page.lines] }, '#fff')).toBe(false)
    expect(m.draw({ ...page, busy: false }, '#fff')).toBe(true)
    expect(m.draw({ ...page, busy: false }, '#000')).toBe(true)
    expect(m.texture.anisotropy).toBe(4)
    expect(m.scale).toBe(1)
    expect([m.texture.image.width, m.texture.image.height]).toEqual([MON_W, MON_H])
    m.texture.dispose()
  })

  it('LOD médio: canvas em meia resolução, o mesmo desenho em escala', () => {
    const { ctx, texts } = fakeCtx()
    const setTransform = vi.fn()
    ;(ctx as unknown as { setTransform: typeof setTransform }).setTransform = setTransform
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx)
    const m = createMonitorTexture(1, 0.5)
    expect(m.scale).toBe(0.5)
    expect([m.texture.image.width, m.texture.image.height]).toEqual([MON_W / 2, MON_H / 2])
    m.draw(page, '#fff')
    expect(setTransform).toHaveBeenCalledWith(0.5, 0, 0, 0.5, 0, 0)
    expect(texts.some((d) => d.text === 'Edit')).toBe(true)
    m.texture.dispose()
  })
})
