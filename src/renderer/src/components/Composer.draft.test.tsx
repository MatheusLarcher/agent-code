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
