import { describe, expect, it } from 'vitest'
import type { UIMessage } from '../types'
import { HITS_MAX, lastActionPage, TERM_LINES } from './actionPage'
import type { ToolUseMessage } from './chatPage'

const P = 'C:\\proj\\loja\\src\\'
let seq = 0
const user = (): UIMessage => ({ kind: 'user', id: `u${seq++}`, text: 'pedido' })
const tool = (name: string, input: unknown, result?: string, isError = false, parent: string | null = null): ToolUseMessage => ({
  kind: 'tool-use', id: `t${seq++}`, name, input, parentToolUseId: parent,
  ...(result === undefined ? {} : { result: { isError, text: result } })
})

describe('lastActionPage: a página da última ação', () => {
  it('sem ação, ou com a última sendo uma escrita: null (a tela fica no código)', () => {
    expect(lastActionPage([])).toBeNull()
    expect(lastActionPage([user()])).toBeNull()
    expect(lastActionPage([user(), tool('Bash', { command: 'ls' }, 'a'), tool('Edit', { file_path: P + 'a.ts', old_string: 'a', new_string: 'b' })])).toBeNull()
    expect(lastActionPage([user(), tool('Read', { file_path: P + 'a.ts' }, '1→x'), tool('Write', { file_path: P + 'b.ts', content: 'x' }, 'ok')])).toBeNull()
  })

  it('Read: o trecho lido (do resultado), numerado, com o resumo de leitura', () => {
    const whole = lastActionPage([user(), tool('Read', { file_path: P + 'total.ts' }, '     1→export const a = 1\n     2→\tif (a) {\n     3→}')])
    expect(whole).toEqual({
      kind: 'read', file: 'total.ts', lines: ['export const a = 1', '  if (a) {', '}'], firstLine: 1,
      summary: 'Somente leitura · leu o arquivo inteiro (3 linhas)', pending: false, error: false
    })
    const part = lastActionPage([user(), tool('Read', { file_path: P + 'b.ts', offset: 10, limit: 2 }, '10→x\n11→y')])
    expect(part).toMatchObject({ kind: 'read', lines: ['x', 'y'], firstLine: 10, summary: 'Somente leitura · leu as linhas 10–11' })
    // Em curso: sem trecho ainda; a linha inicial é a pedida.
    expect(lastActionPage([user(), tool('Read', { file_path: P + 'c.ts', offset: 40 })])).toMatchObject({ kind: 'read', file: 'c.ts', lines: [], firstLine: 40, summary: 'Lendo…', pending: true })
    // Erro: marcado, sem trecho.
    expect(lastActionPage([user(), tool('Read', { file_path: P + 'd.ts' }, 'File does not exist.', true)])).toMatchObject({ kind: 'read', lines: [], error: true, summary: 'Erro ao ler · File does not exist.' })
  })

  it('Read com resultado longo (cortado pelo main): o começo ainda aparece', () => {
    const text = Array.from({ length: 400 }, (_, i) => `${String(i + 1).padStart(6)}→linha ${i + 1} ${'x'.repeat(20)}`).join('\n')
    const page = lastActionPage([user(), tool('Read', { file_path: P + 'grande.ts' }, text)])
    expect(page).toMatchObject({ kind: 'read', firstLine: 1 })
    expect(page?.kind === 'read' && page.lines[0]).toContain('linha 1 ')
  })

  it('Bash/PowerShell: o comando e o fim da saída, sem ANSI', () => {
    const out = Array.from({ length: 15 }, (_, i) => `\u001b[32mok ${i}\u001b[0m`).join('\n')
    const page = lastActionPage([user(), tool('Bash', { command: 'npm test -- --run\necho fim' }, out)])
    expect(page).toMatchObject({ kind: 'terminal', shell: 'bash', command: 'npm test -- --run', more: 15 - TERM_LINES, pending: false, error: false })
    expect(page?.kind === 'terminal' && page.output).toEqual(Array.from({ length: TERM_LINES }, (_, i) => `ok ${i + 15 - TERM_LINES}`))
    expect(lastActionPage([user(), tool('PowerShell', { command: 'Get-ChildItem' })])).toMatchObject({ kind: 'terminal', shell: 'pwsh', output: [], pending: true })
    expect(lastActionPage([user(), tool('Bash', { command: 'false' }, 'boom', true)])).toMatchObject({ kind: 'terminal', error: true, output: ['boom'] })
  })

  it('Grep/Glob: o padrão, onde e as primeiras ocorrências', () => {
    const grep = lastActionPage([user(), tool('Grep', { pattern: 'total\\(', path: P }, `${P}cart\\total.ts:12:export function total(\n${P}a.ts:3-  total()`)])
    expect(grep).toEqual({
      kind: 'search', tool: 'Grep', pattern: 'total\\(', where: 'loja/src', total: 2, pending: false, error: false,
      hits: [{ file: 'cart/total.ts', line: 12, text: 'export function total(' }, { file: 'src/a.ts', line: 3, text: 'total()' }]
    })
    const files = lastActionPage([user(), tool('Grep', { pattern: 'x' }, `Found 3 files\n${P}a.ts\n${P}b.ts\n${P}c.ts`)])
    expect(files).toMatchObject({ total: 3, hits: [{ file: 'src/a.ts', line: null }, { file: 'src/b.ts' }, { file: 'src/c.ts' }] })
    const many = Array.from({ length: 30 }, (_, i) => `/r/p/f${i}.ts`).join('\n')
    const glob = lastActionPage([user(), tool('Glob', { pattern: '**/*.ts' }, many)])
    expect(glob).toMatchObject({ kind: 'search', tool: 'Glob', where: '', total: 30 })
    expect(glob?.kind === 'search' && glob.hits.length).toBe(HITS_MAX)
    expect(lastActionPage([user(), tool('Glob', { pattern: '*.zz' }, 'No files found')])).toMatchObject({ hits: [], total: 0 })
  })

  it('Web/navegador: o host e o que faz; clique usa o endereço da última navegação', () => {
    const nav = tool('mcp__browser__browser_navigate', { url: 'https://loja.exemplo.com/carrinho' }, 'ok')
    expect(lastActionPage([user(), nav])).toMatchObject({ kind: 'web', host: 'loja.exemplo.com', url: 'https://loja.exemplo.com/carrinho', doing: 'Abrindo', what: '' })
    expect(lastActionPage([user(), nav, tool('mcp__browser__browser_click', { selector: '#comprar' })])).toMatchObject({
      kind: 'web', host: 'loja.exemplo.com', doing: 'Clicando', what: '#comprar', pending: true
    })
    expect(lastActionPage([user(), tool('mcp__chrome__chrome_screenshot', {}, 'img')])).toMatchObject({ kind: 'web', host: '', doing: 'Tirando print' })
    expect(lastActionPage([user(), tool('WebSearch', { query: 'three canvas texture' }, 'r')])).toMatchObject({ kind: 'web', host: 'Pesquisa na web', doing: 'Pesquisando', what: 'three canvas texture' })
    expect(lastActionPage([user(), tool('WebFetch', { url: 'https://docs.x.dev/a', prompt: 'resuma' })])).toMatchObject({ kind: 'web', host: 'docs.x.dev', doing: 'Baixando a página' })
  })

  it('Task/Agent: delegou para o subagente', () => {
    expect(lastActionPage([user(), tool('Agent', { subagent_type: 'Explore', description: 'achar o checkout' })])).toEqual({ kind: 'delegate', who: 'Explore', what: 'achar o checkout', pending: true, error: false })
    expect(lastActionPage([user(), tool('Task', { prompt: 'faça\n  isto' }, 'feito')])).toMatchObject({ kind: 'delegate', who: 'subagente', what: 'faça isto', pending: false })
  })

  it('ferramenta sem tela própria (TodoWrite, memória) e a trilha do subagente não trocam a ação', () => {
    const bash = tool('Bash', { command: 'ls' }, 'a')
    const sub = tool('Read', { file_path: P + 'x.ts' }, '1→x', false, bash.id)
    expect(lastActionPage([user(), bash, tool('TodoWrite', { todos: [] }, 'ok'), sub, tool('mcp__memory__memory_list', {}, '[]')])).toMatchObject({ kind: 'terminal', command: 'ls' })
  })
})
