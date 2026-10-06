/**
 * A Prévia do HTML do Agent no app Código: a aba "Prévia: x.html" logo depois
 * da do código, aberta pelo olho, pelo cartão do Write no Chat ou pelo clique
 * no agente que acabou de criar o arquivo; o iframe isolado só montado com a
 * aba à vista; a recarga a cada escrita (no máximo 1×/2 s, a última ganha).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { MockupUrlResult } from '@shared/officeMockup'
import type { OfficeFeed } from '../../office/adapter/feed'
import type { OfficeCharacterModel } from '../../office/adapter/model'
import { conv, feed } from '../../office/adapter/testFeed'
import type { UIMessage } from '../../types'
import { UiProvider } from '../../ui/UiProvider'
import { CodeMonitor } from './CodeMonitor'
import { PreviewPane, RELOAD_MS } from './PreviewPane'

const CWD = 'C:\\proj\\loja'
const P = (rel: string): string => `${CWD}\\${rel}`
const HTML = P('web\\pagina.html')
const model: OfficeCharacterModel = {
  key: 'conv:a', convId: 'a', roomId: 'c:/proj/loja', role: 'principal', placement: { kind: 'seat', seatKind: 'principal' },
  seed: 'conv:a', active: true, activity: null, bubble: null, label: 'Write pagina.html'
}
const ask: UIMessage = { kind: 'user', id: 'u', text: 'faz a página' }
const tool = (id: string, name: string, input: unknown): UIMessage => ({ kind: 'tool-use', id, name, input, parentToolUseId: null, result: { isError: false, text: 'ok' } })
const writeHtml = (id = 'w1'): UIMessage => tool(id, 'Write', { file_path: HTML, content: '<h1>oi</h1>' })
const editHtml = (id: string): UIMessage => tool(id, 'Edit', { file_path: HTML, old_string: 'oi', new_string: 'olá' })
const editTs = (): UIMessage => tool('e-ts', 'Edit', { file_path: P('src\\a.ts'), old_string: 'const a = 0', new_string: 'const a = 1' })
/** O turno fechou há 10 min: o HTML dele já não é "acabou de criar" (a tela abre como sempre). */
const closed = (): UIMessage => ({ kind: 'assistant-text', id: 'fim', text: 'pronto', final: true, answer: true, ts: Date.now() - 10 * 60_000 }) as UIMessage
const feedOf = (messages: UIMessage[], busy = false): OfficeFeed => feed({ conversations: [conv('a', { title: 'Loja', cwd: CWD, messages })], busyIds: new Set(busy ? ['a'] : []) })
const ui = (f: OfficeFeed): JSX.Element => (
  <UiProvider>
    <CodeMonitor feed={f} model={model} />
  </UiProvider>
)
const mockupUrl = vi.fn(async (_r: { cwd: string; path: string }): Promise<MockupUrlResult> => ({ ok: true, url: 'agent-mockup://tok/web/pagina.html' }))
const frame = (): HTMLElement | null => screen.queryByTestId('monitor-preview-iframe')
const codeTab = (): HTMLElement => screen.getByRole('tab', { name: /^pagina\.html, / })
const pageTab = (): HTMLElement => screen.getByRole('tab', { name: 'Prévia: pagina.html' })
const eye = (): HTMLElement | null => screen.queryByRole('button', { name: 'Abrir prévia' })

beforeEach(() => {
  localStorage.clear()
  mockupUrl.mockClear()
  ;(window as unknown as { api: unknown }).api = { readFile: vi.fn(async () => '<h1>oi</h1>\n'), officeMockupUrl: mockupUrl }
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (window as unknown as { api?: unknown }).api
})

describe('CodeMonitor — a Prévia do HTML do Agent', () => {
  it('o olho só no .html do Agent (não no .ts) abre a aba "Prévia" logo depois da do código, à vista e sem seguir o Agent; o iframe isolado; a barra e o status dizem "ao vivo"', async () => {
    render(ui(feedOf([ask, writeHtml(), editTs(), closed()])))
    // Seguindo o Agent: o a.ts (o último que ele mexeu) — sem olho.
    expect(eye()).toBeNull()
    fireEvent.click(codeTab())
    fireEvent.click(eye()!)
    const names = screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label'))
    expect(names[names.findIndex((n) => n?.startsWith('pagina.html')) + 1]).toBe('Prévia: pagina.html')
    expect(pageTab().getAttribute('aria-selected')).toBe('true')
    const f = await screen.findByTestId('monitor-preview-iframe')
    expect(mockupUrl).toHaveBeenCalledWith({ cwd: CWD, path: HTML })
    expect([f.getAttribute('sandbox'), f.getAttribute('referrerpolicy'), f.getAttribute('src')]).toEqual(['allow-scripts', 'no-referrer', 'agent-mockup://tok/web/pagina.html'])
    // O editor não desenha o código com a prévia à vista.
    expect(screen.getByRole('tabpanel').querySelector('.cm-editor')).toBeNull()
    const bar = screen.getByTestId('monitor-preview')
    expect(bar.querySelector('.cm-pv-url')?.textContent).toBe('agent-mockup://loja/web/pagina.html')
    expect(within(bar).getByText('ao vivo')).toBeTruthy()
    expect(screen.getByText('Prévia ao vivo')).toBeTruthy()
    expect(screen.queryByText(/^Ln \d+, Col \d+$/)).toBeNull()
    expect(screen.getByTestId('office-screen').querySelector('.cm-title b')?.textContent).toBe('Prévia: pagina.html')
    expect(screen.getByRole('button', { name: /Seguir o Agent/ }).getAttribute('aria-pressed')).toBe('false')
    // Na aba da prévia não há olho; abrir de novo pelo código não duplica a aba.
    expect(eye()).toBeNull()
    fireEvent.click(codeTab())
    fireEvent.click(eye()!)
    expect(screen.getAllByRole('tab', { name: 'Prévia: pagina.html' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('tab', { name: /^a\.ts, / }))
    expect(eye()).toBeNull()
  })

  it('o iframe só existe com a aba à vista: sair da aba ou do app desmonta, voltar remonta (recarrega); seguir o Agent sai da prévia', async () => {
    const view = render(ui(feedOf([ask, writeHtml(), editTs(), closed()])))
    fireEvent.click(codeTab())
    fireEvent.click(eye()!)
    const first = await screen.findByTestId('monitor-preview-iframe')
    fireEvent.click(codeTab())
    expect(frame()).toBeNull()
    expect(screen.getByRole('tabpanel').querySelector('.cm-editor')).toBeTruthy()
    fireEvent.click(pageTab())
    expect(await screen.findByTestId('monitor-preview-iframe')).not.toBe(first)
    fireEvent.click(screen.getByRole('button', { name: 'Contexto' }))
    expect(frame()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Código' }))
    expect(await screen.findByTestId('monitor-preview-iframe')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Seguir o Agent/ }))
    expect(frame()).toBeNull()
    expect(pageTab().getAttribute('aria-selected')).toBe('false')
    // Fechar a tela solta o iframe.
    fireEvent.click(pageTab())
    expect(await screen.findByTestId('monitor-preview-iframe')).toBeTruthy()
    view.unmount()
    expect(frame()).toBeNull()
  })

  it('com a prévia à vista, o cartão de outro arquivo no Chat sai dela (o Edit do .ts abre a aba dele, sem o iframe); o Write do .html volta a ela', async () => {
    render(ui(feedOf([ask, writeHtml(), editTs(), closed()])))
    fireEvent.click(codeTab())
    fireEvent.click(eye()!)
    expect(await screen.findByTestId('monitor-preview-iframe')).toBeTruthy()
    const cards = [...screen.getByTestId('office-screen-chat').querySelectorAll<HTMLElement>('.tool-card')]
    fireEvent.click(within(cards.find((c) => c.textContent?.includes('a.ts'))!).getByTitle('Abrir no editor'))
    expect(screen.getByRole('tab', { name: /^a\.ts, / }).getAttribute('aria-selected')).toBe('true')
    expect(pageTab().getAttribute('aria-selected')).toBe('false')
    expect(frame()).toBeNull()
    fireEvent.click(within(cards.find((c) => c.textContent?.includes('pagina.html'))!).getByTitle('Abrir no editor'))
    expect(pageTab().getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByTestId('monitor-preview-iframe')).toBeTruthy()
  })

  it('o .html que acabou de ser criado fora da pasta do projeto (a prévia não o abriria) não troca o app lembrado nem avisa', () => {
    localStorage.setItem('agentcode.monitor.app', 'ctx')
    render(ui(feedOf([ask, tool('w-fora', 'Write', { file_path: 'D:\\fora\\tela.html', content: '<h1>' })], true)))
    expect(screen.getByTestId('office-screen').dataset.mode).toBe('ctx')
    expect(screen.queryByText(/Sem prévia/)).toBeNull()
  })

  it('a escrita que sai da janela lida do fim da conversa (o id vira null) não recarrega a página, nem depois da janela de 2 s', async () => {
    vi.useFakeTimers()
    const view = render(<PreviewPane cwd={CWD} project="loja" path={HTML} name="pagina.html" writeId="w1" mockupUrl={mockupUrl} />)
    await act(async () => {})
    expect(frame()?.dataset.reload).toBe('w1:0')
    const before = frame()
    view.rerender(<PreviewPane cwd={CWD} project="loja" path={HTML} name="pagina.html" writeId={null} mockupUrl={mockupUrl} />)
    await act(async () => {
      vi.advanceTimersByTime(3 * RELOAD_MS)
    })
    expect(frame()?.dataset.reload).toBe('w1:0')
    expect(frame()).toBe(before)
    // Uma escrita nova de verdade, depois do null, recarrega.
    view.rerender(<PreviewPane cwd={CWD} project="loja" path={HTML} name="pagina.html" writeId="w2" mockupUrl={mockupUrl} />)
    await act(async () => {})
    expect(frame()?.dataset.reload).toBe('w2:0')
  })

  it('o cartão do Write de um .html no Chat abre o código e a prévia, com a prévia à vista', async () => {
    render(ui(feedOf([ask, writeHtml(), editTs(), closed()])))
    const card = [...screen.getByTestId('office-screen-chat').querySelectorAll<HTMLElement>('.tool-card')].find((c) => c.textContent?.includes('pagina.html'))!
    fireEvent.click(within(card).getByTitle('Abrir no editor'))
    expect(pageTab().getAttribute('aria-selected')).toBe('true')
    expect(codeTab().getAttribute('aria-selected')).toBe('false')
    expect(await screen.findByTestId('monitor-preview-iframe')).toBeTruthy()
  })

  it('clicar no agente que acabou de criar um .html abre a tela no Código já na prévia, mesmo com o Contexto lembrado (que continua lembrado); o de 10 min atrás, não', async () => {
    localStorage.setItem('agentcode.monitor.app', 'ctx')
    render(ui(feedOf([ask, editTs(), writeHtml()], true)))
    expect(screen.getByTestId('office-screen').dataset.mode).toBe('code')
    expect(pageTab().getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByTestId('monitor-preview-iframe')).toBeTruthy()
    expect(localStorage.getItem('agentcode.monitor.app')).toBe('ctx')
    cleanup()
    render(ui(feedOf([ask, editTs(), writeHtml(), closed()])))
    expect(screen.getByTestId('office-screen').dataset.mode).toBe('ctx')
    fireEvent.click(screen.getByRole('button', { name: 'Código' }))
    expect(screen.queryByRole('tab', { name: 'Prévia: pagina.html' })).toBeNull()
  })

  it('ao vivo (tempo falso): cada escrita nova remonta o iframe com a chave dela, no máximo 1 vez a cada 2 s, e a última ganha; o botão recarrega na hora', async () => {
    vi.useFakeTimers()
    const view = render(ui(feedOf([ask, writeHtml('w1')], true)))
    await act(async () => {})
    expect(frame()?.dataset.reload).toBe('w1:0')
    view.rerender(ui(feedOf([ask, writeHtml('w1'), editHtml('w2')], true)))
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    view.rerender(ui(feedOf([ask, writeHtml('w1'), editHtml('w2'), editHtml('w3')], true)))
    await act(async () => {})
    expect(frame()?.dataset.reload).toBe('w1:0')
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    expect(frame()?.dataset.reload).toBe('w3:0')
    const before = frame()
    fireEvent.click(screen.getByRole('button', { name: 'Recarregar a prévia' }))
    expect(frame()?.dataset.reload).toBe('w3:1')
    expect(frame()).not.toBe(before)
  })
})
