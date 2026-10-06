// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TOAST_EXIT_MS } from './useMonitorToasts'

/**
 * As linhas do editor ganham classes dinâmicas `cm-${tipo}` (EditorPane: ctx, add,
 * del, gap, hunk, current). Uma regra com o mesmo nome em outro CSS da tela pega
 * as linhas também — `.cm-ctx` no app Contexto já empilhou o código embaixo da
 * calha e o editor ficou com as linhas vazias.
 */
const ROW_CLASSES = ['cm-ctx', 'cm-add', 'cm-del', 'cm-gap', 'cm-hunk', 'cm-current']
const SHEETS = ['taskbar.css', 'contextApp.css', 'chatDock.css']

describe('CSS da tela do monitor', () => {
  it.each(SHEETS)('%s não usa as classes das linhas do editor', (file) => {
    const css = readFileSync(join(__dirname, file), 'utf8')
    for (const name of ROW_CLASSES) expect(css).not.toMatch(new RegExp(`\\.${name}(?![a-z0-9-])`))
  })
})

interface Rule {
  /** O @media/@container em volta ('' fora de um). */
  at: string
  sel: string[]
  body: string
}
/** As regras do CSS, sem comentários (o jsdom não tem layout: o teste lê a folha). @keyframes vem inteiro, com o nome no seletor. */
function rulesOf(css: string): Rule[] {
  const out: Rule[] = []
  const walk = (text: string, at: string): void => {
    for (let i = 0; ; ) {
      const open = text.indexOf('{', i)
      if (open < 0) return
      let end = open + 1
      for (let depth = 1; depth > 0 && end < text.length; end++) depth += text[end] === '{' ? 1 : text[end] === '}' ? -1 : 0
      const head = text.slice(i, open).trim()
      const body = text.slice(open + 1, end - 1)
      if (/^@(media|container|supports)\b/.test(head)) walk(body, head)
      else out.push({ at, sel: head.split(',').map((s) => s.trim()), body })
      i = end
    }
  }
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ''), '')
  return out
}
/** O valor de uma propriedade no corpo da regra (null sem ela). */
const decl = (body: string, prop: string): string | null => new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body)?.[1].trim() ?? null

describe('taskbar.css — os avisos no padrão de toasts do app', () => {
  const rules = rulesOf(readFileSync(join(__dirname, 'taskbar.css'), 'utf8'))
  const find = (sel: string, at = ''): Rule | undefined => rules.find((r) => r.at === at && r.sel.includes(sel))

  it('no canto de cima à direita, logo abaixo da barra de título (o × de fechar fica livre); nada os ancora embaixo', () => {
    const box = find('.cm-toasts')?.body ?? ''
    expect([decl(box, 'top'), decl(box, 'right'), decl(box, 'bottom')]).toEqual(['calc(var(--cm-title-h) + 10px)', '12px', null])
    const below = rules.filter((r) => r.sel.some((s) => /\.cm-toasts(?![\w-])/.test(s)) && decl(r.body, 'bottom') !== null)
    expect(below.map((r) => r.sel.join(', '))).toEqual([])
  })

  it('a saída (`leaving`) apaga deslizando para a direita no tempo de TOAST_EXIT_MS; com movimento reduzido, sem animação (sai pelo tempo)', () => {
    const [name, secs] = (decl(find('.cm-toast.leaving')?.body ?? '', 'animation') ?? '').split(/\s+/)
    expect([name, Math.round(parseFloat(secs) * 1000)]).toEqual(['cm-toast-out', TOAST_EXIT_MS])
    const out = rules.find((r) => r.sel[0] === '@keyframes cm-toast-out')?.body.replace(/\s+/g, ' ') ?? ''
    expect(out).toMatch(/to \{ opacity: 0; transform: translateX\(16px\);? \}/)
    // `.cm-toast.leaving` pesa mais que `.cm-toast`: o bloco do movimento reduzido precisa nomeá-la.
    const calm = rules.filter((r) => r.at === '@media (prefers-reduced-motion: reduce)' && decl(r.body, 'animation') === 'none')
    expect(calm.some((r) => r.sel.includes('.cm-toast.leaving'))).toBe(true)
  })
})
