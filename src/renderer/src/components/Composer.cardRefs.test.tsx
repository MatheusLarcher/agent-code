import { createRef } from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import type { FileAttachment, FileRefAttachment, ImageAttachment } from '@shared/ipc'
import { UiProvider } from '../ui/UiProvider'
import { Composer } from './Composer'
import { ChatDisplayContext } from './chatDisplay'
import type { RefCard } from '../planning/cardRefs'
import { typeColorVar } from '../planning/cardTypes'

type SendFn = (text: string, images: ImageAttachment[], files: FileAttachment[], fileRefs: FileRefAttachment[]) => void

const CARDS: RefCard[] = [
  { id: 'login', titulo: 'Login com SSO', tipo: 'requisito' },
  { id: 'banco', titulo: 'Usar Postgres', tipo: 'decisao' },
  { id: 'duvida', titulo: 'Quem aprova a ação?', tipo: 'ambiguidade' },
  { id: 'contrato', titulo: 'Revisao do contrato', tipo: 'nota' }
]

let listSkills: ReturnType<typeof vi.fn>
beforeEach(() => {
  listSkills = vi.fn(async () => [])
  ;(window as unknown as { api: unknown }).api = { listSkills }
})
afterEach(cleanup)

/** `cards` undefined = sem provider (qualquer conversa fora do planejamento). */
function renderComposer(cards?: readonly RefCard[]): { onSend: ReturnType<typeof vi.fn<SendFn>> } {
  const onSend = vi.fn<SendFn>()
  const composer = (
    <Composer
      disabled={false}
      busy={false}
      chips={[]}
      onRemoveChip={() => {}}
      onSend={onSend}
      onInterrupt={() => {}}
      textareaRef={createRef<HTMLTextAreaElement>()}
      projects={[]}
      projectRoot={null}
      voiceReady={false}
      onNeedVoiceKey={() => {}}
      convId="c1"
      draft=""
      onDraftChange={() => {}}
      projectMissing={false}
      projectMissingMsg=""
    />
  )
  render(
    <UiProvider>
      {cards ? (
        <ChatDisplayContext.Provider value={{ compact: false, cardRefs: cards }}>{composer}</ChatDisplayContext.Provider>
      ) : (
        composer
      )}
    </UiProvider>
  )
  return { onSend }
}

const box = (): HTMLTextAreaElement => screen.getByPlaceholderText(/Mensagem para o Claude/) as HTMLTextAreaElement
const type = (value: string): void => void fireEvent.change(box(), { target: { value } })
const options = (): HTMLElement[] => screen.queryAllByRole('option')
const titles = (): string[] => options().map((o) => o.querySelector('.pl-ref-title')?.textContent ?? '')
const selected = (): string | undefined =>
  options().find((o) => o.getAttribute('aria-selected') === 'true')?.querySelector('.pl-ref-title')?.textContent ?? undefined

describe('Composer — "[[" com os cards do plano no contexto', () => {
  it('"[[" abre a lista acima da caixa, cada card com o ícone e a cor do tipo (as do canvas)', () => {
    renderComposer(CARDS)
    type('ver [[')
    const list = screen.getByRole('listbox', { name: 'Cards para citar' })
    // A lista é a do editor de card (.pl-refs), posicionada pelo Composer acima da caixa.
    const pop = list.closest('.pl-refs') as HTMLElement
    expect(pop.classList.contains('composer-card-refs')).toBe(true)
    expect(pop.parentElement?.classList.contains('composer')).toBe(true)
    expect(titles()).toEqual(CARDS.map((c) => c.titulo))
    for (const [i, card] of CARDS.entries()) {
      expect(options()[i].getAttribute('data-tipo')).toBe(card.tipo)
      expect(options()[i].style.getPropertyValue('--pl-ref-color')).toBe(typeColorVar(card.tipo))
      expect(options()[i].querySelector('svg')).toBeTruthy()
    }
    expect(box().getAttribute('aria-autocomplete')).toBe('list')
    expect(box().getAttribute('aria-controls')).toBe(list.id)
  })

  it('filtra pelo nome ignorando caixa e acento nos dois sentidos', () => {
    renderComposer(CARDS)
    type('[[ACAO') // sem acento na busca, com acento no título
    expect(titles()).toEqual(['Quem aprova a ação?'])
    type('[[revisão') // com acento na busca, sem acento no título
    expect(titles()).toEqual(['Revisao do contrato'])
    type('[[sso')
    expect(titles()).toEqual(['Login com SSO'])
  })

  it('Enter com a lista aberta insere [[Título]] (pelo nome, não o id) e NÃO envia; o próximo Enter envia', () => {
    const { onSend } = renderComposer(CARDS)
    type('ver [[post')
    expect(fireEvent.keyDown(box(), { key: 'Enter' })).toBe(false) // consumido pela lista
    expect(onSend).not.toHaveBeenCalled()
    expect(box().value).toBe('ver [[Usar Postgres]]')
    expect(box().selectionStart).toBe('ver [[Usar Postgres]]'.length)
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('ver [[Usar Postgres]]', [], [], [])
  })

  it('setas andam na lista (dando a volta); Tab e clique também inserem', () => {
    renderComposer(CARDS)
    type('a [[')
    expect(selected()).toBe('Login com SSO')
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(selected()).toBe('Usar Postgres')
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    expect(selected()).toBe('Revisao do contrato')
    fireEvent.keyDown(box(), { key: 'Tab' })
    expect(box().value).toBe('a [[Revisao do contrato]]')

    type('a [[Revisao do contrato]] e [[qu')
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Quem aprova a ação?'))
    expect(box().value).toBe('a [[Revisao do contrato]] e [[Quem aprova a ação?]]')
  })

  it('Esc fecha a lista sem apagar o texto e sem enviar; só um "[[" novo reabre', () => {
    const { onSend } = renderComposer(CARDS)
    type('oi [[us')
    expect(screen.getByRole('listbox')).toBeTruthy()
    expect(fireEvent.keyDown(box(), { key: 'Escape' })).toBe(false)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(box().value).toBe('oi [[us')
    expect(onSend).not.toHaveBeenCalled()
    type('oi [[usa') // o mesmo '[['
    expect(screen.queryByRole('listbox')).toBeNull()
    type('oi [[usa [[')
    expect(screen.getByRole('listbox')).toBeTruthy()
  })

  it('sem card casando a lista não abre: Enter envia como sempre', () => {
    const { onSend } = renderComposer(CARDS)
    type('[[nada disso')
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('[[nada disso', [], [], [])
  })

  it('dentro de um "[[" o menu de skills ("/") não abre', () => {
    renderComposer(CARDS)
    type('ver [[Login /')
    expect(listSkills).not.toHaveBeenCalled()
  })

  it('perder o foco esconde a lista', () => {
    renderComposer(CARDS)
    type('[[')
    fireEvent.blur(box())
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('Composer — sem cards no contexto fica exatamente como hoje', () => {
  it('sem provider: "[[" não abre nada, Enter envia e a caixa não ganha aria de autocomplete', () => {
    const { onSend } = renderComposer()
    type('ver [[')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.querySelector('.pl-refs')).toBeNull()
    expect(box().hasAttribute('aria-autocomplete')).toBe(false)
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('ver [[', [], [], [])
  })

  it('provider com lista vazia: também nada', () => {
    const { onSend } = renderComposer([])
    type('[[')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(box().hasAttribute('aria-autocomplete')).toBe(false)
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('[[', [], [], [])
  })

  it('sem cards, o "/" depois de "[[" continua abrindo o menu de skills', async () => {
    renderComposer()
    type('ver [[Login /')
    await vi.waitFor(() => expect(listSkills).toHaveBeenCalled())
  })
})
