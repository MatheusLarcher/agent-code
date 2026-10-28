import { createRef } from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, fireEvent, cleanup, act } from '@testing-library/react'
import { UiProvider } from '../ui/UiProvider'
import { Composer } from '../components/Composer'

/**
 * Regressão: anexo cujo FileReader PENDURA (ex.: uma pasta sem caminho, que
 * escorrega para a leitura por bytes) travava o envio para sempre — o item ficava
 * "resolvendo" e o botão Enviar nunca reabilitava. Com o teto de tempo em
 * `readDataUrl`, a leitura rejeita, o item cai no fallback e o envio destrava.
 */

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** FileReader que NUNCA dispara onload/onerror: simula a pasta que pendura. */
class HangingFileReader {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  result: unknown = null
  error: unknown = null
  abort(): void {}
  readAsDataURL(): void {}
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  ;(window as unknown as { api: unknown }).api = {
    mentionSearch: vi.fn(async () => []),
    listSkills: vi.fn(async () => []),
    resolvePastedPath: vi.fn(),
    downloadPastedUrl: vi.fn(),
    readFileBytes: vi.fn()
    // sem getPathForFile de propósito: a "pasta" não vira ref e cai na leitura por bytes
  }
})

function setup() {
  const r = render(
    <UiProvider>
      <Composer
        disabled={false}
        busy={false}
        chips={[]}
        onChipsConsumed={() => {}}
        onSend={vi.fn()}
        onInterrupt={() => {}}
        textareaRef={createRef<HTMLElement>()}
        projects={[]}
        projectRoot={null}
        convId="c1"
        draft=""
        onDraftChange={vi.fn()}
        projectMissing={false}
        projectMissingMsg=""
      />
    </UiProvider>
  )
  const sendButton = (): HTMLButtonElement => r.container.querySelector('button.btn.send') as HTMLButtonElement
  const attach = (f: File): void => {
    fireEvent.change(r.container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [f] } })
  }
  return { sendButton, attach }
}

describe('anexo que pendura não trava o envio para sempre', () => {
  it('pasta cujo FileReader nunca responde: o envio destrava após o teto de tempo', async () => {
    vi.stubGlobal('FileReader', HangingFileReader)
    vi.useFakeTimers()
    const { sendButton, attach } = setup()

    const pasta = new File([], 'claude-recuperado', { type: '' })
    await act(async () => {
      attach(pasta)
    })
    // Enquanto "resolvendo", o envio fica bloqueado.
    expect(sendButton().disabled).toBe(true)

    // Passa o teto de leitura (30 s): a promessa rejeita e o item some.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000)
    })
    expect(sendButton().disabled).toBe(false)
  })
})
