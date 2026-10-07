/**
 * A Central pagina como o chat (useScrollWindow): centenas de entradas abrem só
 * as últimas 40 com o aviso das anteriores; perto do topo, +40 sem sair do fim
 * da janela atual; lendo o histórico, entrada nova no fim não move o começo;
 * perguntas pendentes sempre à vista; abrir uma linha-resumo não muda a janela.
 */
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { CENTRAL_ID, type CentralEntry, type CentralReplyEntry, type CentralRequestEntry } from '@shared/central'
import { UiProvider } from '../ui/UiProvider'
import type { Conversation } from '../types'
import { resetStepOpen } from '../components/useStepOpen'
import { CentralPanel } from './CentralPanel'
import { fakeController } from './centralFakeController'
import type { CentralPendingQuestion } from './useCentral'

const req = (i: number): CentralRequestEntry => ({ kind: 'request', id: `r${i}`, ts: i, text: `pedido ${i}`, state: 'delivered', anchor: { convId: 'darj', msgId: `u${i}` } })
const reply = (i: number): CentralReplyEntry => ({
  kind: 'reply',
  id: `reply:r${i}`,
  ts: i,
  requestId: `r${i}`,
  anchor: { convId: 'darj', msgId: `u${i}` },
  notes: [],
  answer: `resposta ${i}`,
  activity: { segments: [{ text: 'Leu 1 arquivo' }], text: 'Leu 1 arquivo', count: 1, errors: 0 },
  steps: [{ note: `nota ${i}`, activity: { segments: [{ text: 'Leu 1 arquivo' }], text: 'Leu 1 arquivo', count: 1, errors: 0 }, toolIds: [`t${i}`] }],
  done: true
})
/** 150 pedidos com resposta: 300 entradas. */
const many = (n = 150): CentralEntry[] => Array.from({ length: n }, (_, i) => [req(i), reply(i)]).flat()

const panel = (entries: CentralEntry[], pending: CentralPendingQuestion[] = []): JSX.Element => (
  <UiProvider>
    <CentralPanel
      conversation={{ id: CENTRAL_ID, title: 'Central', cwd: '', mode: 'central', messages: [] } as unknown as Conversation}
      controller={fakeController({ entries, pending })}
      ready
      onNeedTypesafe={vi.fn()}
      onSend={vi.fn()}
      onDraftChange={vi.fn()}
      composerRef={createRef<HTMLElement>()}
      projects={[]}
    />
  </UiProvider>
)

const shownIds = (box: HTMLElement): string[] => [...box.querySelectorAll<HTMLElement>('.central-feed > [data-entry-id]')].map((el) => el.dataset.entryId!)

/** O feed com altura de verdade (o jsdom não faz layout): 10 000 px de conteúdo, 500 à vista. */
function sized(feed: HTMLElement): void {
  Object.defineProperty(feed, 'scrollHeight', { configurable: true, get: () => 10_000 })
  Object.defineProperty(feed, 'clientHeight', { configurable: true, get: () => 500 })
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  ;(window as unknown as { api: unknown }).api = { mentionSearch: vi.fn(async () => []) }
  resetStepOpen()
})
afterEach(cleanup)

describe('CentralPanel — janela das últimas entradas', () => {
  it('centenas de entradas: só as últimas 40, o aviso das anteriores e a pergunta pendente no fim', () => {
    const pending: CentralPendingQuestion[] = [
      { convId: 'darj', label: { project: 'p', title: 't', color: '#fff', icon: null, sandbox: false }, request: { id: 'q1', toolName: 'Bash', input: { command: 'rm -rf' } } } as CentralPendingQuestion
    ]
    const { container } = render(panel(many(), pending))
    const ids = shownIds(container)
    expect(ids).toHaveLength(40)
    expect(ids.at(-1)).toBe('reply:r149')
    expect(container.querySelector('.load-more-hint')?.textContent).toBe('↑ Role para cima para carregar mais (260 anteriores)')
    expect(container.querySelector('.central-q')).toBeTruthy()
  })

  it('perto do topo: +40 de uma vez; abrir/fechar uma linha-resumo não muda a janela', () => {
    const { container } = render(panel(many()))
    const feed = container.querySelector<HTMLElement>('.central-feed')!
    sized(feed)
    fireEvent.click(container.querySelector<HTMLElement>('.central-act')!)
    expect(shownIds(container)).toHaveLength(40)
    feed.scrollTop = 10
    fireEvent.scroll(feed)
    expect(shownIds(container)).toHaveLength(80)
    expect(container.querySelector('.load-more-hint')?.textContent).toContain('(220 anteriores)')
  })

  it('lendo o histórico, entrada nova no fim não move o começo da janela', () => {
    const entries = many()
    const view = render(panel(entries))
    const feed = view.container.querySelector<HTMLElement>('.central-feed')!
    sized(feed)
    feed.scrollTop = 2_000 // longe do fim e do topo
    fireEvent.scroll(feed)
    const first = shownIds(view.container)[0]
    view.rerender(panel([...entries, req(150)]))
    expect(shownIds(view.container)[0]).toBe(first)
    expect(shownIds(view.container).at(-1)).toBe('r150')
  })
})
