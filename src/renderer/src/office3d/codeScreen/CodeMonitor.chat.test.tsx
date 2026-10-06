import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createRef, useState } from 'react'
import type { TtsControls } from '../../components/ChatRows'
import { Composer } from '../../components/Composer'
import { TtsContext } from '../../components/ttsContext'
import type { OfficeFeed } from '../../office/adapter/feed'
import type { OfficeCharacterModel } from '../../office/adapter/model'
import { conv, feed } from '../../office/adapter/testFeed'
import type { UIMessage } from '../../types'
import { UiProvider } from '../../ui/UiProvider'
import { CodeMonitor } from './CodeMonitor'
import { FLASH_MS } from './EditorPane'

const CWD = 'C:\\proj\\loja'
const P = (rel: string): string => `${CWD}\\${rel}`
const model: OfficeCharacterModel = {
  key: 'conv:a', convId: 'a', roomId: 'c:/proj/loja', role: 'principal', placement: { kind: 'seat', seatKind: 'principal' },
  seed: 'conv:a', active: true, activity: null, bubble: null, label: 'Edit a.ts'
}
const ask: UIMessage = { kind: 'user', id: 'u', text: 'mexe no a' }
let seq = 0
const tool = (name: string, input: unknown, text = 'ok'): UIMessage => ({ kind: 'tool-use', id: `c${seq++}`, name, input, parentToolUseId: null, result: { isError: false, text } })
const editA = (): UIMessage => tool('Edit', { file_path: P('src\\a.ts'), old_string: 'const a = 0', new_string: 'const a = 1' })
const readB = (): UIMessage => tool('Read', { file_path: P('src\\b.ts') }, '     1\tconst b = 2')
const bash = (): UIMessage => tool('Bash', { command: 'npm test' }, 'passou')
const feedOf = (messages: UIMessage[]): OfficeFeed => feed({ conversations: [conv('a', { title: 'Loja', cwd: CWD, messages })], busyIds: new Set(['a']) })

/** O campo de digitar do App: estado próprio, como o de verdade. */
function Field(): JSX.Element {
  const [v, setV] = useState('')
  return <textarea aria-label="Mensagem" value={v} onChange={(e) => setV(e.target.value)} />
}
/** O Composer de verdade (o campo do App na tela), com o envio espiado. */
function RealComposer({ onSend }: { onSend: (text: string) => void }): JSX.Element {
  return (
    <Composer disabled={false} busy={false} chips={[]} onChipsConsumed={() => {}} onSend={onSend} onInterrupt={() => {}} textareaRef={createRef<HTMLElement>()}
      projects={[]} projectRoot={null} convId="a" draft="" onDraftChange={() => {}} projectMissing={false} projectMissingMsg="" />
  )
}
const ui = (f: OfficeFeed, m: OfficeCharacterModel = model, composer?: JSX.Element): JSX.Element => (
  <UiProvider>
    <CodeMonitor feed={f} model={m} composer={composer} />
  </UiProvider>
)
/** O mesmo, com o TTS do App em volta (o App põe o TtsContext em volta do Escritório). */
const withTts = (tts: TtsControls, f: OfficeFeed, composer?: JSX.Element): JSX.Element => (
  <UiProvider>
    <TtsContext.Provider value={tts}>
      <CodeMonitor feed={f} model={model} composer={composer} />
    </TtsContext.Provider>
  </UiProvider>
)
const ANSWER_TEXT = 'Pronto: o valor de a agora é 1.'
const answer: UIMessage = { kind: 'assistant-text', id: 'r1', text: ANSWER_TEXT, final: true, answer: true }
const pane = (): HTMLElement => screen.getByTestId('office-screen-chat')
const sash = (): HTMLElement => screen.getByRole('separator', { name: 'Largura do chat' })

beforeEach(() => {
  localStorage.clear()
  ;(window as unknown as { api: unknown }).api = { readFile: vi.fn(async () => 'const a = 1\n') }
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (window as unknown as { api?: unknown }).api
})

describe('CodeMonitor — o Chat à direita do editor', () => {
  it('a borda: 400 px de saída; puxar para a esquerda alarga e só soltar guarda, sem aviso; vale para outro agente e para a próxima abertura', () => {
    const view = render(ui(feedOf([ask, editA()])))
    expect(pane().style.width).toBe('400px')
    expect(sash().getAttribute('aria-valuenow')).toBe('400')
    fireEvent.pointerDown(sash(), { clientX: 880, button: 0, pointerId: 1 })
    fireEvent.pointerMove(sash(), { clientX: 820, pointerId: 1 })
    expect(pane().style.width).toBe('460px')
    expect(localStorage.getItem('agentcode.monitor.chatWidth')).toBeNull()
    fireEvent.pointerUp(sash(), { clientX: 820, pointerId: 1 })
    expect(localStorage.getItem('agentcode.monitor.chatWidth')).toBe('460')
    // Guardar é calado: nenhum aviso na tela (nem o "Largura do chat guardada" de antes).
    expect(screen.getByTestId('office-screen').querySelector('.cm-toast')).toBeNull()
    expect(screen.getByTestId('office-screen').textContent).not.toContain('Largura do chat guardada')
    // Outro agente (a tela recomeça do zero): a mesma largura.
    view.rerender(ui(feedOf([ask, editA()]), { ...model, key: 'conv:b', convId: 'b', seed: 'conv:b' }))
    expect(pane().style.width).toBe('460px')
    // Fechar e abrir de novo (ou reiniciar): a largura guardada.
    cleanup()
    render(ui(feedOf([ask, editA()])))
    expect(pane().style.width).toBe('460px')
  })

  it('teclado e limites: ← alarga e → estreita de 16 em 16, Home = 280, End = o máximo; a largura guardada maior que a tela aparece limitada, sem regravar', () => {
    // Tela de 1280 px: o máximo é 60% (768), com o editor ainda acima de 320 px.
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1280)
    localStorage.setItem('agentcode.monitor.chatWidth', '900')
    render(ui(feedOf([ask, editA()])))
    expect(pane().style.width).toBe('768px')
    expect(sash().getAttribute('aria-valuemax')).toBe('768')
    expect(localStorage.getItem('agentcode.monitor.chatWidth')).toBe('900')
    fireEvent.keyDown(sash(), { key: 'ArrowRight' })
    expect(pane().style.width).toBe('752px')
    expect(localStorage.getItem('agentcode.monitor.chatWidth')).toBe('752')
    fireEvent.keyDown(sash(), { key: 'ArrowLeft' })
    expect(pane().style.width).toBe('768px')
    fireEvent.keyDown(sash(), { key: 'Home' })
    expect(pane().style.width).toBe('280px')
    fireEvent.keyDown(sash(), { key: 'End' })
    expect(pane().style.width).toBe('768px')
  })

  it('o campo de digitar fica embaixo do Chat; no Contexto fica montado e escondido, e o rascunho volta inteiro', () => {
    render(ui(feedOf([ask, editA()]), model, <Field />))
    const box = screen.getByTestId('office-screen-composer')
    expect(pane().lastElementChild).toBe(box)
    fireEvent.change(screen.getByRole('textbox', { name: 'Mensagem' }), { target: { value: 'meio escrito' } })
    fireEvent.click(screen.getByRole('button', { name: 'Contexto' }))
    expect(screen.getByTestId('office-screen-composer').hidden).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Código' }))
    expect(screen.getByTestId('office-screen-composer').hidden).toBe(false)
    expect((screen.getByRole('textbox', { name: 'Mensagem' }) as HTMLTextAreaElement).value).toBe('meio escrito')
  })

  it('cartão de arquivo: o Read abre a aba de prévia, o Edit abre o diff (deixa de seguir o Agent) e as linhas mudadas piscam; a ▸ e o Bash só expandem', async () => {
    render(ui(feedOf([ask, readB(), editA(), bash()])))
    const [read, edit, sh] = [...pane().querySelectorAll<HTMLElement>('.tool-card')]
    fireEvent.click(within(read).getByTitle('Abrir no editor'))
    const readTab = screen.getByRole('tab', { name: 'b.ts, lido' })
    expect([readTab.getAttribute('aria-selected'), readTab.classList.contains('cm-tab-pv')]).toEqual(['true', true])
    expect(screen.getByRole('button', { name: /Seguir o Agent/ }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(within(edit).getByTitle('Abrir no editor'))
    expect(screen.getByRole('tab', { name: 'a.ts, modificado' }).getAttribute('aria-selected')).toBe('true')
    await vi.waitFor(() => expect(screen.getByRole('tabpanel').querySelectorAll('.cm-row.cm-flash-1').length).toBeGreaterThan(0))
    const lit = [...screen.getByRole('tabpanel').querySelectorAll('.cm-row.cm-flash-1')]
    expect(lit.every((r) => r.classList.contains('cm-add') || r.classList.contains('cm-del'))).toBe(true)
    expect(edit.querySelector('.tool-body')).toBeNull()
    // A ▸ só expande: a aba fica.
    fireEvent.click(within(read).getByRole('button', { name: 'Mostrar a entrada e o resultado' }))
    expect(read.querySelector('.tool-body')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'a.ts, modificado' }).getAttribute('aria-selected')).toBe('true')
    // O Bash não é de arquivo: o cabeçalho só expande.
    expect(within(sh).queryByTitle('Abrir no editor')).toBeNull()
    fireEvent.click(sh.querySelector('.tool-head')!)
    expect(sh.querySelector('.tool-body')).toBeTruthy()
  })

  it('o pisca vale para o clique: passado o tempo dele, voltar ao arquivo (outro arquivo e de volta) não pisca de novo', async () => {
    vi.useFakeTimers()
    render(ui(feedOf([ask, readB(), editA(), bash()])))
    const lit = (): number => screen.getByRole('tabpanel').querySelectorAll('.cm-row.cm-flash-0, .cm-row.cm-flash-1').length
    const edit = [...pane().querySelectorAll<HTMLElement>('.tool-card')][1]
    fireEvent.click(within(edit).getByTitle('Abrir no editor'))
    await act(async () => {})
    expect(lit()).toBeGreaterThan(0)
    await act(async () => {
      vi.advanceTimersByTime(FLASH_MS + 50)
    })
    expect(lit()).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'b.ts, lido' }))
    fireEvent.click(screen.getByRole('tab', { name: 'a.ts, modificado' }))
    await act(async () => {})
    expect(lit()).toBe(0)
  })

  it('tela estreita (o cartão sem mesa, ~420 px): o Chat ocupa a janela, sem editor nem borda, e o cartão de arquivo só expande', () => {
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(420)
    render(ui(feedOf([ask, editA()])))
    expect(pane().style.width).toBe('')
    expect(pane().closest('.cm-dock')?.classList.contains('narrow')).toBe(true)
    expect(screen.queryByRole('separator', { name: 'Largura do chat' })).toBeNull()
    expect(screen.queryByRole('tablist', { name: 'Arquivos abertos' })).toBeNull()
    const card = pane().querySelector<HTMLElement>('.tool-card')!
    expect(within(card).queryByTitle('Abrir no editor')).toBeNull()
    fireEvent.click(card.querySelector('.tool-head')!)
    expect(card.querySelector('.tool-body')).toBeTruthy()
  })
})

describe('CodeMonitor — "Ouvir" e "Comentar" no Chat, os mesmos da aba Conversa', () => {
  it('Ouvir: com o TTS do App em volta, a resposta final tem "Ouvir" e o clique chama o mesmo onToggleSpeak (id, texto); lendo, vira "Parar"; com o campo, o bloco tem "Ler daqui"; sem o TTS, nada', () => {
    const onToggleSpeak = vi.fn()
    const f = feedOf([ask, editA(), answer])
    const view = render(withTts({ speakingId: null, onToggleSpeak }, f))
    fireEvent.click(within(pane()).getByRole('button', { name: 'Ouvir' }))
    expect(onToggleSpeak).toHaveBeenLastCalledWith('r1', ANSWER_TEXT)
    view.rerender(withTts({ speakingId: 'r1', onToggleSpeak }, f))
    expect(within(pane()).getByRole('button', { name: 'Parar' })).toBeTruthy()
    // Com o campo na tela os blocos são comentáveis, e o "Ler daqui" lê do bloco até o fim com o mesmo TTS.
    view.rerender(withTts({ speakingId: null, onToggleSpeak }, f, <Field />))
    fireEvent.click(within(pane()).getByRole('button', { name: 'Ler daqui' }))
    expect(onToggleSpeak.mock.lastCall?.[0]).toMatch(/^r1#ler:/)
    expect(onToggleSpeak.mock.lastCall?.[1]).toBe(ANSWER_TEXT)
    // Sem o TtsContext em volta (quem monta sem o App): sem "Ouvir" nem "Ler daqui".
    cleanup()
    render(ui(f, model, <Field />))
    expect(within(pane()).queryByRole('button', { name: 'Ouvir' })).toBeNull()
    expect(within(pane()).queryByRole('button', { name: 'Ler daqui' })).toBeNull()
  })

  it('Comentar: com o campo na tela (o Composer de verdade), o bloco da resposta tem "Comentar" e o clique põe "[trecho 1]" no campo, que sai citado no envio; sem o campo, sem "Comentar"', () => {
    const onSend = vi.fn()
    const f = feedOf([ask, editA(), answer])
    render(ui(f, model, <RealComposer onSend={onSend} />))
    const block = pane().querySelector<HTMLElement>('.msg.assistant .md > p')!
    fireEvent.click(within(block).getByRole('button', { name: 'Comentar este trecho' }))
    const box = screen.getByRole('textbox', { name: 'Mensagem' })
    const token = box.querySelector('img.inline-att-quote')!
    expect(token.getAttribute('alt')).toBe(`Trecho citado 1: ${ANSWER_TEXT}`)
    expect(decodeURIComponent(token.getAttribute('src')!)).toContain('[trecho 1]')
    expect(block.classList.contains('qc-pending')).toBe(true)
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend.mock.calls[0][0]).toBe(`> [trecho 1] · mensagem r1\n> ${ANSWER_TEXT}\n\n[trecho 1]`)
    // Sem o campo (quem não dá o composer): os blocos ficam como sempre, sem "Comentar".
    cleanup()
    render(ui(f))
    expect(pane().querySelector('.msg.assistant .md > p')?.textContent).toBe(ANSWER_TEXT)
    expect(within(pane()).queryByRole('button', { name: 'Comentar este trecho' })).toBeNull()
  })
})
