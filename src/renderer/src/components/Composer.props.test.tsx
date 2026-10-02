import { createRef } from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { FileAttachment, FileRefAttachment, ImageAttachment } from '@shared/ipc'
import { UiProvider } from '../ui/UiProvider'
import { CODE_REVIEW_PROMPT, Composer } from './Composer'
import type { EditorElement } from '../inlineMedia/InlineEditor'

/**
 * As props opcionais do Composer (a Central usa as três): placeholder próprio,
 * escudo de revisão escondido e `beforeSend`, que recusa um envio sem limpar o
 * campo. Sem elas, o Composer é o de sempre.
 */

afterEach(cleanup)

type SendFn = (text: string, images: ImageAttachment[], files: FileAttachment[], fileRefs: FileRefAttachment[]) => void
type DraftFn = (convId: string, text: string, media?: unknown[]) => void
interface Options {
  placeholder?: string
  hideCodeReview?: boolean
  beforeSend?: () => boolean
  disabled?: boolean
}

const DEFAULT_PLACEHOLDER = 'Mensagem para o Claude…  (Enter envia, Shift+Enter quebra linha)'
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const png = (name: string): File =>
  new File([Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0))], name, { type: 'image/png' })

let listSkills: ReturnType<typeof vi.fn>
beforeEach(() => {
  // jsdom não tem scrollIntoView (o menu "/" rola até o item ativo).
  Element.prototype.scrollIntoView = vi.fn()
  listSkills = vi.fn(async () => [{ name: 'planejar', description: 'Planeja antes de codar' }])
  ;(window as unknown as { api: unknown }).api = {
    mentionSearch: vi.fn(async () => []),
    listSkills,
    resolvePastedPath: vi.fn(),
    downloadPastedUrl: vi.fn(),
    readFileBytes: vi.fn()
  }
})

/** `opts` só leva as props que o teste dá: sem nada, é o Composer de sempre. */
function setup(opts: Options = {}) {
  const onSend = vi.fn<SendFn>()
  const onDraftChange = vi.fn<DraftFn>()
  const r = render(
    <UiProvider>
      <Composer
        disabled={false}
        busy={false}
        chips={[]}
        onChipsConsumed={() => {}}
        onSend={onSend}
        onInterrupt={() => {}}
        textareaRef={createRef<HTMLElement>()}
        projects={[]}
        projectRoot={null}
        convId="c1"
        draft=""
        onDraftChange={onDraftChange}
        projectMissing={false}
        projectMissingMsg=""
        {...opts}
      />
    </UiProvider>
  )
  const box = (): EditorElement => screen.getByRole('textbox', { name: 'Mensagem' }) as EditorElement
  const attach = (...files: File[]): void => {
    fireEvent.change(r.container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files } })
  }
  const sendButton = (): HTMLButtonElement => r.container.querySelector('button.btn.send') as HTMLButtonElement
  // A miniatura entra no DOM (refreshToken) antes de o Composer re-renderizar sem
  // "resolvendo"; sob carga, um Enter nesse meio cairia no envio ainda bloqueado.
  const attached = async (alt: string): Promise<void> => {
    await screen.findByAltText(alt)
    await waitFor(() => expect(sendButton().disabled).toBe(false))
  }
  const shield = (): HTMLElement | null => screen.queryByTitle(/Revisar código/)
  const mirror = (): string | null | undefined => r.container.querySelector('.composer-placeholder')?.textContent
  return { onSend, onDraftChange, box, attach, attached, sendButton, shield, mirror }
}

describe('Composer — sem as props novas, nada muda', () => {
  it('placeholder padrão, escudo que manda o pedido de revisão, e Enter envia e limpa o campo', () => {
    const { box, shield, mirror, onSend, onDraftChange } = setup()
    expect(box().getAttribute('aria-placeholder')).toBe(DEFAULT_PLACEHOLDER)
    expect(mirror()).toBe(DEFAULT_PLACEHOLDER)
    fireEvent.click(shield()!)
    expect(onSend).toHaveBeenLastCalledWith(CODE_REVIEW_PROMPT, [], [], [], [])
    fireEvent.change(box(), { target: { value: 'oi' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).toHaveBeenLastCalledWith('oi', [], [], [], [])
    expect(box().value).toBe('')
    expect(onDraftChange).toHaveBeenCalledWith('c1', '')
  })
})

describe('Composer — placeholder e escudo', () => {
  it('`placeholder` troca o texto padrão do campo vazio (no campo e no espelho)', () => {
    const { box, mirror } = setup({ placeholder: 'Fale com o agent…' })
    expect(screen.getByPlaceholderText('Fale com o agent…')).toBe(box())
    expect(box().getAttribute('aria-placeholder')).toBe('Fale com o agent…')
    expect(mirror()).toBe('Fale com o agent…')
  })

  it('o aviso de sem sessão continua valendo por cima do `placeholder`', () => {
    const { box } = setup({ placeholder: 'Fale com o agent…', disabled: true })
    expect(box().getAttribute('aria-placeholder')).toBe('Inicie uma sessão primeiro…')
  })

  it('`hideCodeReview` esconde o escudo; anexar e enviar continuam na linha', () => {
    const { shield, sendButton } = setup({ hideCodeReview: true })
    expect(shield()).toBeNull()
    expect(sendButton()).toBeTruthy()
    expect(screen.getByTitle(/Anexar arquivo/)).toBeTruthy()
  })
})

describe('Composer — beforeSend', () => {
  it('false no Enter: onSend não é chamado e texto + anexo ficam no campo (o rascunho não é zerado)', async () => {
    const beforeSend = vi.fn(() => false)
    const { box, attach, attached, onSend, onDraftChange } = setup({ beforeSend })
    fireEvent.change(box(), { target: { value: 'veja ' } })
    attach(png('tela.png'))
    await attached('Imagem anexada: tela.png')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(beforeSend).toHaveBeenCalledTimes(1)
    expect(onSend).not.toHaveBeenCalled()
    expect(box().value).toBe('veja ￼')
    expect(screen.getByAltText('Imagem anexada: tela.png')).toBeTruthy()
    expect(onDraftChange).not.toHaveBeenCalledWith('c1', '')
  })

  it('false no botão de enviar e no escudo: nada sai e o campo fica como estava', () => {
    const beforeSend = vi.fn(() => false)
    const { box, sendButton, shield, onSend } = setup({ beforeSend })
    fireEvent.change(box(), { target: { value: 'deixa mais escuro' } })
    fireEvent.click(sendButton())
    fireEvent.click(shield()!)
    expect(beforeSend).toHaveBeenCalledTimes(2)
    expect(onSend).not.toHaveBeenCalled()
    expect(box().value).toBe('deixa mais escuro')
  })

  it('true: envia como sempre e limpa o campo; o que ficou retido antes sai inteiro (texto + anexo)', async () => {
    let allow = false
    const beforeSend = vi.fn(() => allow)
    const { box, attach, attached, onSend } = setup({ beforeSend })
    fireEvent.change(box(), { target: { value: 'veja ' } })
    attach(png('tela.png'))
    await attached('Imagem anexada: tela.png')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    allow = true
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(beforeSend).toHaveBeenCalledTimes(2)
    expect(onSend).toHaveBeenCalledWith(
      'veja {{midia:1}}',
      [{ mediaType: 'image/png', data: PNG_B64, label: 'midia:1 = tela.png' }],
      [],
      [],
      []
    )
    expect(box().value).toBe('')
  })

  it('true no escudo: manda o pedido de revisão como sempre', () => {
    const { shield, onSend } = setup({ beforeSend: () => true })
    fireEvent.click(shield()!)
    expect(onSend).toHaveBeenCalledWith(CODE_REVIEW_PROMPT, [], [], [], [])
  })

  it('só roda no envio: campo vazio e Enter que escolhe item do menu "/" não o chamam', async () => {
    const beforeSend = vi.fn(() => false)
    const { box, sendButton, onSend } = setup({ beforeSend })
    fireEvent.keyDown(box(), { key: 'Enter' })
    fireEvent.click(sendButton())
    fireEvent.change(box(), { target: { value: '/plan' } })
    expect(await screen.findByRole('listbox')).toBeTruthy()
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(box().value).toBe('/planejar ')
    expect(beforeSend).not.toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
  })
})
