import { createRef } from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { UiProvider } from '../ui/UiProvider'
import { Composer } from './Composer'
import type { EditorElement } from '../inlineMedia/InlineEditor'
import { scanStats } from '../inlineMedia/editorModel'

/**
 * Continuação do anexo inline: rascunho por referência (sem bytes), item
 * resolvendo que sobrevive à troca de conversa, formatação bloqueada, arraste
 * interno que move sem duplicar, espelho sem a data: URL e uma varredura do DOM
 * por tecla.
 */

afterEach(cleanup)

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const png = (name: string): File =>
  new File([Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0))], name, { type: 'image/png' })

type Api = Record<string, ReturnType<typeof vi.fn>>
let api: Api

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  api = {
    mentionSearch: vi.fn(async () => []),
    resolvePastedPath: vi.fn(),
    downloadPastedUrl: vi.fn(),
    readFileBytes: vi.fn(async () => ({ ok: true, base64: PNG_B64, size: 68 })),
    stashDraftAttachment: vi.fn(async (_c: string, f: { name: string }) => ({ ok: true, path: `C:\\ud\\attachments\\c1\\1-${f.name}` }))
  }
  ;(window as unknown as { api: unknown }).api = api
})

function setup(extra: { draft?: string; draftMedia?: unknown[]; convId?: string } = {}) {
  const onSend = vi.fn()
  const onDraftChange = vi.fn()
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
    fireEvent.change(r.container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files } })
  }
  const paste = (plain: string): void => {
    fireEvent.paste(box(), { clipboardData: { items: [], getData: (t: string) => (t === 'text/plain' ? plain : '') } })
  }
  return { onSend, onDraftChange, box, attach, paste, container: r.container, rerender: (c: string, d: string, m?: unknown[]) => r.rerender(ui(c, d, m)) }
}

describe('rascunho com anexo: referência em disco', () => {
  it('grava o caminho (nunca o base64), volta com a imagem e o blur seguinte não copia de novo', async () => {
    const { box, attach, onDraftChange, rerender } = setup()
    fireEvent.change(box(), { target: { value: 'olha ' } })
    attach(png('r.png'))
    await screen.findByAltText('Imagem anexada: r.png')
    fireEvent.blur(box())
    await vi.waitFor(() => expect(onDraftChange).toHaveBeenCalled())
    const [convId, text, media] = onDraftChange.mock.calls.at(-1)!
    expect([convId, text]).toEqual(['c1', 'olha {{midia:1}}'])
    expect(media).toEqual([{ kind: 'image', name: 'r.png', mediaType: 'image/png', path: 'C:\\ud\\attachments\\c1\\1-r.png', size: atob(PNG_B64).length }])
    expect(JSON.stringify(media)).not.toContain(PNG_B64)
    expect(api.stashDraftAttachment).toHaveBeenCalledWith('c1', { name: 'r.png', mediaType: 'image/png', data: PNG_B64 })

    rerender('c2', '')
    expect(screen.queryByAltText('Imagem anexada: r.png')).toBeNull()
    rerender('c1', text, media)
    expect(await screen.findByAltText('Imagem anexada: r.png')).toBeTruthy()
    expect(api.readFileBytes).toHaveBeenCalledWith('C:\\ud\\attachments\\c1\\1-r.png')
    expect(box().value).toBe('olha \uFFFC')

    onDraftChange.mockClear()
    fireEvent.blur(box())
    expect(onDraftChange).toHaveBeenCalledWith('c1', 'olha {{midia:1}}', media) // mesmo conteúdo, na hora
    expect(api.stashDraftAttachment).toHaveBeenCalledTimes(1)
  })
})

describe('trocar de conversa com item ainda resolvendo (A -> B -> A)', () => {
  const deferred = <T,>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void
    const promise = new Promise<T>((r) => (resolve = r))
    return { promise, resolve }
  }

  it('resolveu com a conversa fora da tela: o anexo aparece ao voltar', async () => {
    const d = deferred<unknown>()
    api.resolvePastedPath.mockReturnValue(d.promise)
    const { box, paste, onDraftChange, rerender, onSend } = setup()
    fireEvent.change(box(), { target: { value: 'ver ' } })
    paste('C:\\docs\\plano.pdf')
    expect(box().value).toBe('ver \uFFFC')
    rerender('c2', '') // troca: o rascunho de A leva o item resolvendo
    const [, text, media] = onDraftChange.mock.calls.at(-1)!
    expect(text).toBe('ver {{midia:1}}')
    expect(media).toEqual([expect.objectContaining({ kind: 'pending', line: 'C:\\docs\\plano.pdf' })])
    await act(async () => d.resolve({ ok: true, name: 'plano.pdf', path: 'C:\\docs\\plano.pdf', mediaType: 'application/pdf', size: 5, isImage: false }))
    rerender('c1', text, media)
    expect(await screen.findByAltText(/Arquivo anexado: plano\.pdf/)).toBeTruthy()
    expect(api.resolvePastedPath).toHaveBeenCalledTimes(1) // não resolveu de novo
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend.mock.calls[0][0]).toBe('ver {{midia:1}}')
    expect(onSend.mock.calls[0][3]).toEqual([expect.objectContaining({ path: 'C:\\docs\\plano.pdf', label: 'midia:1 = plano.pdf' })])
  })

  it('falhou fora da tela: volta o TEXTO colado no lugar, não some', async () => {
    const d = deferred<unknown>()
    api.resolvePastedPath.mockReturnValue(d.promise)
    const { box, paste, onDraftChange, rerender } = setup()
    fireEvent.change(box(), { target: { value: 'ver ' } })
    paste('C:\\docs\\sumiu.pdf')
    rerender('c2', '')
    const [, text, media] = onDraftChange.mock.calls.at(-1)!
    await act(async () => d.resolve({ ok: false, error: 'não existe' }))
    rerender('c1', text, media)
    expect(box().value).toBe('ver C:\\docs\\sumiu.pdf')
  })

  it('ainda resolvendo ao voltar: o resultado chega no item de volta ao campo', async () => {
    const d = deferred<unknown>()
    api.resolvePastedPath.mockReturnValue(d.promise)
    const { box, paste, onDraftChange, rerender, onSend } = setup()
    paste('C:\\docs\\lento.pdf')
    rerender('c2', '')
    const [, text, media] = onDraftChange.mock.calls.at(-1)!
    rerender('c1', text, media)
    expect(box().value).toBe('\uFFFC')
    await act(async () => d.resolve({ ok: true, name: 'lento.pdf', path: 'C:\\docs\\lento.pdf', mediaType: 'application/pdf', size: 5, isImage: false }))
    expect(await screen.findByAltText(/Arquivo anexado: lento\.pdf/)).toBeTruthy()
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend.mock.calls[0][0]).toBe('{{midia:1}}')
    expect(onSend.mock.calls[0][3]).toEqual([expect.objectContaining({ path: 'C:\\docs\\lento.pdf', label: 'midia:1 = lento.pdf' })])
  })
})

describe('editor: formatação, arraste interno, espelho e custo por tecla', () => {
  it('Ctrl+B/I/U (inputType format*) são recusados no beforeinput; digitar segue', () => {
    const { box } = setup()
    for (const inputType of ['formatBold', 'formatItalic', 'formatUnderline', 'formatStrikeThrough', 'formatFontColor']) {
      const ev = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true })
      box().dispatchEvent(ev)
      expect(ev.defaultPrevented).toBe(true)
    }
    const typing = new InputEvent('beforeinput', { inputType: 'insertText', data: 'a', bubbles: true, cancelable: true })
    box().dispatchEvent(typing)
    expect(typing.defaultPrevented).toBe(false)
    expect(box().querySelector('b, i, u, strong, em')).toBeNull()
  })

  it('arrastar uma seleção DENTRO do campo move o trecho com o anexo, sem duplicar', async () => {
    const { box, attach, onSend } = setup()
    fireEvent.change(box(), { target: { value: 'fim. ' } })
    attach(png('m.png'))
    await screen.findByAltText('Imagem anexada: m.png')
    fireEvent.change(box(), { target: { value: `${box().value} foto` } })
    expect(box().value).toBe('fim. \uFFFC foto')
    // seleciona "\uFFFC foto" (5..11) e solta no começo (0)
    act(() => {
      box().focus()
      box().setSelectionRange(5, 11)
    })
    fireEvent(box(), new Event('dragstart', { bubbles: true }))
    const start = document.createRange()
    start.setStart(box().firstChild!, 0)
    ;(document as unknown as { caretRangeFromPoint: () => Range }).caretRangeFromPoint = () => start
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    act(() => {
      box().dispatchEvent(drop)
    })
    expect(drop.defaultPrevented).toBe(true)
    expect(box().value).toBe('\uFFFC foto' + 'fim. ')
    expect(box().querySelectorAll('img').length).toBe(1)
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend.mock.calls[0][0]).toBe('{{midia:1}} fotofim. ')
    expect(onSend.mock.calls[0][1]).toHaveLength(1)
  })

  it('soltar dentro da própria seleção é recusado (nada muda)', () => {
    const { box } = setup()
    fireEvent.change(box(), { target: { value: 'abcdef' } })
    act(() => {
      box().focus()
      box().setSelectionRange(1, 4)
    })
    fireEvent(box(), new Event('dragstart', { bubbles: true }))
    const mid = document.createRange()
    mid.setStart(box().firstChild!, 2)
    ;(document as unknown as { caretRangeFromPoint: () => Range }).caretRangeFromPoint = () => mid
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    act(() => {
      box().dispatchEvent(drop)
    })
    expect(drop.defaultPrevented).toBe(true)
    expect(box().value).toBe('abcdef')
  })

  it('o espelho não repete a data: URL da imagem', async () => {
    const { attach, container } = setup()
    attach(png('e.png'))
    await screen.findByAltText('Imagem anexada: e.png')
    const mirror = container.querySelector('.composer-highlight img')!
    expect(mirror).toBeTruthy()
    expect(mirror.getAttribute('src') ?? '').not.toContain('base64')
  })

  it('U+200B e outros caracteres do usuário ficam; só o U+FFFC sai', () => {
    const { box, onSend } = setup()
    fireEvent.change(box(), { target: { value: 'a\u200Bb\u200Dc\uFEFFd' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend.mock.calls[0][0]).toBe('a\u200Bb\u200Dc\uFEFFd')
  })

  it('~50 KB no campo: UMA varredura do DOM por tecla (entrada + cursor)', () => {
    const big = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n'.repeat(900)
    const { box } = setup({ draft: big })
    expect(box().value.length).toBeGreaterThan(50_000)
    act(() => {
      box().focus()
      box().setSelectionRange(box().value.length, box().value.length)
    })
    const counts: number[] = []
    for (let i = 0; i < 5; i++) {
      const before = scanStats.count
      act(() => {
        const last = box().lastChild as Text
        last.data += 'x' // o que a tecla faz no DOM
        box().dispatchEvent(new Event('input', { bubbles: true }))
        document.dispatchEvent(new Event('selectionchange'))
      })
      counts.push(scanStats.count - before)
    }
    expect(counts).toEqual([1, 1, 1, 1, 1])
  })
})
