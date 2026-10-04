import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CENTRAL_ID } from '@shared/central'
import { UiProvider } from '../ui/UiProvider'
import type { EditorElement } from '../inlineMedia/InlineEditor'
import type { Conversation } from '../types'
import { CentralPanel } from './CentralPanel'
import { fakeController } from './centralFakeController'

/**
 * O campo da Central: o Composer do chat com o placeholder dela, sem o escudo
 * de revisão, e o gate do TypeSafe pelo `beforeSend` — sem TypeSafe nada sai e
 * o texto e os anexos ficam no campo, qualquer que seja o caminho do envio.
 */

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const png = (name: string): File =>
  new File([Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0))], name, { type: 'image/png' })

const central = (): Conversation =>
  ({
    id: CENTRAL_ID,
    title: 'Central',
    titleSource: 'user',
    cwd: '',
    mode: 'central',
    central: { entries: [] },
    model: 'claude-opus-4-8',
    sdkSessionId: null,
    messages: [],
    tokens: { context: 0, output: 0, cost: 0 },
    createdAt: 1,
    updatedAt: 1
  }) as Conversation

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  ;(window as unknown as { api: unknown }).api = {
    mentionSearch: vi.fn(async () => []),
    resolvePastedPath: vi.fn(),
    downloadPastedUrl: vi.fn(),
    readFileBytes: vi.fn()
  }
})
afterEach(cleanup)

function setup(ready: boolean) {
  const onSend = vi.fn()
  const onNeedTypesafe = vi.fn()
  const r = render(
    <UiProvider>
      <CentralPanel
        conversation={central()}
        controller={fakeController()}
        ready={ready}
        onNeedTypesafe={onNeedTypesafe}
        onSend={onSend}
        onDraftChange={vi.fn()}
        composerRef={createRef<HTMLElement>()}
        projects={[]}
      />
    </UiProvider>
  )
  const box = (): EditorElement => screen.getByRole('textbox', { name: 'Mensagem' }) as EditorElement
  const attach = (...files: File[]): void => {
    fireEvent.change(r.container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files } })
  }
  const sendButton = (): HTMLButtonElement => r.container.querySelector('button.btn.send') as HTMLButtonElement
  // A miniatura entra no DOM antes de o Composer re-renderizar sem "resolvendo":
  // espera o botão de enviar liberar (sob carga, o Enter cairia no envio bloqueado).
  const attached = async (alt: string): Promise<void> => {
    await screen.findByAltText(alt)
    await waitFor(() => expect(sendButton().disabled).toBe(false))
  }
  return { onSend, onNeedTypesafe, box, attach, attached, sendButton, container: r.container }
}

describe('CentralPanel — campo', () => {
  it('placeholder "Fale com o agent…", sem o escudo de revisão, com a dica do destino', () => {
    const { box, container } = setup(true)
    expect(screen.getByPlaceholderText('Fale com o agent…')).toBe(box())
    expect(screen.queryByTitle(/Revisar código/)).toBeNull()
    expect(screen.getByText('o destino é escolhido pelo assunto').classList.contains('central-hint')).toBe(true)
    // O chat flutuante do Escritório esconde partes do cabeçalho por estas classes.
    expect(container.querySelector('.central-head > .central-orb')).not.toBeNull()
    expect(container.querySelector('.central-head > h1')?.textContent).toBe('Central')
  })
})

describe('CentralPanel — gate do TypeSafe pelo beforeSend', () => {
  it('sem TypeSafe, Enter roda o gate e não envia: texto e anexo ficam no campo', async () => {
    const { box, attach, attached, onSend, onNeedTypesafe } = setup(false)
    fireEvent.change(box(), { target: { value: 'deixa mais escuro ' } })
    attach(png('tela.png'))
    await attached('Imagem anexada: tela.png')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onNeedTypesafe).toHaveBeenCalledTimes(1)
    expect(onSend).not.toHaveBeenCalled()
    expect(box().value).toBe('deixa mais escuro ￼')
    expect(screen.getByAltText('Imagem anexada: tela.png')).toBeTruthy()
  })

  it('sem TypeSafe, o botão de enviar também passa pelo gate e o texto fica', () => {
    const { box, sendButton, onSend, onNeedTypesafe } = setup(false)
    fireEvent.change(box(), { target: { value: 'o botão ficou torto' } })
    fireEvent.click(sendButton())
    expect(onNeedTypesafe).toHaveBeenCalledTimes(1)
    expect(onSend).not.toHaveBeenCalled()
    expect(box().value).toBe('o botão ficou torto')
  })

  it('com TypeSafe, envia com as miniaturas e limpa o campo, sem gate', async () => {
    const { box, attach, attached, onSend, onNeedTypesafe } = setup(true)
    fireEvent.change(box(), { target: { value: 'veja ' } })
    attach(png('tela.png'))
    await attached('Imagem anexada: tela.png')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith(
      'veja {{midia:1}}',
      [{ mediaType: 'image/png', data: PNG_B64, label: 'midia:1 = tela.png' }],
      [`data:image/png;base64,${PNG_B64}`],
      [],
      []
    )
    expect(onNeedTypesafe).not.toHaveBeenCalled()
    expect(box().value).toBe('')
  })
})
