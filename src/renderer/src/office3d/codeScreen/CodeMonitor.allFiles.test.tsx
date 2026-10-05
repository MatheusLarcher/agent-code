import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ProjectDirListing } from '@shared/ipc'
import type { OfficeCharacterModel } from '../../office/adapter/model'
import { conv, feed } from '../../office/adapter/testFeed'
import type { UIMessage } from '../../types'
import { UiProvider } from '../../ui/UiProvider'
import { CodeMonitor } from './CodeMonitor'
import { readFileView } from './readView'

const CWD = 'C:\\proj\\loja'
const P = (rel: string): string => `${CWD}\\${rel}`
const model: OfficeCharacterModel = {
  key: 'conv:a', convId: 'a', roomId: 'c:/proj/loja', role: 'principal', placement: { kind: 'seat', seatKind: 'principal' },
  seed: 'conv:a', active: true, activity: null, bubble: null, label: 'x'
}
let seq = 0
const tool = (name: string, input: unknown): UIMessage =>
  ({ kind: 'tool-use', id: `r${seq++}`, name, input, parentToolUseId: null, result: { isError: false, text: 'ok' } }) as UIMessage
const ask: UIMessage = { kind: 'user', id: 'u', text: 'olha' }
const ui = (messages: UIMessage[], cwd = CWD): JSX.Element => (
  <UiProvider>
    <CodeMonitor feed={feed({ conversations: [conv('a', { title: 'Loja', cwd, messages })], busyIds: new Set(['a']) })} model={model} />
  </UiProvider>
)
const ok = (entries: ProjectDirListing['entries']): ProjectDirListing => ({ entries, truncated: false, error: null })
const DIRS: Record<string, ProjectDirListing> = {
  '': ok([
    { path: 'src', name: 'src', isDir: true },
    { path: 'vazia', name: 'vazia', isDir: true },
    { path: 'quebrada', name: 'quebrada', isDir: true },
    { path: 'README.md', name: 'README.md', isDir: false }
  ]),
  src: ok([
    { path: 'src/a.ts', name: 'a.ts', isDir: false },
    { path: 'src/b.ts', name: 'b.ts', isDir: false }
  ]),
  vazia: ok([]),
  quebrada: { entries: [], truncated: false, error: 'Não deu para ler a pasta.' }
}
const MSGS = [ask, tool('Edit', { file_path: P('src\\a.ts'), old_string: 'x', new_string: 'y' })]

let projectDir: ReturnType<typeof vi.fn>
beforeEach(() => {
  localStorage.clear()
  projectDir = vi.fn(async (_root: string, rel: string) => DIRS[rel] ?? ok([]))
  const readFile = vi.fn(async (p: string) => (p === P('README.md') ? '# Loja\nlinha 2\n' : 'y\n'))
  ;(window as unknown as { api: unknown }).api = { readFile, projectDir }
})
afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

const toggle = (): HTMLElement => screen.getByRole('button', { name: /Apenas usados/ })
const explorer = (): HTMLElement => screen.getByRole('navigation', { name: /Explorador/ })
const statusText = (): string => screen.getByTestId('office-screen').querySelector('.cm-statusbar')!.textContent ?? ''

describe('CodeMonitor — Apenas usados × Todos os arquivos', () => {
  it('padrão marcado (comportamento de hoje); desmarcar mostra a árvore e pastas expandem sob demanda', async () => {
    render(ui(MSGS))
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    expect([...explorer().querySelectorAll('.cm-section')].map((s) => s.textContent)).toEqual(['Alterados1', 'Lidos0'])
    expect(projectDir).not.toHaveBeenCalled()

    fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
    await screen.findByRole('button', { name: 'README.md' })
    expect(projectDir).toHaveBeenCalledWith(CWD, '')
    const src = screen.getByRole('button', { name: 'src' })
    expect(src.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(src)
    // O alterado pelo Agent leva o marcador também na árvore completa.
    expect((await screen.findByRole('button', { name: 'a.ts, modificado' })).querySelector('.cm-badge-M')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'b.ts' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'vazia' }))
    expect(await screen.findByText('Pasta vazia.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'quebrada' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Não deu para ler a pasta.')

    // Alternar e voltar: as pastas abertas continuam abertas.
    fireEvent.click(toggle())
    fireEvent.click(toggle())
    expect((await screen.findByRole('button', { name: 'src' })).getAttribute('aria-expanded')).toBe('true')
  })

  it('arquivo não tocado abre como aba de prévia inteira, somente leitura; parar/voltar a seguir', async () => {
    render(ui(MSGS))
    fireEvent.click(toggle())
    fireEvent.click(await screen.findByRole('button', { name: 'README.md' }))
    const tab = screen.getByRole('tab', { name: 'README.md, lido' })
    expect([tab.classList.contains('cm-tab-pv'), tab.getAttribute('aria-selected')]).toEqual([true, 'true'])
    await vi.waitFor(() =>
      expect([...screen.getByRole('tabpanel').querySelectorAll<HTMLElement>('.cm-row')].map((r) => r.textContent)).toEqual(['1# Loja', '2linha 2'])
    )
    expect(screen.getByRole('tabpanel').querySelector('.cm-hunk')).toBeNull()
    expect(statusText()).toContain('Somente leitura')
    expect(statusText()).not.toContain('leu o arquivo')
    const follow = screen.getByRole('button', { name: /Seguir o Agent/ })
    expect(follow.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(follow)
    expect(screen.queryByRole('tab', { name: 'README.md, lido' })).toBeNull()
    expect(screen.getByRole('tab', { name: 'a.ts, modificado' }).getAttribute('aria-selected')).toBe('true')
  })

  it('remontar volta ao padrão; projeto sem cwd mostra a mensagem', async () => {
    const view = render(ui(MSGS))
    fireEvent.click(toggle())
    await screen.findByRole('button', { name: 'README.md' })
    view.unmount()
    render(ui(MSGS))
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    cleanup()

    render(ui(MSGS, ''))
    await act(async () => fireEvent.click(toggle()))
    expect(screen.getByText(/Conversa sem pasta de projeto/)).toBeTruthy()
    expect(projectDir).toHaveBeenCalledTimes(1)
  })
})

describe('readFileView — arquivo inteiro (whole)', () => {
  it('sem faixas de não lidas mesmo acima do teto do Read', () => {
    const text = Array.from({ length: 2100 }, (_, i) => `l${i + 1}`).join('\n')
    const v = readFileView({ disk: { kind: 'text', text, reflected: new Set() }, offset: null, limit: null, whole: true })
    expect([v.rows.length, v.rows.some((r) => r.kind === 'hunk'), v.shown]).toEqual([2100, false, { from: 1, to: 2100, total: 2100 }])
  })
})
