import { createRef, Fragment, StrictMode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { UiProvider } from '../ui/UiProvider'
import { Composer } from './Composer'
import { hasTypedText, type HasTextListener } from './useHasTextSignal'

/**
 * `onHasTextChange` do Composer: avisa só na troca "sem texto" ↔ "com texto",
 * inclusive quando a troca vem do rascunho restaurado ao mudar de conversa.
 * Anexo no texto (1 caractere TOKEN) não é texto.
 */

const TOKEN = '￼'
afterEach(cleanup)

function setup(first: { convId?: string; draft?: string; listener?: HasTextListener; strict?: boolean } = {}) {
  const onHasTextChange = vi.fn<HasTextListener>()
  const Wrap = first.strict ? StrictMode : Fragment
  const el = (convId: string, draft: string, listener: HasTextListener | undefined, draftMedia?: unknown[]): JSX.Element => (
    <Wrap>
    <UiProvider>
      <Composer
        convId={convId}
        draft={draft}
        draftMedia={draftMedia}
        disabled={false}
        busy={false}
        chips={[]}
        onRemoveChip={() => {}}
        onSend={() => {}}
        onInterrupt={() => {}}
        textareaRef={createRef<HTMLElement>()}
        projects={[]}
        projectRoot={null}
        onDraftChange={() => {}}
        projectMissing={false}
        projectMissingMsg=""
        onHasTextChange={listener}
      />
    </UiProvider>
    </Wrap>
  )
  const view = render(el(first.convId ?? 'c1', first.draft ?? '', 'listener' in first ? first.listener : onHasTextChange))
  const box = (): HTMLElement => screen.getByRole('textbox', { name: 'Mensagem' })
  return {
    onHasTextChange,
    type: (v: string): void => {
      fireEvent.change(box(), { target: { value: v } })
    },
    switchTo: (convId: string, draft: string, listener: HasTextListener | undefined = onHasTextChange, draftMedia?: unknown[]): void =>
      view.rerender(el(convId, draft, listener, draftMedia)),
    unmount: view.unmount
  }
}

describe('hasTypedText — só texto conta', () => {
  it('vazio e só anexos não são texto; qualquer caractere digitado é', () => {
    expect(hasTypedText('')).toBe(false)
    expect(hasTypedText(TOKEN)).toBe(false)
    expect(hasTypedText(`${TOKEN}${TOKEN}`)).toBe(false)
    expect(hasTypedText('a')).toBe(true)
    expect(hasTypedText(' ')).toBe(true)
    expect(hasTypedText(`${TOKEN}x`)).toBe(true)
  })
})

describe('Composer — onHasTextChange', () => {
  it('montar vazio não avisa (quem ouve parte de "sem texto")', () => {
    const { onHasTextChange } = setup()
    expect(onHasTextChange).not.toHaveBeenCalled()
  })

  it('avisa só na troca: 1º caractere → true; mais teclas nada; apagar tudo → false', () => {
    const { onHasTextChange, type } = setup()
    type('o')
    expect(onHasTextChange.mock.calls).toEqual([[true]])
    type('oi')
    type('oi, tudo')
    type('oi')
    expect(onHasTextChange).toHaveBeenCalledTimes(1)
    type('')
    expect(onHasTextChange.mock.calls).toEqual([[true], [false]])
    type('')
    expect(onHasTextChange).toHaveBeenCalledTimes(2)
  })

  it('só anexo no texto (TOKEN) não avisa; texto ao lado dele avisa; tirar o texto volta a false', () => {
    const { onHasTextChange, type } = setup()
    type(TOKEN)
    type(`${TOKEN}${TOKEN}`)
    expect(onHasTextChange).not.toHaveBeenCalled()
    type(`${TOKEN}a`)
    expect(onHasTextChange.mock.calls).toEqual([[true]])
    type(TOKEN)
    expect(onHasTextChange.mock.calls).toEqual([[true], [false]])
  })

  it('rascunho RESTAURADO ao trocar de conversa avisa (vazio → rascunho → vazio)', () => {
    const { onHasTextChange, switchTo } = setup({ convId: 'c1', draft: '' })
    switchTo('c2', 'rascunho da conversa 2')
    expect(onHasTextChange.mock.calls).toEqual([[true]])
    switchTo('c3', '')
    expect(onHasTextChange.mock.calls).toEqual([[true], [false]])
  })

  it('rascunho restaurado só com imagem não é texto; com texto ao lado da imagem é', async () => {
    const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    ;(window as unknown as { api: unknown }).api = {
      readFileBytes: vi.fn(async () => ({ ok: true, base64: PNG_B64, size: 68 }))
    }
    const media = [{ kind: 'image', name: 'r.png', mediaType: 'image/png', path: 'C:\\ud\\attachments\\c2\\1-r.png', size: 68 }]
    const { onHasTextChange, switchTo } = setup({ convId: 'c1', draft: '' })
    switchTo('c2', '{{midia:1}}', undefined, media)
    expect(await screen.findByAltText('Imagem anexada: r.png')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Mensagem' }).textContent ?? '').not.toContain('{{midia')
    expect(onHasTextChange).not.toHaveBeenCalled()
    switchTo('c3', 'olha {{midia:1}}', undefined, media)
    await screen.findByAltText('Imagem anexada: r.png')
    expect(onHasTextChange.mock.calls).toEqual([[true]])
  })

  it('de um rascunho de texto para outro não repete o aviso', () => {
    const { onHasTextChange, switchTo, type } = setup({ convId: 'c1' })
    type('texto da 1')
    switchTo('c2', 'texto da 2')
    expect(onHasTextChange.mock.calls).toEqual([[true]])
  })

  it('montar já com rascunho avisa true uma vez', () => {
    const { onHasTextChange } = setup({ draft: 'rascunho salvo' })
    expect(onHasTextChange.mock.calls).toEqual([[true]])
  })

  it('desmontar com texto devolve quem ouve a false', () => {
    const { onHasTextChange, type, unmount } = setup()
    type('algo')
    unmount()
    expect(onHasTextChange.mock.calls).toEqual([[true], [false]])
  })

  it('trocar o ouvinte com texto: o antigo volta a false e o novo recebe true', () => {
    const { onHasTextChange, type, switchTo } = setup({ convId: 'c1' })
    type('algo')
    const other = vi.fn<HasTextListener>()
    switchTo('c1', '', other)
    expect(onHasTextChange.mock.calls).toEqual([[true], [false]])
    expect(other.mock.calls).toEqual([[true]])
  })

  it('sem ouvinte (o chat normal) nada quebra', () => {
    const { type } = setup({ listener: undefined })
    type('a')
    type('')
  })
})

// O app monta dentro de <React.StrictMode> (main.tsx): o React desmonta e
// remonta os efeitos uma vez. O que vale é o ÚLTIMO aviso — é nele que quem ouve fica.
describe('Composer — onHasTextChange dentro do StrictMode', () => {
  const last = (fn: ReturnType<typeof vi.fn<HasTextListener>>): boolean | undefined => fn.mock.calls.at(-1)?.[0]

  it('montar já com rascunho (restaurado): o último aviso é true', () => {
    const { onHasTextChange } = setup({ draft: 'rascunho salvo', strict: true })
    expect(onHasTextChange).toHaveBeenCalled()
    expect(last(onHasTextChange)).toBe(true)
  })

  it('montar vazio: quem ouve continua em "sem texto"', () => {
    const { onHasTextChange } = setup({ strict: true })
    expect(last(onHasTextChange) ?? false).toBe(false)
  })

  it('rascunho restaurado ao trocar de conversa: true; conversa sem rascunho: false', () => {
    const { onHasTextChange, switchTo } = setup({ convId: 'c1', draft: '', strict: true })
    switchTo('c2', 'rascunho da conversa 2')
    expect(last(onHasTextChange)).toBe(true)
    switchTo('c3', '')
    expect(last(onHasTextChange)).toBe(false)
  })

  it('digitar e apagar seguem avisando; desmontar com texto devolve a false', () => {
    const { onHasTextChange, type, unmount } = setup({ strict: true })
    type('a')
    expect(last(onHasTextChange)).toBe(true)
    type('')
    expect(last(onHasTextChange)).toBe(false)
    type('b')
    unmount()
    expect(last(onHasTextChange)).toBe(false)
  })
})
