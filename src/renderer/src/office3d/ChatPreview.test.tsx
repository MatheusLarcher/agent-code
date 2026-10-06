/**
 * A prévia do hover (ChatPreview) continua só leitura: mesmo com o TTS do App
 * em volta (TtsContext), a resposta sai sem "Ouvir", "Ler daqui" e "Comentar".
 * O contraste: a tela do monitor, com o mesmo turno e o mesmo TTS, tem os três.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { TtsContext } from '../components/ttsContext'
import type { OfficeCharacterModel } from '../office/adapter/model'
import { conv, feed } from '../office/adapter/testFeed'
import type { UIMessage } from '../types'
import { UiProvider } from '../ui/UiProvider'
import { ChatPreview } from './ChatPreview'
import { CodeMonitor } from './codeScreen/CodeMonitor'

const model: OfficeCharacterModel = {
  key: 'conv:a', convId: 'a', roomId: 'c:/proj/loja', role: 'principal', placement: { kind: 'seat', seatKind: 'principal' },
  seed: 'conv:a', active: false, activity: null, bubble: null, label: ''
}
const turn: UIMessage[] = [
  { kind: 'user', id: 'u', text: 'resume o plano' },
  { kind: 'assistant-text', id: 'r1', text: 'Primeiro passo.\n\n- item um', final: true, answer: true }
]
const f = feed({ conversations: [conv('a', { title: 'Plano', cwd: 'C:\\proj\\loja', messages: turn })] })

beforeEach(() => {
  localStorage.clear()
  ;(window as unknown as { api: unknown }).api = { readFile: vi.fn(async () => '') }
})
afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('ChatPreview — só leitura, mesmo com o TTS do App em volta', () => {
  it('a prévia mostra a resposta sem "Ouvir", "Ler daqui" nem "Comentar"; a tela do monitor, com o mesmo turno e TTS (e o campo), tem os três', () => {
    render(
      <UiProvider>
        <TtsContext.Provider value={{ speakingId: null, onToggleSpeak: vi.fn() }}>
          <ChatPreview feed={f} model={model} />
          <CodeMonitor feed={f} model={model} composer={<textarea aria-label="Mensagem" />} />
        </TtsContext.Provider>
      </UiProvider>
    )
    // A prévia é aria-hidden (não pega o mouse): procura pelas classes, não pelo papel.
    const preview = screen.getByTestId('office-preview')
    expect(preview.querySelector('.msg.assistant .md')?.textContent).toContain('Primeiro passo.')
    expect(preview.querySelector('.msg-speak, .qc-btn, .qc-actions')).toBeNull()
    expect(preview.querySelector('.qc-block')).toBeNull()
    const chat = screen.getByTestId('office-screen-chat')
    expect(within(chat).getByRole('button', { name: 'Ouvir' })).toBeTruthy()
    expect(within(chat).getAllByRole('button', { name: 'Ler daqui' }).length).toBeGreaterThan(0)
    expect(within(chat).getAllByRole('button', { name: 'Comentar este trecho' }).length).toBeGreaterThan(0)
  })
})
