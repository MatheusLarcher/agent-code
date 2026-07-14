import { createRef } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { FileAttachment, FileRefAttachment, ImageAttachment } from '@shared/ipc'
import { UiProvider } from '../ui/UiProvider'
import { Composer } from './Composer'

afterEach(cleanup)

type DraftChangeFn = (convId: string, text: string) => void
type SendFn = (
  text: string,
  images: ImageAttachment[],
  files: FileAttachment[],
  fileRefs: FileRefAttachment[]
) => void

function renderComposer(props: { convId?: string | null; draft?: string } = {}): {
  onDraftChange: ReturnType<typeof vi.fn<DraftChangeFn>>
  onSend: ReturnType<typeof vi.fn<SendFn>>
  rerender: (convId: string | null, draft: string) => void
} {
  const onDraftChange = vi.fn<DraftChangeFn>()
  const onSend = vi.fn<SendFn>()
  const base = {
    disabled: false,
    busy: false,
    chips: [],
    onRemoveChip: () => {},
    onSend,
    onInterrupt: () => {},
    textareaRef: createRef<HTMLTextAreaElement>(),
    projects: [],
    projectRoot: null,
    voiceReady: false,
    onNeedVoiceKey: () => {},
    draft: props.draft ?? '',
    onDraftChange,
    projectMissing: false,
    projectMissingMsg: ''
  }
  const { rerender: rtlRerender } = render(
    <UiProvider>
      <Composer {...base} convId={props.convId ?? 'c1'} />
    </UiProvider>
  )
  return {
    onDraftChange,
    onSend,
    rerender: (convId, draft) =>
      rtlRerender(
        <UiProvider>
          <Composer {...base} draft={draft} convId={convId} />
        </UiProvider>
      )
  }
}

function textarea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(/Mensagem para o Claude/) as HTMLTextAreaElement
}

describe('Composer — rascunho só salva ao perder o foco (não a cada tecla)', () => {
  it('digitar SEM perder o foco não chama onDraftChange nenhuma vez', () => {
    const { onDraftChange } = renderComposer()
    fireEvent.change(textarea(), { target: { value: 'oi' } })
    fireEvent.change(textarea(), { target: { value: 'oi tudo' } })
    fireEvent.change(textarea(), { target: { value: 'oi tudo bem' } })
    expect(textarea().value).toBe('oi tudo bem') // a caixa responde na hora (local)
    expect(onDraftChange).not.toHaveBeenCalled()
  })

  it('perder o foco (blur) salva o texto atual, com o convId certo', () => {
    const { onDraftChange } = renderComposer({ convId: 'c1' })
    fireEvent.change(textarea(), { target: { value: 'rascunho não salvo' } })
    expect(onDraftChange).not.toHaveBeenCalled()
    fireEvent.blur(textarea())
    expect(onDraftChange).toHaveBeenCalledTimes(1)
    expect(onDraftChange).toHaveBeenCalledWith('c1', 'rascunho não salvo')
  })

  it('trocar de conversa com texto não salvo: salva o texto na conversa ANTIGA (não na nova)', () => {
    const { onDraftChange, rerender } = renderComposer({ convId: 'c1', draft: '' })
    fireEvent.change(textarea(), { target: { value: 'texto da conversa 1' } })
    expect(onDraftChange).not.toHaveBeenCalled()
    // Troca pra c2 SEM blur (ex.: clique num item da sidebar) — a conversa muda por prop.
    rerender('c2', 'rascunho salvo da conversa 2')
    expect(onDraftChange).toHaveBeenCalledTimes(1)
    expect(onDraftChange).toHaveBeenCalledWith('c1', 'texto da conversa 1')
    // A caixa agora mostra o draft da NOVA conversa.
    expect(textarea().value).toBe('rascunho salvo da conversa 2')
  })

  it('enviar mensagem limpa a caixa E salva o draft vazio (não ressuscita o texto enviado)', () => {
    const { onDraftChange, onSend } = renderComposer({ convId: 'c1' })
    fireEvent.change(textarea(), { target: { value: 'mensagem pronta' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('mensagem pronta', [], [], [])
    expect(textarea().value).toBe('')
    expect(onDraftChange).toHaveBeenCalledWith('c1', '')
  })

  it('a janela perder o foco (alt-tab) também salva o texto pendente', () => {
    const { onDraftChange } = renderComposer({ convId: 'c1' })
    fireEvent.change(textarea(), { target: { value: 'digitando e troquei de janela' } })
    expect(onDraftChange).not.toHaveBeenCalled()
    fireEvent(window, new Event('blur'))
    expect(onDraftChange).toHaveBeenCalledWith('c1', 'digitando e troquei de janela')
  })
})

describe('Composer — anexo por caminho/link colado não vaza entre conversas', () => {
  // window.api is only wired up by preload in the real app; these tests stub
  // just what Composer calls during a paste resolution.
  function stubApi(resolveDelayMs: number): void {
    ;(window as unknown as { api: unknown }).api = {
      resolvePastedPath: vi.fn(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  ok: true,
                  name: 'arquivo.txt',
                  path: 'C:\\pasta\\arquivo.txt',
                  mediaType: 'text/plain',
                  size: 10,
                  isImage: false
                }),
              resolveDelayMs
            )
          )
      )
    }
  }

  function paste(line: string): void {
    const clipboardData = {
      items: [] as { kind: string }[],
      getData: (type: string) => (type === 'text/plain' ? line : '')
    }
    fireEvent.paste(textarea(), { clipboardData })
  }

  it('resolução que termina DEPOIS de trocar de conversa não aparece na conversa nova', async () => {
    stubApi(50) // resolve depois do próximo microtask/tick, dando tempo de trocar de conversa
    const { rerender } = renderComposer({ convId: 'c1' })
    paste('C:\\pasta\\arquivo.txt')
    expect(await screen.findByText(/Resolvendo/)).toBeTruthy()

    // Troca pra c2 ANTES da Promise de resolvePastedPath terminar.
    rerender('c2', '')

    await new Promise((r) => setTimeout(r, 80)) // espera a resolução (tardia) terminar
    expect(screen.queryByText('arquivo.txt')).toBeNull() // não vazou pra c2
  })
})

/** A real File whose reported `.size` is overridden (jsdom won't let us
 *  actually allocate gigabytes of blob content just to test the size check). */
function bigFile(name: string, sizeBytes: number, type = 'application/octet-stream'): File {
  const f = new File(['conteudo pequeno de verdade'], name, { type })
  Object.defineProperty(f, 'size', { value: sizeBytes })
  return f
}

describe('Composer — arquivo real grande (>25MB) colado/arrastado/anexado', () => {
  function stubApi(opts: {
    path: string | null
    resolved?: { ok: true; name: string; path: string; mediaType: string; size: number; isImage: boolean } | { ok: false; error: string }
    bytes?: { ok: true; base64: string; size: number } | { ok: false; error: string }
  }): { getPathForFile: ReturnType<typeof vi.fn>; resolvePastedPath: ReturnType<typeof vi.fn>; readFileBytes: ReturnType<typeof vi.fn> } {
    const getPathForFile = vi.fn(() => opts.path ?? '')
    const resolvePastedPath = vi.fn(async () => opts.resolved ?? { ok: false, error: 'não usado' })
    const readFileBytes = vi.fn(async () => opts.bytes ?? { ok: false, error: 'não usado' })
    ;(window as unknown as { api: unknown }).api = { getPathForFile, resolvePastedPath, readFileBytes }
    return { getPathForFile, resolvePastedPath, readFileBytes }
  }

  function pasteFile(file: File): void {
    const clipboardData = {
      items: [{ kind: 'file', getAsFile: () => file }],
      getData: () => ''
    }
    fireEvent.paste(textarea(), { clipboardData })
  }

  it('arquivo >25MB com caminho real vira FileRefAttachment (sem base64) ao enviar', async () => {
    stubApi({
      path: 'C:\\pasta\\video.mp4',
      resolved: { ok: true, name: 'video.mp4', path: 'C:\\pasta\\video.mp4', mediaType: 'video/mp4', size: 5_000_000_000, isImage: false }
    })
    const { onSend } = renderComposer({ convId: 'c1' })
    pasteFile(bigFile('video.mp4', 5_000_000_000, 'video/mp4'))
    await screen.findByText('video.mp4') // chip aparece

    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('', [], [], [
      { name: 'video.mp4', path: 'C:\\pasta\\video.mp4', mediaType: 'video/mp4', size: 5_000_000_000 }
    ])
  })

  it('arquivo >25MB SEM caminho resolvível (blob puro) mostra erro e não vira anexo', async () => {
    stubApi({ path: '' })
    renderComposer({ convId: 'c1' })
    pasteFile(bigFile('sem-path.bin', 30_000_000))
    expect(await screen.findByText(/precisa ter um caminho no disco/)).toBeTruthy()
    expect(screen.queryByText('sem-path.bin')).toBeNull()
  })

  it('getPathForFile lançando exceção não trava resolvingCount (envio continua liberado)', async () => {
    // webUtils.getPathForFile documenta que lança se o argumento não for um
    // File de verdade — confirma que isso é tratado como "sem caminho" em vez
    // de rejeitar a Promise e pular o decremento de resolvingCount.
    ;(window as unknown as { api: unknown }).api = {
      getPathForFile: vi.fn(() => {
        throw new Error('not a File')
      }),
      resolvePastedPath: vi.fn(),
      readFileBytes: vi.fn()
    }
    renderComposer({ convId: 'c1' })
    pasteFile(bigFile('estranho.bin', 30_000_000))
    expect(await screen.findByText(/precisa ter um caminho no disco/)).toBeTruthy()
    // resolvingCount voltou a 0 — o envio não fica travado pra sempre.
    expect(screen.queryByText(/Resolvendo/)).toBeNull()
    const sendBtn = document.querySelector('button.btn.send') as HTMLButtonElement
    expect(sendBtn.disabled).toBe(false)
  })

  it('imagem >25MB e ≤50MB com caminho vira preview real (não chip)', async () => {
    stubApi({
      path: 'C:\\fotos\\grande.png',
      resolved: { ok: true, name: 'grande.png', path: 'C:\\fotos\\grande.png', mediaType: 'image/png', size: 40_000_000, isImage: true },
      bytes: { ok: true, base64: 'ZmFrZS1wbmc=', size: 40_000_000 }
    })
    renderComposer({ convId: 'c1' })
    pasteFile(bigFile('grande.png', 40_000_000, 'image/png'))
    await screen.findByAltText('anexo') // <img> de preview real
    expect(screen.queryByText('grande.png')).toBeNull() // não é um chip
  })

  it('imagem >50MB vira chip genérico (não tenta ler bytes)', async () => {
    const { readFileBytes } = stubApi({
      path: 'C:\\fotos\\gigante.png',
      resolved: { ok: true, name: 'gigante.png', path: 'C:\\fotos\\gigante.png', mediaType: 'image/png', size: 90_000_000, isImage: true }
    })
    renderComposer({ convId: 'c1' })
    pasteFile(bigFile('gigante.png', 90_000_000, 'image/png'))
    await screen.findByText('gigante.png') // chip, não preview
    expect(readFileBytes).not.toHaveBeenCalled()
  })

  it('arquivo PEQUENO (≤25MB) não chama getPathForFile — fluxo antigo intacto', async () => {
    const { getPathForFile } = stubApi({ path: 'C:\\nao-deveria-usar.txt' })
    renderComposer({ convId: 'c1' })
    pasteFile(bigFile('pequeno.txt', 1000, 'text/plain'))
    await screen.findByText('pequeno.txt')
    expect(getPathForFile).not.toHaveBeenCalled()
  })

  it('resolução de arquivo grande que termina depois de trocar de conversa não vaza', async () => {
    const getPathForFile = vi.fn(() => 'C:\\pasta\\lento.bin')
    const resolvePastedPath = vi.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ ok: true, name: 'lento.bin', path: 'C:\\pasta\\lento.bin', mediaType: 'application/octet-stream', size: 30_000_000, isImage: false }),
            50
          )
        )
    )
    ;(window as unknown as { api: unknown }).api = { getPathForFile, resolvePastedPath, readFileBytes: vi.fn() }
    const { rerender } = renderComposer({ convId: 'c1' })
    pasteFile(bigFile('lento.bin', 30_000_000))
    expect(await screen.findByText(/Resolvendo/)).toBeTruthy()

    rerender('c2', '') // troca ANTES da resolução terminar

    await new Promise((r) => setTimeout(r, 80))
    expect(screen.queryByText('lento.bin')).toBeNull() // não vazou pra c2
  })
})
