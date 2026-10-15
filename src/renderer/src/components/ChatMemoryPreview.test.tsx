import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChatMemoryAttachment } from './ChatMemories'
import { previewText, SHOW_MS } from './ChatMemoryPreview'

const entries = [{ relPath: 'agent-code/vps.md', supplied: true, read: false }, { relPath: 'sumiu.md', supplied: true, read: false }]
const body = '---\nname: vps\n---\n# Acesso à VPS\n\nUse **ssh** com a senha {{secret:vps_2d}}.\n\n\n\nDepois reinicie.'

let read: ReturnType<typeof vi.fn>
beforeEach(() => {
  read = vi.fn(async (relPath: string) => relPath === 'agent-code/vps.md'
    ? { relPath, title: 'Acesso à VPS', hook: 'como entrar na VPS de produção', body }
    : null)
  Object.assign(window, { api: { memoryReadEntry: read, revealFile: vi.fn() } })
})
afterEach(cleanup)

function openList(): void {
  render(<ChatMemoryAttachment entries={entries} onRetry={() => undefined} />)
  fireEvent.click(screen.getByRole('button', { name: /2 memórias/ }))
}
const nameOf = (text: string): HTMLElement => screen.getByText(text, { selector: '.chat-memory-name' })

describe('amostra da memória ao passar o mouse', () => {
  it('hover abre o balão customizado com caminho, título, gancho e o começo do corpo', async () => {
    openList()
    const el = nameOf('agent-code/vps.md')
    expect(el.getAttribute('title')).toBeNull()
    fireEvent.pointerEnter(el)
    // Ainda não: espera SHOW_MS.
    expect(screen.queryByRole('tooltip')).toBeNull()
    const tip = await screen.findByRole('tooltip', {}, { timeout: SHOW_MS + 500 })
    expect(tip.textContent).toContain('agent-code/vps.md')
    await waitFor(() => expect(tip.textContent).toContain('Acesso à VPS'))
    expect(tip.textContent).toContain('como entrar na VPS de produção')
    expect(tip.textContent).toContain('Use ssh com a senha {{secret:vps_2d}}.')
    expect(tip.textContent).not.toContain('name: vps')
    expect(read).toHaveBeenCalledWith('agent-code/vps.md')
    expect(el.getAttribute('aria-describedby')).toBe(tip.id)
    fireEvent.pointerLeave(el)
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
  })

  it('cache por relPath: passar de novo (e fechar/reabrir a lista) não relê', async () => {
    openList()
    fireEvent.pointerEnter(nameOf('agent-code/vps.md'))
    await screen.findByText('como entrar na VPS de produção')
    fireEvent.pointerLeave(nameOf('agent-code/vps.md'))
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    const toggle = screen.getByRole('button', { name: /2 memórias/ })
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    fireEvent.pointerEnter(nameOf('agent-code/vps.md'))
    await screen.findByText('como entrar na VPS de produção')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('memória apagada e falha de leitura viram mensagem curta; a falha não fica no cache', async () => {
    openList()
    fireEvent.pointerEnter(nameOf('sumiu.md'))
    await screen.findByText('Esta memória não existe mais.')
    fireEvent.pointerLeave(nameOf('sumiu.md'))
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    read.mockRejectedValueOnce(new Error('offline'))
    fireEvent.pointerEnter(nameOf('agent-code/vps.md'))
    await screen.findByText('Não foi possível ler a memória.')
    fireEvent.pointerLeave(nameOf('agent-code/vps.md'))
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    // Desmonta a amostra antiga (lista fechada) para a nova leitura aparecer limpa.
    const toggle = screen.getByRole('button', { name: /2 memórias/ })
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    fireEvent.pointerEnter(nameOf('agent-code/vps.md'))
    await screen.findByText('como entrar na VPS de produção')
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('foco pelo teclado mostra e Esc esconde; "Carregando…" enquanto lê', async () => {
    let resolve: (v: unknown) => void = () => undefined
    read.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    openList()
    const el = nameOf('agent-code/vps.md')
    expect(el.tabIndex).toBe(0)
    act(() => el.focus())
    await screen.findByText('Carregando…', {}, { timeout: SHOW_MS + 500 })
    await act(async () => resolve({ relPath: 'agent-code/vps.md', title: 'Acesso à VPS', hook: 'g', body: 'x' }))
    await screen.findByText('Acesso à VPS', { selector: 'strong' })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
  })
})

describe('previewText', () => {
  it('tira frontmatter e o título repetido e corta em ~600 caracteres', () => {
    expect(previewText(body, 'Acesso à VPS')).toBe('Use ssh com a senha {{secret:vps_2d}}.\n\nDepois reinicie.')
    const long = previewText('a'.repeat(900))
    expect(long).toHaveLength(601)
    expect(long.endsWith('…')).toBe(true)
  })
})
