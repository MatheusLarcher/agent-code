import { createRef } from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { UiProvider } from '../ui/UiProvider'
import { Composer } from './Composer'
import type { EditorElement } from '../inlineMedia/InlineEditor'
import { discardDraftCopies, draftCopyPaths } from '../inlineMedia/draftMedia'

/**
 * Cópias em disco do rascunho: a troca A -> B -> A com a cópia ainda sendo
 * gravada não perde a imagem; o envio reaproveita a cópia do arquivo; o que era
 * só do rascunho sai do disco; e o anexo do rascunho que sumiu é avisado.
 */

afterEach(cleanup)

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const png = (name: string): File =>
  new File([Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0))], name, { type: 'image/png' })
const csv = (name: string): File => new File(['a;b\n1;2'], name, { type: 'text/csv' })
const copyPath = (conv: string, name: string): string => `C:\\ud\\attachments\\${conv}\\rascunho\\1-1-${name}`
/** Onde a cópia fica depois do envio: a pasta da conversa, sem o `rascunho\`. */
const sentPath = (p: string): string => p.replace('\\rascunho\\', '\\')

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void }
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

type Api = Record<string, ReturnType<typeof vi.fn>>
let api: Api

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  api = {
    mentionSearch: vi.fn(async () => []),
    resolvePastedPath: vi.fn(),
    downloadPastedUrl: vi.fn(),
    readFileBytes: vi.fn(async () => ({ ok: true, base64: PNG_B64, size: 68 })),
    stashDraftAttachment: vi.fn(async (c: string, f: { name: string }) => ({ ok: true, path: copyPath(c, f.name) })),
    discardDraftAttachments: vi.fn(async () => 1),
    promoteDraftAttachments: vi.fn(async (_c: string, paths: string[]) => paths.map(sentPath))
  }
  ;(window as unknown as { api: unknown }).api = api
})

function setup(extra: { draft?: string; draftMedia?: unknown[] } = {}) {
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
    onDraftChange,
    projectMissing: false,
    projectMissingMsg: ''
  }
  const ui = (convId: string, draft: string, draftMedia?: unknown[]) => (
    <UiProvider>
      <Composer {...props} convId={convId} draft={draft} draftMedia={draftMedia} />
    </UiProvider>
  )
  const r = render(ui('c1', extra.draft ?? '', extra.draftMedia))
  const box = (): EditorElement => screen.getByPlaceholderText(/Mensagem para o Claude/) as EditorElement
  const attach = (...files: File[]): void => {
    fireEvent.change(r.container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files } })
  }
  const discarded = (): string[] => api.discardDraftAttachments.mock.calls.flatMap((c) => c[1] as string[])
  return { onSend, onDraftChange, box, attach, discarded, rerender: (c: string, d: string, m?: unknown[]) => r.rerender(ui(c, d, m)) }
}

describe('A -> B -> A com a cópia em disco ainda gravando', () => {
  it('ao voltar, o campo tem a imagem; o save tardio chega e o blur seguinte não copia de novo', async () => {
    const d = deferred<unknown>()
    api.stashDraftAttachment.mockReturnValueOnce(d.promise)
    const { box, attach, onDraftChange, rerender, onSend } = setup()
    fireEvent.change(box(), { target: { value: 'veja ' } })
    attach(png('tela.png'))
    await screen.findByAltText('Imagem anexada: tela.png')

    rerender('c2', '') // flush de A fica esperando a cópia
    expect(onDraftChange.mock.calls.filter((c) => c[0] === 'c1')).toEqual([])
    rerender('c1', '') // volta ANTES da cópia terminar: o rascunho gravado ainda é o velho ('')
    expect(box().value).toBe('veja \uFFFC')
    expect(screen.getByAltText('Imagem anexada: tela.png')).toBeTruthy()

    await act(async () => d.resolve({ ok: true, path: copyPath('c1', 'tela.png') }))
    const media = [{ kind: 'image', name: 'tela.png', mediaType: 'image/png', path: copyPath('c1', 'tela.png'), size: atob(PNG_B64).length }]
    expect(onDraftChange).toHaveBeenLastCalledWith('c1', 'veja {{midia:1}}', media)
    expect(screen.getByAltText('Imagem anexada: tela.png')).toBeTruthy()

    onDraftChange.mockClear()
    fireEvent.blur(box())
    expect(onDraftChange).toHaveBeenCalledWith('c1', 'veja {{midia:1}}', media)
    expect(api.stashDraftAttachment).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend.mock.calls[0][0]).toBe('veja {{midia:1}}')
    expect(onSend.mock.calls[0][1]).toEqual([{ mediaType: 'image/png', data: PNG_B64, label: 'midia:1 = tela.png' }])
  })

  it('a cópia falha com a conversa fora da tela: ao voltar a imagem continua no campo e há aviso', async () => {
    const d = deferred<unknown>()
    api.stashDraftAttachment.mockReturnValueOnce(d.promise)
    const { box, attach, rerender } = setup()
    attach(png('x.png'))
    await screen.findByAltText('Imagem anexada: x.png')
    rerender('c2', '')
    rerender('c1', '')
    await act(async () => d.resolve({ ok: false, error: 'disco cheio' }))
    expect(box().value).toBe('\uFFFC')
    expect(await screen.findByText(/Não consegui guardar no rascunho: x\.png/)).toBeTruthy()
  })
})

describe('cópias do rascunho: reaproveitadas no envio, apagadas quando eram só do rascunho', () => {
  it('arquivo: o envio leva o caminho da pasta do ENVIO, pede ao main para mover a cópia e nunca a descarta', async () => {
    const { box, attach, onSend, discarded } = setup()
    fireEvent.change(box(), { target: { value: 'dados ' } })
    attach(csv('planilha.csv'))
    await screen.findByAltText(/Arquivo anexado: planilha\.csv/)
    fireEvent.blur(box()) // rascunho: a cópia é feita aqui
    await vi.waitFor(() => expect(api.stashDraftAttachment).toHaveBeenCalledTimes(1))
    await act(async () => {})
    fireEvent.keyDown(box(), { key: 'Enter' })
    const [text, images, files, fileRefs] = onSend.mock.calls[0]
    expect(text).toBe('dados {{midia:1}}')
    expect(images).toEqual([])
    expect(files).toEqual([]) // nada de bytes: main não grava outra cópia
    const sent = sentPath(copyPath('c1', 'planilha.csv'))
    expect(fileRefs).toEqual([{ name: 'planilha.csv', path: sent, mediaType: 'text/csv', size: 7, label: 'midia:1 = planilha.csv' }])
    expect(api.promoteDraftAttachments).toHaveBeenCalledWith('c1', [copyPath('c1', 'planilha.csv')])
    // o campo limpo depois do envio não pede o descarte do que saiu na mensagem
    fireEvent.change(box(), { target: { value: 'outra' } })
    fireEvent.blur(box())
    await act(async () => {})
    expect(discarded()).toEqual([])
    // o caminho do envio nem é candidato a descarte (não está em rascunho\)
    discardDraftCopies([sent])
    expect(api.discardDraftAttachments).not.toHaveBeenCalled()
  })

  it('notes.md sem tipo: vai para a cópia com o nome original e o envio leva …-notes.md', async () => {
    api.stashDraftAttachment.mockImplementation(async (c: string, f: { name: string }) => ({ ok: true, path: copyPath(c, f.name) }))
    const { box, attach, onSend } = setup()
    attach(new File(['# notas'], 'notes.md', { type: '' }))
    await screen.findByAltText(/Arquivo anexado: notes\.md/)
    fireEvent.blur(box())
    await vi.waitFor(() => expect(api.stashDraftAttachment).toHaveBeenCalledTimes(1))
    expect(api.stashDraftAttachment.mock.calls[0][1]).toMatchObject({ name: 'notes.md', mediaType: 'application/octet-stream' })
    await act(async () => {})
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend.mock.calls[0][3][0].path).toBe('C:\\ud\\attachments\\c1\\1-1-notes.md')
  })

  it('imagem enviada: a cópia do rascunho sai do disco (a mensagem leva os bytes)', async () => {
    const { box, attach, onSend, discarded } = setup()
    attach(png('foto.png'))
    await screen.findByAltText('Imagem anexada: foto.png')
    fireEvent.blur(box())
    await vi.waitFor(() => expect(api.stashDraftAttachment).toHaveBeenCalledTimes(1))
    await act(async () => {})
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend.mock.calls[0][1]).toHaveLength(1)
    await act(async () => {})
    expect(api.discardDraftAttachments).toHaveBeenCalledWith('c1', [copyPath('c1', 'foto.png')])
    expect(discarded()).toEqual([copyPath('c1', 'foto.png')])
  })

  it('item removido do campo: a cópia dele sai no próximo flush; a do item que ficou, não', async () => {
    const { box, attach, discarded } = setup()
    attach(png('fica.png'), png('sai.png'))
    await screen.findByAltText('Imagem anexada: sai.png')
    fireEvent.blur(box())
    await vi.waitFor(() => expect(api.stashDraftAttachment).toHaveBeenCalledTimes(2))
    await act(async () => {})
    // apaga o segundo anexo (o último U+FFFC)
    fireEvent.change(box(), { target: { value: box().value.slice(0, -1) } })
    fireEvent.blur(box())
    await act(async () => {})
    expect(discarded()).toEqual([copyPath('c1', 'sai.png')])
  })

  it('campo limpo: todas as cópias do rascunho saem', async () => {
    const { box, attach, discarded, onDraftChange } = setup()
    attach(png('a.png'), csv('b.csv'))
    await screen.findByAltText(/Arquivo anexado: b\.csv/)
    fireEvent.blur(box())
    await vi.waitFor(() => expect(api.stashDraftAttachment).toHaveBeenCalledTimes(2))
    await act(async () => {})
    fireEvent.change(box(), { target: { value: '' } })
    fireEvent.blur(box())
    await act(async () => {})
    expect(discarded().sort()).toEqual([copyPath('c1', 'a.png'), copyPath('c1', 'b.csv')].sort())
    expect(onDraftChange).toHaveBeenLastCalledWith('c1', '')
  })

  it('removido enquanto a cópia ainda gravava: a cópia é apagada quando termina', async () => {
    const d = deferred<unknown>()
    api.stashDraftAttachment.mockReturnValueOnce(d.promise)
    const { box, attach, discarded } = setup()
    attach(png('lento.png'))
    await screen.findByAltText('Imagem anexada: lento.png')
    fireEvent.blur(box()) // cópia começa
    fireEvent.change(box(), { target: { value: '' } })
    fireEvent.blur(box()) // item já fora do campo
    await act(async () => d.resolve({ ok: true, path: copyPath('c1', 'lento.png') }))
    expect(discarded()).toContain(copyPath('c1', 'lento.png'))
  })

  it('conversa apagada: as cópias do rascunho dela são pedidas para descarte (o caminho colado, nunca)', () => {
    const media = [
      { kind: 'image', name: 'a.png', mediaType: 'image/png', path: copyPath('c7', 'a.png'), size: 1 },
      { kind: 'file', name: 'b.csv', mediaType: 'text/csv', path: copyPath('c7', 'b.csv'), size: 1 },
      { kind: 'ref', name: 'meu.pdf', mediaType: 'application/pdf', path: 'C:\\Users\\eu\\meu.pdf', size: 1 },
      { kind: 'pending', id: 'p1', name: 'x' }
    ]
    expect(draftCopyPaths(media)).toEqual([copyPath('c7', 'a.png'), copyPath('c7', 'b.csv')])
    discardDraftCopies(draftCopyPaths(media))
    expect(api.discardDraftAttachments).toHaveBeenCalledWith('c7', [copyPath('c7', 'a.png'), copyPath('c7', 'b.csv')])
  })
})

describe('anexo do rascunho que sumiu do disco', () => {
  it('caminho colado (ref) que não existe mais: aviso e o item sai; o texto em volta fica', async () => {
    api.resolvePastedPath.mockResolvedValue({ ok: false, error: 'Arquivo não encontrado nesse caminho.' })
    const { box, onSend } = setup({
      draft: 'ver {{midia:1}} agora',
      draftMedia: [{ kind: 'ref', name: 'plano.pdf', mediaType: 'application/pdf', path: 'C:\\docs\\plano.pdf', size: 5 }]
    })
    expect(await screen.findByText(/Anexo do rascunho não encontrado \(plano\.pdf\)/)).toBeTruthy()
    expect(api.resolvePastedPath).toHaveBeenCalledWith('C:\\docs\\plano.pdf')
    expect(box().value).toBe('ver  agora')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend.mock.calls[0][3]).toEqual([]) // nenhum caminho morto vai ao agente
  })

  it('cópia do arquivo (file) que sumiu: aviso e o item sai', async () => {
    api.readFileBytes.mockResolvedValue({ ok: false, error: 'ENOENT' })
    const { box } = setup({
      draft: '{{midia:1}}',
      draftMedia: [{ kind: 'file', name: 'r.csv', mediaType: 'text/csv', path: copyPath('c1', 'r.csv'), size: 3 }]
    })
    expect(await screen.findByText(/Anexo do rascunho não encontrado \(r\.csv\)/)).toBeTruthy()
    expect(box().value).toBe('')
  })

  it('ref e file que existem voltam prontos; o envio leva os caminhos', async () => {
    api.resolvePastedPath.mockResolvedValue({ ok: true, name: 'plano.pdf', path: 'C:\\docs\\plano.pdf', mediaType: 'application/pdf', size: 5, isImage: false })
    api.readFileBytes.mockResolvedValue({ ok: true, base64: btoa('a;b'), size: 3 })
    const { box, onSend } = setup({
      draft: '{{midia:1}} e {{midia:2}}',
      draftMedia: [
        { kind: 'ref', name: 'plano.pdf', mediaType: 'application/pdf', path: 'C:\\docs\\plano.pdf', size: 5 },
        { kind: 'file', name: 'r.csv', mediaType: 'text/csv', path: copyPath('c1', 'r.csv'), size: 3 }
      ]
    })
    await screen.findByAltText(/Arquivo anexado: plano\.pdf/)
    await screen.findByAltText(/Arquivo anexado: r\.csv/)
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend.mock.calls[0][2]).toEqual([])
    expect(onSend.mock.calls[0][3].map((f: { path: string }) => f.path)).toEqual(['C:\\docs\\plano.pdf', sentPath(copyPath('c1', 'r.csv'))])
    expect(api.promoteDraftAttachments).toHaveBeenCalledWith('c1', [copyPath('c1', 'r.csv')])
  })
})
