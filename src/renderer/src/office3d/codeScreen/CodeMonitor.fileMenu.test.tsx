import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { RevealFileRequest, RevealFileResult } from '@shared/ipc'
import type { OfficeCharacterModel } from '../../office/adapter/model'
import { conv, feed } from '../../office/adapter/testFeed'
import type { UIMessage } from '../../types'
import { UiProvider } from '../../ui/UiProvider'
import { openSteps } from '../../components/chatStepsTestkit'
import { CodeMonitor } from './CodeMonitor'

const CWD = 'C:\\proj\\loja'
const A = `${CWD}\\src\\a.ts`
const model: OfficeCharacterModel = {
  key: 'conv:a', convId: 'a', roomId: 'c:/proj/loja', role: 'principal', placement: { kind: 'seat', seatKind: 'principal' },
  seed: 'conv:a', active: true, activity: null, bubble: null, label: 'Edit a.ts'
}
const ask: UIMessage = { kind: 'user', id: 'u', text: 'mexe no a' }
const editA: UIMessage = { kind: 'tool-use', id: 'e1', name: 'Edit', input: { file_path: A, old_string: 'const a = 0', new_string: 'const a = 1' }, parentToolUseId: null, result: { isError: false, text: 'ok' } } as UIMessage
const ui = (onClose = vi.fn()): JSX.Element => (
  <UiProvider>
    <CodeMonitor feed={feed({ conversations: [conv('a', { title: 'Loja', cwd: CWD, messages: [ask, editA] })], busyIds: new Set(['a']) })} model={model} onClose={onClose} />
  </UiProvider>
)

let revealFile: ReturnType<typeof vi.fn<(req: RevealFileRequest) => Promise<RevealFileResult>>>
beforeEach(() => {
  localStorage.clear()
  revealFile = vi.fn(async () => ({ ok: true, message: '' }))
  ;(window as unknown as { api: unknown }).api = { readFile: vi.fn(async () => 'const a = 1\n'), revealFile }
})
afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

const tab = (): HTMLElement => screen.getByRole('tab', { name: 'a.ts, modificado' })
const menu = (): HTMLElement | null => screen.queryByTestId('file-menu')

describe('CodeMonitor — botão direito num arquivo', () => {
  it('na aba: o menu com "Abrir arquivo" e "Abrir pasta do arquivo", cada um pelo revealFile com o projeto da conversa', async () => {
    render(ui())
    fireEvent.contextMenu(tab())
    expect(within(menu()!).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Abrir arquivo', 'Abrir pasta do arquivo'])
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'Abrir arquivo' })))
    expect(revealFile).toHaveBeenCalledWith({ mode: 'open', path: A, cwd: CWD })
    expect(menu()).toBeNull()

    const file = screen.getByRole('navigation', { name: /Explorador/ }).querySelector<HTMLElement>('.cm-file')!
    fireEvent.contextMenu(file)
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'Abrir pasta do arquivo' })))
    expect(revealFile).toHaveBeenLastCalledWith({ mode: 'folder', path: A, cwd: CWD })
  })

  it('o cartão de arquivo do Chat também; o clique normal continua abrindo no editor', () => {
    render(ui())
    openSteps(screen.getByTestId('office-screen-chat')) // o cartão fica atrás da linha-resumo (chat resumido)
    const card = screen.getByTestId('office-screen-chat').querySelector<HTMLElement>('.tool-card')!
    fireEvent.contextMenu(within(card).getByTitle('Abrir no editor'))
    expect(menu()).not.toBeNull()
  })

  it('Esc fecha o menu sem fechar a tela; clique fora e a roda também fecham', () => {
    const onClose = vi.fn()
    render(ui(onClose))
    fireEvent.contextMenu(tab())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(menu()).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.contextMenu(tab())
    fireEvent.pointerDown(document.body)
    expect(menu()).toBeNull()
    fireEvent.contextMenu(tab())
    fireEvent.wheel(window)
    expect(menu()).toBeNull()
  })

  it('arquivo apagado: aviso na tela, nada aberto', async () => {
    revealFile.mockResolvedValueOnce({ ok: false, missing: true, message: 'a.ts não existe mais (apagado ou movido).' })
    render(ui())
    fireEvent.contextMenu(tab())
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'Abrir arquivo' })))
    const toast = screen.getByTestId('office-screen').querySelector('.cm-toast')
    expect(toast?.textContent).toContain('a.ts não existe mais')
  })

  it('sem o revealFile (o celular): o botão direito não abre menu', () => {
    ;(window as unknown as { api: unknown }).api = { readFile: vi.fn(async () => 'const a = 1\n') }
    render(ui())
    const ev = fireEvent.contextMenu(tab())
    expect(menu()).toBeNull()
    // Nada foi cancelado: o botão direito segue como sempre.
    expect(ev).toBe(true)
  })
})
