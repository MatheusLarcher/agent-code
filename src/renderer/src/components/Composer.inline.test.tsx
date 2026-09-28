import { createRef } from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import type { FileAttachment, FileRefAttachment, ImageAttachment } from '@shared/ipc'
import { UiProvider } from '../ui/UiProvider'
import { Composer } from './Composer'
import type { EditorElement } from '../inlineMedia/InlineEditor'

/**
 * Composer com anexo NO PONTO do texto: entra no cursor, vira {{midia:N}} no
 * envio e as regressões que o campo novo não pode trazer (Enter/Shift+Enter,
 * IME, colar texto puro, @menção, foco visível no teclado).
 */

afterEach(cleanup)

type SendFn = (text: string, images: ImageAttachment[], files: FileAttachment[], fileRefs: FileRefAttachment[]) => void
type DraftFn = (convId: string, text: string, media?: unknown[]) => void

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const png = (name: string): File =>
  new File([Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0))], name, { type: 'image/png' })

beforeEach(() => {
  // jsdom não tem scrollIntoView (o menu @ rola até o item ativo).
  Element.prototype.scrollIntoView = vi.fn()
  ;(window as unknown as { api: unknown }).api = {
    mentionSearch: vi.fn(async () => [{ path: 'src/app.ts', name: 'app.ts', isDir: false }]),
    resolvePastedPath: vi.fn(),
    downloadPastedUrl: vi.fn(async () => ({
      ok: true,
      name: 'planilha.xlsx',
      path: 'C:\\att\\planilha.xlsx',
      mediaType: 'application/vnd.ms-excel',
      size: 10,
      isImage: false
    })),
    readFileBytes: vi.fn()
  }
})

function setup(extra: { draft?: string; draftMedia?: unknown[]; convId?: string } = {}) {
  const onSend = vi.fn<SendFn>()
  const onDraftChange = vi.fn<DraftFn>()
  const props = {
    disabled: false,
    busy: false,
    chips: [],
    onRemoveChip: () => {},
    onSend,
    onInterrupt: () => {},
    textareaRef: createRef<HTMLElement>(),
    projects: [],
    projectRoot: 'C:\\proj',
    voiceReady: false,
    onNeedVoiceKey: () => {},
    onDraftChange,
    projectMissing: false,
    projectMissingMsg: ''
  }
  const ui = (convId: string, draft: string, draftMedia?: unknown[]) => (
    <UiProvider>
      <Composer {...props} convId={convId} draft={draft} draftMedia={draftMedia} />
    </UiProvider>
  )
  const r = render(ui(extra.convId ?? 'c1', extra.draft ?? '', extra.draftMedia))
  const box = (): EditorElement => screen.getByPlaceholderText(/Mensagem para o Claude/) as EditorElement
  const attach = (...files: File[]): void => {
    const input = r.container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files } })
  }
  return { onSend, onDraftChange, box, attach, rerender: (c: string, d: string, m?: unknown[]) => r.rerender(ui(c, d, m)) }
}

describe('Composer — anexo entra no ponto do cursor', () => {
  it('imagem pelo botão: miniatura DENTRO do texto, no cursor; envio leva {{midia:1}} ali e a imagem rotulada', async () => {
    const { box, attach, onSend } = setup()
    fireEvent.change(box(), { target: { value: 'analisa a imagem  e modifique' } })
    act(() => box().setSelectionRange(17, 17))
    attach(png('tela.png'))
    const thumb = await screen.findByAltText('Imagem anexada: tela.png')
    expect(thumb.closest('[role="textbox"]')).toBe(box()) // no texto, não numa faixa em cima
    expect(document.querySelector('.img-previews, .file-chips')).toBeNull()

    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith(
      'analisa a imagem {{midia:1}} e modifique',
      [{ mediaType: 'image/png', data: PNG_B64, label: 'midia:1 = tela.png' }],
      [],
      []
    )
  })

  it('vários anexos: cada um no seu ponto, numerados na ordem do texto', async () => {
    const { box, attach, onSend } = setup()
    fireEvent.change(box(), { target: { value: 'de  para ' } })
    act(() => box().setSelectionRange(3, 3))
    attach(png('antes.png'))
    await screen.findByAltText('Imagem anexada: antes.png')
    act(() => box().setSelectionRange(box().value.length, box().value.length))
    attach(new File(['a,b'], 'dados.csv', { type: 'text/csv' }))
    await screen.findByAltText(/Arquivo anexado: dados\.csv/)
    fireEvent.keyDown(box(), { key: 'Enter' })
    const [text, images, files] = onSend.mock.calls[0]
    expect(text).toBe('de {{midia:1}} para {{midia:2}}')
    expect(images.map((i) => i.label)).toEqual(['midia:1 = antes.png'])
    expect(files.map((f) => f.label)).toEqual(['midia:2 = dados.csv'])
  })

  it('anexo apagado do texto antes de enviar não é enviado', async () => {
    const { box, attach, onSend } = setup()
    fireEvent.change(box(), { target: { value: 'oi ' } })
    attach(png('x.png'))
    const thumb = await screen.findByAltText('Imagem anexada: x.png')
    act(() => {
      thumb.remove() // o que o Backspace/Delete do navegador faz com o <img>
      box().dispatchEvent(new Event('input', { bubbles: true }))
    })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('oi ', [], [], [])
  })

  it('hover na miniatura mostra a prévia ampliada (flutuante) e some ao sair', async () => {
    const { attach } = setup()
    attach(png('grande.png'))
    const thumb = await screen.findByAltText('Imagem anexada: grande.png')
    fireEvent.mouseOver(thumb)
    const tip = screen.getByRole('tooltip')
    expect(tip.textContent).toContain('midia:1')
    expect(tip.querySelector('img')?.getAttribute('src')).toBe(thumb.getAttribute('src'))
    fireEvent.mouseOut(thumb)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('teclado: o anexo encostado no cursor ganha o contorno de foco', async () => {
    const { box, attach } = setup()
    fireEvent.change(box(), { target: { value: 'a' } })
    attach(png('f.png'))
    const thumb = await screen.findByAltText('Imagem anexada: f.png')
    act(() => {
      box().focus()
      box().setSelectionRange(2, 2) // logo depois do anexo
      document.dispatchEvent(new Event('selectionchange'))
    })
    expect(thumb.hasAttribute('data-caret')).toBe(true)
    act(() => {
      box().setSelectionRange(0, 0)
      document.dispatchEvent(new Event('selectionchange'))
    })
    expect(thumb.hasAttribute('data-caret')).toBe(false)
  })
})

describe('Composer — link/caminho colado', () => {
  const paste = (el: HTMLElement, plain: string, html = ''): void => {
    fireEvent.paste(el, {
      clipboardData: { items: [], getData: (t: string) => (t === 'text/plain' ? plain : t === 'text/html' ? html : '') }
    })
  }

  it('URL de arquivo colada vira anexo NO LUGAR dela, no mesmo formato inline', async () => {
    const { box, onSend } = setup()
    fireEvent.change(box(), { target: { value: 'veja ' } })
    paste(box(), 'https://exemplo.com/planilha.xlsx')
    await screen.findByAltText(/Arquivo anexado: planilha\.xlsx/)
    fireEvent.keyDown(box(), { key: 'Enter' })
    const [text, , , refs] = onSend.mock.calls[0]
    expect(text).toBe('veja {{midia:1}}')
    expect(refs).toEqual([
      { name: 'planilha.xlsx', path: 'C:\\att\\planilha.xlsx', mediaType: 'application/vnd.ms-excel', size: 10, label: 'midia:1 = planilha.xlsx' }
    ])
  })

  it('URL comum no meio do texto continua TEXTO (nenhum link vira anexo sozinho)', () => {
    const { box, onSend } = setup()
    paste(box(), 'veja https://exemplo.com/pagina agora')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('veja https://exemplo.com/pagina agora', [], [], [])
    const api = (window as unknown as { api: { downloadPastedUrl: ReturnType<typeof vi.fn> } }).api
    expect(api.downloadPastedUrl).not.toHaveBeenCalled()
  })

  it('colar texto com formatação entra como texto puro', () => {
    const { box } = setup()
    paste(box(), 'negrito', '<b>negrito</b>')
    expect(box().value).toBe('negrito')
    expect(box().querySelector('b')).toBeNull()
  })
})

describe('Composer — regressões do campo novo', () => {
  it('Enter envia; Shift+Enter não; Enter confirmando IME (acentuação) não envia', () => {
    const { box, onSend } = setup()
    fireEvent.change(box(), { target: { value: 'ação' } })
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('ação', [], [], [])
  })

  it('@menção continua funcionando e não apaga o anexo que já está no texto', async () => {
    const { box, attach, onSend } = setup()
    fireEvent.change(box(), { target: { value: 'ver ' } })
    attach(png('p.png'))
    await screen.findByAltText('Imagem anexada: p.png')
    fireEvent.change(box(), { target: { value: `${box().value} em @app` } })
    expect(await screen.findByRole('listbox')).toBeTruthy()
    fireEvent.keyDown(box(), { key: 'Enter' }) // escolhe o item, não envia
    expect(onSend).not.toHaveBeenCalled()
    expect(box().value).toBe('ver \uFFFC em @src/app.ts ')
    expect(screen.getByAltText('Imagem anexada: p.png')).toBeTruthy()
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend.mock.calls[0][0]).toBe('ver {{midia:1}} em @src/app.ts ')
  })

  // O rascunho com anexo (agora por referência em disco) está em Composer.inlineDraft.test.tsx.
})
