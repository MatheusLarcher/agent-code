import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { UIMessage } from '../../types'
import { useChatFileOpen, type ChatFileOpenInput } from './chatOpen'
import type { TabItem } from './parts'
import { normalizePath } from './pathGuard'

const CWD = 'C:\\proj\\loja'
const P = (rel: string): string => `${CWD}\\${rel}`
const item = (path: string): TabItem => ({ key: normalizePath(path), path, name: path.split('\\').pop()!, status: null, typing: false })
const card = (name: string, input: Record<string, unknown>): Extract<UIMessage, { kind: 'tool-use' }> => ({ kind: 'tool-use', id: 'x', name, input, parentToolUseId: null })

function setup(over: Partial<ChatFileOpenInput> = {}) {
  const code = { changedItems: [item(P('src\\a.ts')), item(P('web\\pagina.html')), item('D:\\fora\\tela.html')], reads: [item(P('src\\b.ts'))], open: vi.fn(), onBrowse: vi.fn() }
  const flash = vi.fn()
  const toast = vi.fn()
  const page = vi.fn()
  const hook = renderHook((p: ChatFileOpenInput) => useChatFileOpen(p), { initialProps: { code, cwd: CWD, flash, toast, page, ...over } })
  return { code, flash, toast, page, hook, open: (m: ReturnType<typeof card>) => hook.result.current.open(m) }
}

describe('useChatFileOpen: o cartão de arquivo do Chat abre no editor', () => {
  it('alterado no turno: a aba dele (o diff) e o trecho pisca; só lido: a aba de prévia, sem piscar', () => {
    const s = setup()
    s.open(card('Edit', { file_path: P('src\\a.ts'), old_string: 'a', new_string: 'b' }))
    expect(s.code.open).toHaveBeenLastCalledWith(normalizePath(P('src\\a.ts')))
    expect(s.flash).toHaveBeenCalledWith(normalizePath(P('src\\a.ts')))
    s.open(card('Read', { file_path: P('src\\b.ts') }))
    expect(s.code.open).toHaveBeenLastCalledWith(normalizePath(P('src\\b.ts')))
    expect(s.flash).toHaveBeenCalledTimes(1)
    // O Read de um arquivo que também foi alterado leva ao diff (e pisca).
    s.open(card('Read', { file_path: P('SRC\\A.TS') }))
    expect(s.code.open).toHaveBeenLastCalledWith(normalizePath(P('src\\a.ts')))
    expect(s.flash).toHaveBeenCalledTimes(2)
  })

  it('outro arquivo do projeto (a edição que falhou, o que passou do limite de abas): inteiro e somente leitura', () => {
    const s = setup()
    s.open(card('MultiEdit', { file_path: P('src\\c.ts'), edits: [] }))
    expect(s.code.onBrowse).toHaveBeenCalledWith(P('src\\c.ts'))
    expect(s.code.open).not.toHaveBeenCalled()
    s.open(card('NotebookEdit', { notebook_path: P('nb\\x.ipynb'), new_source: 'x' }))
    expect(s.code.onBrowse).toHaveBeenLastCalledWith(P('nb\\x.ipynb'))
  })

  it('fora do projeto ou com nome sensível, sem ter vindo no turno: um aviso na tela, nada abre', () => {
    const s = setup()
    s.open(card('Write', { file_path: 'D:\\outro\\a.ts', content: 'x' }))
    expect(s.toast).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'open-file', kind: 'warn', app: 'code', title: 'Não dá para abrir a.ts', body: 'Fica fora da pasta do projeto e não veio no turno.' }))
    s.open(card('Edit', { file_path: P('.env'), old_string: 'A=1', new_string: 'A=2' }))
    expect(s.toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Não dá para abrir .env', body: 'Arquivo sensível: o monitor não mostra o conteúdo dele.' }))
    expect(s.code.open).not.toHaveBeenCalled()
    expect(s.code.onBrowse).not.toHaveBeenCalled()
  })

  it('cartão que não é de arquivo (Bash) não faz nada; o objeto é o mesmo entre renders e usa o estado de agora', () => {
    const s = setup()
    const first = s.hook.result.current
    s.open(card('Bash', { command: 'npm test' }))
    expect([s.code.open.mock.calls.length, s.code.onBrowse.mock.calls.length, s.toast.mock.calls.length]).toEqual([0, 0, 0])
    const open2 = vi.fn()
    s.hook.rerender({ code: { ...s.code, changedItems: [], reads: [item(P('src\\a.ts'))], open: open2 }, cwd: CWD, flash: s.flash, toast: s.toast, page: s.page })
    expect(s.hook.result.current).toBe(first)
    s.open(card('Edit', { file_path: P('src\\a.ts'), old_string: 'a', new_string: 'b' }))
    expect(open2).toHaveBeenCalledWith(normalizePath(P('src\\a.ts')))
    expect(s.flash).not.toHaveBeenCalled()
  })

  it('o Write/Edit de um .html do Agent abre o código e a Prévia à vista (sem piscar); o Read e o HTML gerado (dist) só o código', () => {
    const s = setup()
    s.open(card('Write', { file_path: P('web\\pagina.html'), content: '<h1>' }))
    expect(s.code.open).toHaveBeenLastCalledWith(normalizePath(P('web\\pagina.html')))
    expect(s.page).toHaveBeenLastCalledWith(P('web\\pagina.html'))
    expect(s.flash).not.toHaveBeenCalled()
    // Não alterado no turno (a edição de antes): o arquivo inteiro e a Prévia.
    s.open(card('Edit', { file_path: P('web\\outra.html'), old_string: 'a', new_string: 'b' }))
    expect(s.code.onBrowse).toHaveBeenLastCalledWith(P('web\\outra.html'))
    expect(s.page).toHaveBeenLastCalledWith(P('web\\outra.html'))
    s.open(card('Read', { file_path: P('web\\pagina.html') }))
    s.open(card('Write', { file_path: P('dist\\index.html'), content: '<h1>' }))
    expect(s.page).toHaveBeenCalledTimes(2)
    expect(s.code.onBrowse).toHaveBeenLastCalledWith(P('dist\\index.html'))
  })

  it('o .html alterado fora da pasta do projeto: o código (o diff) abre e pisca; a Prévia não, com o aviso', () => {
    const s = setup()
    s.open(card('Write', { file_path: 'D:\\fora\\tela.html', content: '<h1>' }))
    expect(s.code.open).toHaveBeenLastCalledWith(normalizePath('D:\\fora\\tela.html'))
    expect(s.flash).toHaveBeenCalledTimes(1)
    expect(s.page).not.toHaveBeenCalled()
    expect(s.toast).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'open-file', kind: 'warn', title: 'Sem prévia de tela.html', body: 'A prévia só abre o HTML de dentro da pasta do projeto.' }))
  })
})
