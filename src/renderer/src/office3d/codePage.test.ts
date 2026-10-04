import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from '../types'
import type { ToolUseMessage } from './chatPage'
import { CODE_LINES, codePageFrom } from './codePage'
import { paintCode, tokenize } from './codePaint'
import { createMonitorTexture, MON_H, MON_W } from './monitorTexture'

afterEach(() => vi.restoreAllMocks())

const P = 'C:\\proj\\loja\\src\\'
let seq = 0
const user = (): UIMessage => ({ kind: 'user', id: `u${seq++}`, text: 'pedido' })
const tool = (name: string, input: unknown, result?: string): ToolUseMessage => ({
  kind: 'tool-use', id: `t${seq++}`, name, input, parentToolUseId: null,
  ...(result === undefined ? {} : { result: { isError: false, text: result } })
})

function fakeCtx(): { ctx: CanvasRenderingContext2D; texts: Array<{ text: string; fill: string }> } {
  const texts: Array<{ text: string; fill: string }> = []
  const noop = (): void => {}
  const ctx = {
    fillStyle: '', font: '', textBaseline: '', textAlign: '',
    measureText: (t: string) => ({ width: t.length * 6 }),
    fillText(text: string) {
      texts.push({ text, fill: String(this.fillStyle) })
    },
    fillRect: noop, beginPath: noop, rect: noop, clip: noop, save: noop, restore: noop, setTransform: noop
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts }
}

describe('codePageFrom: o VS Code do monitor', () => {
  it('arquivos escritos (o mais recente ativo) e o texto da última edição dele', () => {
    const page = codePageFrom([
      user(),
      tool('Write', { file_path: P + 'a.ts', content: 'export const a = 1' }, 'File created successfully at: x'),
      tool('Read', { file_path: P + 'z.ts' }, 'x'),
      tool('Edit', { file_path: P + 'b.ts', old_string: 'x', new_string: 'const y = 2\nreturn y' })
    ])
    expect(page.files).toEqual([{ name: 'b.ts', status: 'M' }, { name: 'a.ts', status: 'U' }])
    expect(page.code).toEqual(['const y = 2', 'return y'])
    expect(page.pending).toBe(true)
  })

  it(`no máximo ${CODE_LINES} linhas; sem escrita, editor vazio`, () => {
    const long = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n')
    expect(codePageFrom([user(), tool('Write', { file_path: P + 'c.ts', content: long }, 'ok')]).code).toHaveLength(CODE_LINES)
    expect(codePageFrom([user(), tool('Bash', { command: 'ls' }, 'ok')])).toEqual({ files: [], code: [], firstLine: 1, pending: false })
  })
})

describe('paintCode', () => {
  it('título no jeito do VS Code, explorador com U/M, código colorido', () => {
    const { ctx, texts } = fakeCtx()
    paintCode(ctx, { files: [{ name: 'b.ts', status: 'M' }], code: ['const y = 2'], firstLine: 7, pending: false }, 'Carrinho', false, '#3fa', MON_W, MON_H)
    expect(texts.some((t) => t.text.includes('Visual Studio Code') && t.text.includes('Carrinho'))).toBe(true)
    expect(texts.find((t) => t.text === 'M')).toBeTruthy()
    expect(texts.find((t) => t.text === '7')).toBeTruthy()
    expect(texts.find((t) => t.text === 'const')!.fill).not.toBe(texts.find((t) => t.text === '2')!.fill)
  })

  it('tokenize separa palavra-chave, string, número e comentário', () => {
    const kinds = new Map(tokenize("const s = 'x' // fim").map(([t, c]) => [t, c]))
    expect(new Set([kinds.get('const'), kinds.get("'x'"), kinds.get('// fim')]).size).toBe(3)
    expect(tokenize('a(1)').map(([t]) => t).join('')).toBe('a(1)')
  })

  it('a textura desenha o VS Code quando a página traz `code`', () => {
    const { ctx, texts } = fakeCtx()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx)
    const m = createMonitorTexture()
    m.draw({ title: 'T', lines: [], busy: true, code: { files: [], code: [], firstLine: 1, pending: false } }, '#fff')
    expect(texts.some((t) => t.text.includes('Visual Studio Code'))).toBe(true)
    m.texture.dispose()
  })
})
