import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { InspectorPick, PreviewFileResult, PreviewTab } from '@shared/preview'
import type { PickedElement } from '@shared/ipc'

vi.mock('./viewers/FileViewer', () => ({
  FileViewer: ({ result }: { result: { kind: string; path: string } }) => (
    <div className="pv-viewer">
      <p data-testid="viewer">
        {result.kind}:{result.path}
      </p>
      <button id="slide-next" onClick={() => viewerClicks.push('next')}>
        próximo
      </button>
    </div>
  )
}))
vi.mock('./WebPreview', () => ({
  WebPreview: ({ src, followNav }: { src: string; followNav: boolean }) => (
    <div data-testid="web" data-follow={String(followNav)}>
      {src}
    </div>
  )
}))

import { FilePreview } from './FilePreview'
import { publishComposerElements } from './composerElements'

const viewerClicks: string[] = []

type Api = { previewReadFile?: (p: string) => Promise<PreviewFileResult> }
const win = window as unknown as { api?: Api }
let saved: Api | undefined

beforeEach(() => {
  saved = win.api
  viewerClicks.length = 0
})
afterEach(() => {
  cleanup()
  win.api = saved
  publishComposerElements([])
})

const tab = (target: string, kind: PreviewTab['kind'] = 'markdown'): PreviewTab => ({
  id: 'pv-1',
  kind,
  target,
  title: target.split('\\').pop() ?? target
})

function show(t: PreviewTab): void {
  const noop = (): void => {}
  render(
    <FilePreview
      tab={t}
      reloadKey={0}
      picking={false}
      onPickingChange={noop}
      onPick={noop}
      onNavigate={noop}
      onTitle={noop}
      onNavState={noop}
      controlRef={{ current: null }}
    />
  )
}

describe('FilePreview', () => {
  it('mostra "Abrindo…" e depois o arquivo no leitor', async () => {
    const read = vi.fn(async (path: string): Promise<PreviewFileResult> => ({
      ok: true,
      kind: 'markdown',
      path,
      text: '# Oi',
      truncated: false
    }))
    win.api = { previewReadFile: read }
    show(tab('C:\\proj\\a.md'))
    expect(screen.getByRole('status').textContent).toContain('Abrindo a.md')
    expect((await screen.findByTestId('viewer')).textContent).toBe('markdown:C:\\proj\\a.md')
    expect(read).toHaveBeenCalledWith('C:\\proj\\a.md')
  })

  it('arquivo que sumiu vira aviso claro com o caminho', async () => {
    win.api = {
      previewReadFile: async (path) => ({ ok: false, path, reason: 'not-found', message: 'ENOENT' })
    }
    show(tab('C:\\proj\\sumiu.md'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Arquivo não encontrado')
    expect(alert.textContent).toContain('C:\\proj\\sumiu.md')
    expect(alert.textContent).not.toContain('ENOENT')
  })

  it('erro inesperado do main mostra o detalhe', async () => {
    win.api = { previewReadFile: () => Promise.reject(new Error('EBUSY')) }
    show(tab('C:\\proj\\b.json', 'json'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Erro ao abrir o arquivo')
    expect(alert.textContent).toContain('Detalhe: EBUSY')
  })

  it('sem a função no preload avisa em vez de quebrar', async () => {
    win.api = {}
    show(tab('C:\\proj\\a.md'))
    expect((await screen.findByRole('alert')).textContent).toContain('Preview de arquivo indisponível')
  })

  it('html vai para o webview pela URL do main, sem seguir navegação', async () => {
    win.api = {
      previewReadFile: async (path) => ({ ok: true, kind: 'html', path, url: 'agent-preview://file/C%3A/proj/i.html' })
    }
    show(tab('C:\\proj\\i.html', 'html'))
    const web = await screen.findByTestId('web')
    expect(web.textContent).toBe('agent-preview://file/C%3A/proj/i.html')
    expect(web.getAttribute('data-follow')).toBe('false')
  })

  describe('modo Selecionar nos arquivos (md, planilha, slides, código, json)', () => {
    const md = (): void => {
      win.api = {
        previewReadFile: async (path) => ({ ok: true, kind: 'markdown', path, text: '# Oi', truncated: false })
      }
    }
    const marks = (): string[] =>
      [...document.querySelectorAll<HTMLElement>('.pv-pick-layer [data-agent-preview-inspector]')]
        .filter((n) => n.style.display !== 'none' && n.firstElementChild?.textContent && !n.querySelector('div[style*="monospace"]'))
        .map((n) => n.firstElementChild!.textContent!)

    function showPicking(t: PreviewTab, picking: boolean, onPick: (p: InspectorPick) => void, onPickingChange: (on: boolean) => void) {
      const noop = (): void => {}
      const el = (p: boolean): JSX.Element => (
        <FilePreview
          tab={t}
          reloadKey={0}
          picking={p}
          onPickingChange={onPickingChange}
          onPick={onPick}
          onNavigate={noop}
          onTitle={noop}
          onNavState={noop}
          controlRef={{ current: null }}
          tabId={t.id}
        />
      )
      const r = render(el(picking))
      return { setPicking: (p: boolean) => r.rerender(el(p)) }
    }

    it('clique escolhe o elemento (url = caminho do arquivo, índice 1) e não chega ao visualizador', async () => {
      md()
      const onPick = vi.fn()
      const onPickingChange = vi.fn()
      showPicking(tab('C:\\proj\\a.md'), true, onPick, onPickingChange)
      await screen.findByTestId('viewer')
      const btn = document.getElementById('slide-next')!
      expect(btn.closest('.pp-file')?.hasAttribute('data-pv-picking')).toBe(true)
      expect(btn.closest('.pv-pick-host')?.classList.contains('picking')).toBe(true)
      act(() => btn.click())
      expect(viewerClicks).toEqual([])
      expect(onPick).toHaveBeenCalledTimes(1)
      expect(onPick.mock.calls[0][0]).toEqual(
        expect.objectContaining({ tagName: 'button', selector: '#slide-next', url: 'C:\\proj\\a.md', index: 1 })
      )
      expect(marks()).toEqual(['1'])
      expect(onPickingChange).not.toHaveBeenCalled()
    })

    it('Esc desliga o modo pelo onPickingChange(false); desligado, o visualizador volta a responder', async () => {
      md()
      const onPickingChange = vi.fn()
      const { setPicking } = showPicking(tab('C:\\proj\\a.md'), true, vi.fn(), onPickingChange)
      await screen.findByTestId('viewer')
      const btn = document.getElementById('slide-next')!
      act(() => {
        btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      expect(onPickingChange).toHaveBeenCalledWith(false)
      setPicking(false)
      expect(btn.closest('.pp-file')?.hasAttribute('data-pv-picking')).toBe(false)
      act(() => btn.click())
      expect(viewerClicks).toEqual(['next'])
    })

    it('sem picking nada muda: o clique chega ao visualizador', async () => {
      md()
      const onPick = vi.fn()
      showPicking(tab('C:\\proj\\a.md'), false, onPick, vi.fn())
      await screen.findByTestId('viewer')
      act(() => document.getElementById('slide-next')!.click())
      expect(viewerClicks).toEqual(['next'])
      expect(onPick).not.toHaveBeenCalled()
    })

    it('marcas seguem o campo de mensagem desta aba (retain por seletor)', async () => {
      md()
      const picks: InspectorPick[] = []
      const t = tab('C:\\proj\\a.md')
      showPicking(t, true, (p) => picks.push(p), vi.fn())
      await screen.findByTestId('viewer')
      act(() => document.getElementById('slide-next')!.click())
      expect(marks()).toEqual(['1'])
      const picked = (tabId: string): PickedElement => ({
        ...picks[0],
        tabId,
        tabName: 'a.md'
      })
      // Elemento de outra aba no campo: o desta aba saiu, a marca some.
      act(() => publishComposerElements([picked('pv-outra')]))
      expect(marks()).toEqual([])
      act(() => document.getElementById('slide-next')!.click())
      act(() => publishComposerElements([picked('pv-outra'), picked(t.id)]))
      // Número global do campo ("[elemento 2]"), não a posição nesta aba.
      expect(marks()).toEqual(['2'])
      act(() => publishComposerElements([]))
      expect(marks()).toEqual([])
    })
  })
})
