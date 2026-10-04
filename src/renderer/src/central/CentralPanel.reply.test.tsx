import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { CENTRAL_ID, type CentralEntry, type CentralReplyEntry, type CentralRequestEntry } from '@shared/central'
import { UiProvider } from '../ui/UiProvider'
import type { EditorElement } from '../inlineMedia/InlineEditor'
import type { Conversation } from '../types'
import { CentralPanel } from './CentralPanel'
import { fakeController } from './centralFakeController'

/** Responder uma mensagem no PC: botão no hover, menu do botão direito, citação acima do campo, × e Esc. */

const SELF = 'pc-a'
const central = (): Conversation =>
  ({ id: CENTRAL_ID, title: 'Central', cwd: '', mode: 'central', model: 'm', sdkSessionId: null, messages: [], tokens: { context: 0, output: 0, cost: 0 }, createdAt: 1, updatedAt: 1 }) as Conversation

const req = (over: Partial<CentralRequestEntry>): CentralRequestEntry => ({
  kind: 'request',
  id: 'r1',
  ts: 1,
  text: 'arruma o filtro de CNPJ',
  state: 'delivered',
  origin: 'central',
  device: SELF,
  route: { target: { kind: 'conversation', convId: 'darj', cwd: '/p', project: 'p', title: 't', sandbox: false }, why: 'continua' },
  anchor: { convId: 'darj', msgId: 'u1' },
  ...over
})
const reply: CentralReplyEntry = {
  kind: 'reply',
  id: 'reply:r1',
  ts: 2,
  requestId: 'r1',
  anchor: { convId: 'darj', msgId: 'u1' },
  notes: [],
  answer: 'Filtro corrigido.',
  activity: { segments: [], text: '', count: 0, errors: 0 },
  done: true,
  device: SELF
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  ;(window as unknown as { api: unknown }).api = { mentionSearch: vi.fn(async () => []), resolvePastedPath: vi.fn(), downloadPastedUrl: vi.fn(), readFileBytes: vi.fn() }
})
afterEach(cleanup)

function setup(entries: CentralEntry[]) {
  const onSend = vi.fn()
  const r = render(
    <UiProvider>
      <CentralPanel
        conversation={central()}
        controller={fakeController({ entries })}
        self={SELF}
        ready
        onNeedTypesafe={vi.fn()}
        onSend={onSend}
        onDraftChange={vi.fn()}
        composerRef={createRef<HTMLElement>()}
        projects={[]}
      />
    </UiProvider>
  )
  const box = (): EditorElement => screen.getByRole('textbox', { name: 'Mensagem' }) as EditorElement
  const entry = (id: string): HTMLElement => r.container.querySelector(`[data-entry-id="${id}"]`) as HTMLElement
  const bar = (): HTMLElement | null => r.container.querySelector('.central-composer .central-quote')
  return { onSend, box, entry, bar, container: r.container }
}

describe('CentralPanel — responder uma mensagem', () => {
  it('botão "Responder" só em pedido entregue e resposta deste PC', () => {
    const { entry } = setup([
      req({}),
      reply,
      req({ id: 'r2', device: 'pc-b' }),
      req({ id: 'r3', state: 'asking', anchor: undefined, route: undefined, ask: { options: [], reason: 'low-confidence' } }),
      req({ id: 'r4', state: 'routing', anchor: undefined, route: undefined })
    ])
    expect(within(entry('r1')).getByRole('button', { name: 'Responder' })).toBeTruthy()
    expect(within(entry('reply:r1')).getByRole('button', { name: 'Responder' })).toBeTruthy()
    for (const id of ['r2', 'r3', 'r4']) expect(within(entry(id)).queryByRole('button', { name: 'Responder' })).toBeNull()
  })

  it('clicar mostra a citação (projeto · conversa + trecho) acima do campo; enviar leva o replyTo e sai do modo', () => {
    const { entry, bar, box, onSend } = setup([req({}), reply])
    fireEvent.click(within(entry('reply:r1')).getByRole('button', { name: 'Responder' }))
    expect(bar()?.textContent).toContain('Filtro corrigido.')
    expect(bar()?.querySelector('.central-quote-who')?.textContent).toBeTruthy()
    fireEvent.change(box(), { target: { value: 'manda em PDF' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('manda em PDF', [], [], [], [], 'reply:r1')
    expect(bar()).toBeNull()
  })

  it('× e Esc cancelam: o envio volta a ser normal', () => {
    const { entry, bar, box, onSend } = setup([req({})])
    const btn = within(entry('r1')).getByRole('button', { name: 'Responder' })
    fireEvent.click(btn)
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar resposta' }))
    expect(bar()).toBeNull()
    fireEvent.click(btn)
    expect(bar()).not.toBeNull()
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(bar()).toBeNull()
    fireEvent.change(box(), { target: { value: 'oi' } })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('oi', [], [], [], [])
  })

  it('botão direito na mensagem abre "Responder"; em mensagem sem destino, o menu nativo segue', () => {
    const { entry, bar } = setup([req({}), req({ id: 'r4', state: 'routing', anchor: undefined, route: undefined })])
    const blocked = fireEvent.contextMenu(entry('r4'))
    expect(blocked).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.contextMenu(entry('r1').querySelector('.central-bubble')!)
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Responder/ }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(bar()?.textContent).toContain('arruma o filtro de CNPJ')
  })

  it('o pedido que respondeu mostra a citação na bolha', () => {
    const { entry } = setup([req({ id: 'r9', replyTo: { id: 'r1', convId: 'darj', text: 'arruma o filtro' } })])
    expect(entry('r9').querySelector('.central-quote')?.textContent).toContain('arruma o filtro')
  })
})
