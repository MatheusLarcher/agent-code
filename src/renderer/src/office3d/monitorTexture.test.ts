import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMonitorTexture, MON_H, MON_ROWS, MON_W, screenLines, splitGutter, tokenize } from './monitorTexture'

afterEach(() => vi.restoreAllMocks())

describe('screenLines', () => {
  it('diff: linhas - em vermelho e + em verde, título com ferramenta e arquivo', () => {
    const p = screenLines({ kind: 'diff', tool: 'Edit', path: 'C:\\p\\src\\a.ts', hunks: [{ old: 'a\nb', new: 'c\nd\ne' }] })
    expect(p.title).toBe('Edit')
    expect(p.subtitle).toBe('a.ts')
    expect(p.lines.map((l) => [l.kind, l.text])).toEqual([
      ['del', '- a'],
      ['del', '- b'],
      ['add', '+ c'],
      ['add', '+ d'],
      ['add', '+ e']
    ])
  })

  it('diff longo: o trecho antigo leva no máximo um terço e cabe na tela', () => {
    const old = Array.from({ length: 30 }, (_, i) => `old${i}`).join('\n')
    const neu = Array.from({ length: 30 }, (_, i) => `new${i}`).join('\n')
    const p = screenLines({ kind: 'diff', tool: 'Edit', path: 'a.ts', hunks: [{ old, new: neu }] })
    expect(p.lines).toHaveLength(MON_ROWS)
    expect(p.lines.filter((l) => l.kind === 'del').length).toBeLessThanOrEqual(Math.floor(MON_ROWS / 3))
  })

  it('read separa a numeração na margem', () => {
    const p = screenLines({ kind: 'read', tool: 'Read', path: 'x.py', text: '     1→import os\n     2→print(1)' })
    expect(p.lines[0]).toEqual({ kind: 'code', text: 'import os', gutter: '1' })
  })

  it('bash: comando com $ e o fim da saída', () => {
    const out = Array.from({ length: 40 }, (_, i) => `linha ${i}`).join('\n')
    const p = screenLines({ kind: 'bash', tool: 'Bash', command: 'npm test', output: out })
    expect(p.lines[0]).toEqual({ kind: 'cmd', text: '$ npm test' })
    expect(p.lines).toHaveLength(MON_ROWS)
    expect(p.lines[MON_ROWS - 1].text).toBe('linha 39')
  })

  it('corta linhas compridas e vazio não tem linhas', () => {
    const p = screenLines({ kind: 'write', tool: 'Write', path: 'a.ts', text: 'x'.repeat(200) }, 20)
    expect(p.lines[0].text).toHaveLength(20)
    expect(p.lines[0].text.endsWith('…')).toBe(true)
    expect(screenLines({ kind: 'empty' }).lines).toEqual([])
  })
})

describe('tokenize', () => {
  it('reconhece palavra-chave, string, número e comentário sem perder texto', () => {
    const line = "const n = 42 // conta 'x'"
    const t = tokenize(line)
    expect(t.map((x) => x.text).join('')).toBe(line)
    expect(t.find((x) => x.text === 'const')?.kind).toBe('kw')
    expect(t.find((x) => x.text === '42')?.kind).toBe('num')
    expect(t[t.length - 1]).toEqual({ text: "// conta 'x'", kind: 'com' })
    expect(tokenize('"oi"')).toEqual([{ text: '"oi"', kind: 'str' }])
  })
})

describe('splitGutter', () => {
  it('aceita → e tab; linha comum passa intacta', () => {
    expect(splitGutter('  12→a')).toEqual({ gutter: '12', text: 'a' })
    expect(splitGutter('3\tb')).toEqual({ gutter: '3', text: 'b' })
    expect(splitGutter('sem numero')).toEqual({ text: 'sem numero' })
  })
})

describe('createMonitorTexture', () => {
  it('só redesenha quando a página muda', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const m = createMonitorTexture(4)
    const page = { title: 'Edit', subtitle: 'a.ts', lines: [{ kind: 'add' as const, text: '+ x' }] }
    expect(m.draw(page, '#fff')).toBe(true)
    expect(m.draw({ ...page }, '#fff')).toBe(false)
    expect(m.draw({ ...page, subtitle: 'b.ts' }, '#fff')).toBe(true)
    expect(m.texture.anisotropy).toBe(4)
    expect(m.scale).toBe(1)
    expect([m.texture.image.width, m.texture.image.height]).toEqual([MON_W, MON_H])
    m.texture.dispose()
  })

  it('LOD médio: canvas em meia resolução', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const m = createMonitorTexture(1, 0.5)
    expect(m.scale).toBe(0.5)
    expect([m.texture.image.width, m.texture.image.height]).toEqual([MON_W / 2, MON_H / 2])
    m.texture.dispose()
  })
})
