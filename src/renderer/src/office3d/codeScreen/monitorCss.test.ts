// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * As linhas do editor ganham classes dinâmicas `cm-${tipo}` (EditorPane: ctx, add,
 * del, gap, hunk, current). Uma regra com o mesmo nome em outro CSS da tela pega
 * as linhas também — `.cm-ctx` no app Contexto já empilhou o código embaixo da
 * calha e o editor ficou com as linhas vazias.
 */
const ROW_CLASSES = ['cm-ctx', 'cm-add', 'cm-del', 'cm-gap', 'cm-hunk', 'cm-current']
const SHEETS = ['taskbar.css', 'contextApp.css']

describe('CSS da tela do monitor', () => {
  it.each(SHEETS)('%s não usa as classes das linhas do editor', (file) => {
    const css = readFileSync(join(__dirname, file), 'utf8')
    for (const name of ROW_CLASSES) expect(css).not.toMatch(new RegExp(`\\.${name}(?![a-z0-9-])`))
  })
})
