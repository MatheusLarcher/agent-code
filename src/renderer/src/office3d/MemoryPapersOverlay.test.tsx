import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MemoryListItem } from '@shared/memoryPanel'
import { conv, feed } from '../office/adapter/testFeed'
import type { UIMessage } from '../types'
import { UiContext } from '../ui/UiProvider'
import type { Office3DEngine } from './engine'
import { MemoryPapersOverlay, OfficeMemoryPapers, type MemoryPapersApi } from './MemoryPapersOverlay'

const item = (relPath: string, title: string): MemoryListItem => ({ relPath, title, hook: 'g', folder: '', scope: 'user', projectCwd: null, revision: 1, status: 'active', updatedAt: new Date(0).toISOString() })

function api(extra: Partial<MemoryPapersApi> = {}): Required<MemoryPapersApi> {
  return {
    memoryListEntries: vi.fn(async () => [item('2D/vps.md', 'Acesso à VPS')]),
    memoryReadEntry: vi.fn(async (relPath: string) => (relPath === '2D/vps.md' ? { relPath, body: 'Texto inteiro da memória da VPS.' } : null)),
    revealFile: vi.fn(async () => ({ ok: true, message: '' })),
    ...extra
  } as Required<MemoryPapersApi>
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('os papéis de memória da mesa (MemoryPapersOverlay)', () => {
  it('lista → folha com o texto inteiro (selecionável) → Abrir chama revealFile com o relPath → Voltar', async () => {
    const a = api()
    render(<MemoryPapersOverlay agent="Loja" reads={['2D/vps.md', 'raiz.md']} onClose={vi.fn()} api={a} />)
    // O título vem do acervo; sem ele, o caminho.
    await waitFor(() => expect(screen.getAllByTestId('memory-papers-item').map((b) => b.textContent)).toEqual(['1Acesso à VPS2D/vps.md', '2raiz.md']))
    expect(screen.getByText(/2 memórias lidas/)).toBeTruthy()

    fireEvent.click(screen.getAllByTestId('memory-papers-item')[0])
    const paper = await screen.findByTestId('memory-paper')
    await waitFor(() => expect(screen.getByTestId('memory-paper-body').textContent).toContain('Texto inteiro da memória da VPS.'))
    expect(a.memoryReadEntry).toHaveBeenCalledWith('2D/vps.md')
    expect(paper.querySelector('h2')?.textContent).toBe('Acesso à VPS')

    // Selecionável: nada no caminho impede o padrão do ponteiro, a seleção pega o texto e o CSS da folha libera.
    const text = screen.getByText('Texto inteiro da memória da VPS.')
    const down = createEvent.pointerDown(text)
    fireEvent(text, down)
    expect(down.defaultPrevented).toBe(false)
    const sel = window.getSelection()!
    sel.selectAllChildren(text)
    expect(sel.toString()).toBe('Texto inteiro da memória da VPS.')
    const css = readFileSync(resolve(__dirname, 'memoryPapers.css'), 'utf8')
    expect(css).toMatch(/\.o3d-mempaper \{[^}]*user-select: text;/)

    fireEvent.click(screen.getByRole('button', { name: 'Abrir' }))
    await waitFor(() => expect(a.revealFile).toHaveBeenCalledWith({ mode: 'folder', memory: '2D/vps.md' }))

    fireEvent.click(screen.getByRole('button', { name: /Voltar para a lista/ }))
    expect(screen.queryByTestId('memory-paper')).toBeNull()
    expect(screen.getAllByTestId('memory-papers-item')).toHaveLength(2)
  })

  it('o caminho no topo da folha: hover mostra o caminho completo, clique abre a pasta com a memória selecionada', async () => {
    const a = api()
    render(<MemoryPapersOverlay agent="Loja" reads={['2D/vps.md']} memoriesDir={'D:\\mem\\'} onClose={vi.fn()} api={a} />)
    fireEvent.click(await screen.findByTestId('memory-papers-item'))
    const path = await screen.findByTestId('memory-paper-path')
    expect(path.textContent).toBe('2D/vps.md')
    expect(path.getAttribute('title')).toMatch(/^D:\\mem\\2D\\vps\.md\n/)
    fireEvent.click(path)
    await waitFor(() => expect(a.revealFile).toHaveBeenCalledWith({ mode: 'folder', memory: '2D/vps.md' }))
  })

  it('memória fora do acervo avisa; falha do Abrir vira notify (sem o provedor, aparece na folha); Esc e ✕ fecham', async () => {
    const notify = vi.fn()
    const close = vi.fn()
    const a = api({ revealFile: vi.fn(async () => ({ ok: false, message: 'A memória não existe mais.' })) })
    const { unmount } = render(
      <UiContext.Provider value={{ notify, confirm: vi.fn(async () => true) }}>
        <MemoryPapersOverlay agent="Loja" reads={['raiz.md']} onClose={close} api={a} />
      </UiContext.Provider>
    )
    fireEvent.click(screen.getByTestId('memory-papers-item'))
    await waitFor(() => expect(screen.getByTestId('memory-paper-body').textContent).toContain('não está mais no acervo'))
    fireEvent.click(screen.getByRole('button', { name: 'Abrir' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('erro', 'A memória não existe mais.'))
    // Esc (na captura) fecha só o painel.
    const below = vi.fn()
    window.addEventListener('keydown', below)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(close).toHaveBeenCalledTimes(1)
    expect(below).not.toHaveBeenCalled()
    window.removeEventListener('keydown', below)
    fireEvent.click(screen.getByRole('button', { name: /Fechar os papéis/ }))
    expect(close).toHaveBeenCalledTimes(2)
    unmount()

    const b = api({ revealFile: vi.fn(async () => Promise.reject(new Error('ipc'))) })
    render(<MemoryPapersOverlay agent="Loja" reads={['2D/vps.md']} onClose={vi.fn()} api={b} />)
    fireEvent.click(screen.getByTestId('memory-papers-item'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Abrir' }))
    })
    expect((await screen.findByRole('alert')).textContent).toBe('Não deu para abrir a pasta de memórias.')
  })

  it('no Escritório: o nome e as memórias lidas vêm da conversa do dono da mesa', async () => {
    const MEM = 'D:\\mem'
    const read = (id: string, rel: string): UIMessage => ({ kind: 'tool-use', id, name: 'Read', input: { file_path: `${MEM}\\${rel}` }, parentToolUseId: null, result: { isError: false, text: 'ok' } }) as UIMessage
    const f = feed({ conversations: [conv('a', { title: 'Portal', messages: [read('1', 'b.md'), read('2', 'a.md'), read('3', 'b.md')] })] })
    const engine = { scene: { character: (k: string) => (k === 'conv:a' ? { model: { convId: 'a' } } : undefined), errands: { memoriesDir: MEM } } } as unknown as Pick<Office3DEngine, 'scene'>
    vi.stubGlobal('api', api({ memoryListEntries: vi.fn(async () => []) }))
    render(<OfficeMemoryPapers engine={engine} feed={f} ownerKey="conv:a" onClose={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Memórias lidas por Portal' })).toBeTruthy()
    expect(screen.getAllByTestId('memory-papers-item').map((b) => b.textContent)).toEqual(['1b.md', '2a.md'])
    await act(async () => {})
    vi.unstubAllGlobals()
  })
})
