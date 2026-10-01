import { createRef } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { UiProvider } from '../ui/UiProvider'
import { Composer } from './Composer'
import { composerPresence } from '../composerPresence'

/**
 * O Composer publica os fatos brutos no composerPresence (o escritório lê de lá):
 * edição do rascunho, envio (antes de limpar o campo) e microfone ligado.
 * A instância é a do app, então cada teste usa conversas próprias.
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function setup(convId: string, draft = '') {
  const onSend = vi.fn()
  const el = (id: string, d: string): JSX.Element => (
    <UiProvider>
      <Composer
        convId={id}
        draft={d}
        disabled={false}
        busy={false}
        chips={[]}
        onChipsConsumed={() => {}}
        onSend={onSend}
        onInterrupt={() => {}}
        textareaRef={createRef<HTMLElement>()}
        projects={[]}
        projectRoot={null}
        onDraftChange={() => {}}
        projectMissing={false}
        projectMissingMsg=""
      />
    </UiProvider>
  )
  const view = render(el(convId, draft))
  const box = (): HTMLElement => screen.getByRole('textbox', { name: 'Mensagem' })
  return {
    onSend,
    type: (v: string): void => {
      fireEvent.change(box(), { target: { value: v } })
    },
    enter: (): void => {
      fireEvent.keyDown(box(), { key: 'Enter' })
    },
    switchTo: (id: string, d = ''): void => view.rerender(el(id, d)),
    unmount: view.unmount
  }
}

describe('Composer — publica o rascunho e o envio', () => {
  it('digitar liga o rascunho; enviar marca sentAt e o esvaziamento não vira clearedAt', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const { type, enter, onSend } = setup('pres-1')
    type('o')
    now.mockReturnValue(1300)
    type('oi')
    expect(composerPresence.get('pres-1')).toMatchObject({ draftActiveSince: 1000, lastInputAt: 1300, clearedAt: null })
    now.mockReturnValue(2000)
    enter()
    expect(onSend).toHaveBeenCalledWith('oi', [], [], [], [])
    expect(composerPresence.get('pres-1')).toMatchObject({ draftActiveSince: null, sentAt: 2000, clearedAt: null })
  })

  it('apagar tudo sem enviar marca clearedAt', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const { type } = setup('pres-2')
    type('rascunho')
    now.mockReturnValue(4000)
    type('')
    expect(composerPresence.get('pres-2')).toMatchObject({ draftActiveSince: null, clearedAt: 4000, sentAt: null })
  })

  it('mais teclas no mesmo rascunho não avisam; o envio avisa uma vez', () => {
    const { type, enter } = setup('pres-3')
    const heard: string[] = []
    const off = composerPresence.subscribe((id) => heard.push(id))
    type('a')
    type('ab')
    type('abc')
    expect(heard).toEqual(['pres-3'])
    enter()
    expect(heard).toEqual(['pres-3', 'pres-3'])
    off()
  })

  it('rascunho restaurado (montar ou trocar de conversa) não é publicado como fala', () => {
    const { switchTo } = setup('pres-4', 'rascunho salvo')
    switchTo('pres-5', 'outro rascunho salvo')
    expect(composerPresence.get('pres-4').draftActiveSince).toBeNull()
    expect(composerPresence.get('pres-5').draftActiveSince).toBeNull()
  })
})

describe('Composer — publica o microfone', () => {
  function stubMic(): void {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: () => {} }] })) }
    })
  }
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'mediaDevices')
  })

  it('ligar e desligar o ditado publica micOn', async () => {
    stubMic()
    setup('pres-mic-1')
    fireEvent.click(screen.getByTitle('Falar (transcreve para texto)'))
    await waitFor(() => expect(composerPresence.get('pres-mic-1').micOn).toBe(true))
    fireEvent.click(screen.getByTitle('Parar e transcrever'))
    expect(composerPresence.get('pres-mic-1').micOn).toBe(false)
  })

  it('trocar de conversa gravando passa o mic para a nova; desmontar desliga', async () => {
    stubMic()
    const { switchTo, unmount } = setup('pres-mic-2')
    fireEvent.click(screen.getByTitle('Falar (transcreve para texto)'))
    await waitFor(() => expect(composerPresence.get('pres-mic-2').micOn).toBe(true))
    switchTo('pres-mic-3')
    expect(composerPresence.get('pres-mic-2').micOn).toBe(false)
    expect(composerPresence.get('pres-mic-3').micOn).toBe(true)
    unmount()
    expect(composerPresence.get('pres-mic-3').micOn).toBe(false)
  })
})
