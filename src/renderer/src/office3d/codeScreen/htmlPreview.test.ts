import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { HtmlWrite } from '../agentHtml'
import { MAX_TABS } from './codeModel'
import { lastWriteOf, PAGE_TAB, useHtmlPreview, withPageTabs } from './htmlPreview'
import type { TabItem } from './parts'
import { normalizePath } from './pathGuard'
import { RELOAD_MS, useThrottled } from './PreviewPane'

const CWD = 'C:\\proj\\loja'
const P = (rel: string): string => `${CWD}\\${rel}`
const tab = (path: string): TabItem => ({ key: normalizePath(path), path, name: path.split('\\').pop()!, status: 'M', typing: false })
const pg = (path: string) => ({ key: normalizePath(path), path, name: path.split('\\').pop()! })

afterEach(() => vi.useRealTimers())

describe('a Prévia do HTML como aba do editor (htmlPreview)', () => {
  it('a aba "Prévia" vem logo depois da aba do código do mesmo arquivo; sem a do código, no fim; sem prévia, a mesma lista', () => {
    const items = [tab(P('a.ts')), tab(P('web\\pagina.html')), tab(P('b.ts'))]
    expect(withPageTabs(items, [])).toBe(items)
    const out = withPageTabs(items, [pg(P('outra.html')), pg(P('web\\pagina.html'))])
    expect(out.map((t) => [t.key.startsWith(PAGE_TAB) ? `Prévia ${t.name}` : t.name, !!t.page])).toEqual([
      ['a.ts', false],
      ['pagina.html', false],
      ['Prévia pagina.html', true],
      ['b.ts', false],
      ['Prévia outra.html', true]
    ])
  })

  it('a recarga: o id da última escrita do arquivo que deu certo (as escritas vêm da mais recente)', () => {
    const w = (id: string, path: string, ok = true): HtmlWrite => ({ id, convId: 'a', key: 'conv:a', path, ok })
    const writes = [w('e3', P('web\\pagina.html'), false), w('w2', P('WEB\\Pagina.html')), w('w1', P('web\\pagina.html')), w('x', P('outra.html'))]
    expect(lastWriteOf(writes, normalizePath(P('web\\pagina.html')))).toBe('w2')
    expect(lastWriteOf(writes, normalizePath(P('nada.html')))).toBeNull()
  })

  it('abrir deixa de seguir (pela aba do código); uma prévia por arquivo, no máximo MAX_TABS; escolher um arquivo ou voltar a seguir sai da prévia', () => {
    const onSelect = vi.fn()
    const onBrowse = vi.fn()
    const hook = renderHook((p: { follow: boolean }) => useHtmlPreview({ follow: p.follow, onSelect, onBrowse }), { initialProps: { follow: false } })
    act(() => hook.result.current.onOpenPage(P('web\\pagina.html')))
    expect(onSelect).toHaveBeenLastCalledWith(normalizePath(P('web\\pagina.html')))
    expect(hook.result.current.active?.name).toBe('pagina.html')
    act(() => hook.result.current.open(P('web\\pagina.html')))
    expect(hook.result.current.pages).toHaveLength(1)
    for (let i = 0; i < MAX_TABS; i++) act(() => hook.result.current.open(P(`p${i}.html`)))
    expect(hook.result.current.pages).toHaveLength(MAX_TABS)
    expect(hook.result.current.pages.some((p) => p.name === 'pagina.html')).toBe(false)
    expect(hook.result.current.active?.name).toBe(`p${MAX_TABS - 1}.html`)
    // Uma aba de arquivo (ou um arquivo da árvore): o código volta.
    act(() => hook.result.current.onSelect('k'))
    expect([hook.result.current.active, onSelect.mock.lastCall?.[0]]).toEqual([null, 'k'])
    act(() => hook.result.current.onSelectPage(normalizePath(P('p0.html'))))
    expect(hook.result.current.active?.name).toBe('p0.html')
    act(() => hook.result.current.onBrowse(P('x.ts')))
    expect([hook.result.current.active, onBrowse.mock.lastCall?.[0]]).toEqual([null, P('x.ts')])
    // Voltar a seguir o Agent: a prévia sai da vista e não volta sozinha.
    act(() => hook.result.current.onSelectPage(normalizePath(P('p0.html'))))
    hook.rerender({ follow: true })
    expect(hook.result.current.active).toBeNull()
    hook.rerender({ follow: false })
    expect(hook.result.current.active).toBeNull()
  })

  it('recarga ao vivo (tempo falso): no máximo 1 vez a cada 2 s; a escrita do meio da janela espera o fim dela e a última ganha', () => {
    vi.useFakeTimers()
    const hook = renderHook((p: { id: string | null }) => useThrottled(p.id, RELOAD_MS), { initialProps: { id: 'w1' } })
    expect(hook.result.current).toBe('w1')
    // A página acabou de abrir: a escrita logo depois espera a janela.
    hook.rerender({ id: 'w2' })
    act(() => vi.advanceTimersByTime(500))
    hook.rerender({ id: 'w3' })
    expect(hook.result.current).toBe('w1')
    act(() => vi.advanceTimersByTime(RELOAD_MS - 500 - 1))
    expect(hook.result.current).toBe('w1')
    act(() => vi.advanceTimersByTime(1))
    expect(hook.result.current).toBe('w3')
    // Outra logo em seguida: de novo só no fim da janela nova.
    act(() => vi.advanceTimersByTime(100))
    hook.rerender({ id: 'w4' })
    expect(hook.result.current).toBe('w3')
    act(() => vi.advanceTimersByTime(RELOAD_MS - 100))
    expect(hook.result.current).toBe('w4')
    // Depois de um tempo quieto: na hora.
    act(() => vi.advanceTimersByTime(5 * RELOAD_MS))
    hook.rerender({ id: 'w5' })
    expect(hook.result.current).toBe('w5')
    // Desmontar com uma recarga marcada não deixa o relógio vivo.
    hook.rerender({ id: 'w6' })
    hook.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
