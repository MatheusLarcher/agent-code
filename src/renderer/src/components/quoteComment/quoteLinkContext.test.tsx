/**
 * O Composer liga o "Comentar" pelo QuoteLinkContext quando não recebe a prop
 * `quoteLink` — é assim que o campo do App, na tela do monitor do Escritório,
 * recebe os trechos do Chat de lá. Com a prop (o chat principal), a prop vence
 * e o contexto em volta fica de fora.
 */
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { UiProvider } from '../../ui/UiProvider'
import { Composer } from '../Composer'
import { QuoteLinkContext, type ComposerQuoteLink, type InsertResult } from './useComposerQuotes'

const linkOf = (): ComposerQuoteLink => ({ inserterRef: { current: null }, onChange: vi.fn() })

function field(link: ComposerQuoteLink, quoteLink?: ComposerQuoteLink): void {
  render(
    <UiProvider>
      <QuoteLinkContext.Provider value={link}>
        <Composer disabled={false} busy={false} chips={[]} onChipsConsumed={() => {}} onSend={() => {}} onInterrupt={() => {}} textareaRef={createRef<HTMLElement>()}
          projects={[]} projectRoot={null} convId="c1" draft="" onDraftChange={() => {}} projectMissing={false} projectMissingMsg="" quoteLink={quoteLink} />
      </QuoteLinkContext.Provider>
    </UiProvider>
  )
}

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = { mentionSearch: vi.fn(async () => []) }
})
afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('Composer — o "Comentar" pelo QuoteLinkContext', () => {
  it('sem a prop, o link do contexto: o campo registra o inserter, o trecho entra como "[trecho 1]" e quem comenta é avisado', () => {
    const link = linkOf()
    field(link)
    expect(link.inserterRef.current).not.toBeNull()
    let result: InsertResult | undefined
    act(() => {
      result = link.inserterRef.current!.insert({ messageId: 'a1', text: 'Primeiro parágrafo.' })
    })
    expect(result).toBe('ok')
    const token = screen.getByRole('textbox', { name: 'Mensagem' }).querySelector('img.inline-att-quote')!
    expect(token.getAttribute('alt')).toBe('Trecho citado 1: Primeiro parágrafo.')
    expect(decodeURIComponent(token.getAttribute('src')!)).toContain('[trecho 1]')
    expect(link.onChange).toHaveBeenLastCalledWith([{ messageId: 'a1', text: 'Primeiro parágrafo.' }])
  })

  it('com a prop (o chat principal), a prop vence: o inserter vai para ela e o contexto em volta fica sem', () => {
    const ctx = linkOf()
    const prop = linkOf()
    field(ctx, prop)
    expect(prop.inserterRef.current).not.toBeNull()
    expect(ctx.inserterRef.current).toBeNull()
  })
})
