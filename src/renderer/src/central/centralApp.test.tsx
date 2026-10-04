/**
 * A Central no App inteiro (Etapa 4 + Emenda A1): o id pré-definido chega à bolha
 * do destino (na hora e saindo da fila), a mensagem entregue pela Central não é
 * adotada de novo, todo turno deste PC é adotado (campo, dreno da fila, "agora",
 * celular, MCP; planejamento fora) e a fiação do atualizador da Central dos dois PCs.
 * O Stop do "não era aqui" está em centralApp.stop.test.tsx; descartes e falhas de
 * envio, em centralApp.discard.test.tsx.
 *
 * O painel da Central é um dublê (a tela completa é da Etapa 5): ele recebe o
 * controller REAL pela fábrica `centralPanel(conv)` do App.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App } from '../App'
import { UiProvider } from '../ui/UiProvider'
import {
  cbs,
  centralRequests,
  emit,
  installApi,
  openCentral,
  result,
  seedStorage,
  sendInCentral,
  sentTexts,
  stored,
  storedConv,
  toC1,
  typeInConversation,
  type FakeApi
} from './centralAppKit'

configure({ asyncUtilTimeout: 10_000 })
window.HTMLElement.prototype.scrollIntoView = vi.fn()
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// A storage de verdade; só o registro do atualizador da Central é observado (ele
// delega para o original, que segue mesclando como sempre).
const updaterSpy = vi.hoisted(() => ({ calls: [] as unknown[] }))
vi.mock('../storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storage')>()
  return {
    ...actual,
    registerCentralUpdater: (update: Parameters<typeof actual.registerCentralUpdater>[0]) => {
      updaterSpy.calls.push(update)
      actual.registerCentralUpdater(update)
    }
  }
})

vi.mock('./CentralPanel', async () => ({ CentralPanel: (await import('./centralAppKit')).MockCentralPanel }))

let api: FakeApi
beforeEach(() => {
  seedStorage()
  api = installApi(toC1)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('id pré-definido (âncora da Central) até a bolha do destino', () => {
  it('saindo na hora: a bolha do destino tem o id da âncora; a entrega não é adotada de novo', async () => {
    render(<UiProvider><App /></UiProvider>)
    await sendInCentral('o botão ficou torto')
    await waitFor(() => expect(sentTexts(api)).toEqual(['o botão ficou torto']))
    await waitFor(() => expect(storedConv('c1')?.messages.length).toBe(1))
    await waitFor(() => expect(centralRequests()[0]?.anchor?.msgId).toBe(storedConv('c1')!.messages[0].id))
    expect(centralRequests()).toHaveLength(1)
    expect(centralRequests()[0]).toMatchObject({ origin: 'central', device: 'pc-teste', state: 'delivered' })
  })

  it('saindo da fila: a conversa ocupada guarda o id; no fim do turno a bolha nasce com ele', async () => {
    render(<UiProvider><App /></UiProvider>)
    await typeInConversation('primeira')
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira']))
    await sendInCentral('segunda, pela Central')
    await waitFor(() => expect(centralRequests().find((e) => e.origin === 'central')?.state).toBe('delivered'))
    expect(sentTexts(api)).toEqual(['primeira'])
    await emit(result)
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira', 'segunda, pela Central']))
    const routed = centralRequests().find((e) => e.origin === 'central')!
    await waitFor(() => expect(storedConv('c1')?.messages.map((m) => m.id)).toContain(routed.anchor!.msgId))
    expect(centralRequests().map((e) => e.origin)).toEqual(['conversation', 'central'])
  })
})

describe('adoção de todo turno deste PC (Emenda A1)', () => {
  it('campo, dreno da fila, "agora", celular e MCP entram na Central; o planejamento não', async () => {
    render(<UiProvider><App /></UiProvider>)
    await typeInConversation('primeira')
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira']))
    await typeInConversation('segunda')
    await typeInConversation('terceira')
    fireEvent.click((await screen.findAllByRole('button', { name: 'agora' }))[1])
    await waitFor(() => expect(api.injectNow).toHaveBeenCalled())
    await emit(result)
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira', 'segunda']))
    await emit(result)
    await act(async () => cbs.inbound?.({ convId: 'c1', text: 'do celular' }))
    await waitFor(() => expect(sentTexts(api)).toContain('do celular'))
    await emit(result)
    await act(async () => cbs.mcp?.({ taskId: 't1', convId: 'c1', text: 'tarefa mcp' }))
    await waitFor(() => expect(sentTexts(api)).toContain('tarefa mcp'))
    await act(async () => cbs.inbound?.({ convId: 'p1', text: 'para o plano' }))
    await waitFor(() => expect(sentTexts(api)).toContain('para o plano'))
    await waitFor(() =>
      expect(centralRequests().map((e) => [e.text, e.injected === true])).toEqual([
        ['primeira', false],
        ['terceira', true],
        ['segunda', false],
        ['do celular', false],
        ['tarefa mcp', false]
      ])
    )
    const bubbles = storedConv('c1')!.messages
    for (const e of centralRequests()) {
      expect(e).toMatchObject({ origin: 'conversation', state: 'delivered', device: 'pc-teste', route: { target: { convId: 'c1' }, why: 'enviada na própria conversa' } })
      expect(bubbles.find((m) => m.id === e.anchor?.msgId)?.text).toBe(e.text)
    }
    expect(centralRequests().some((e) => e.anchor?.convId === 'p1' || e.anchor?.convId === 'central')).toBe(false)
  })
})

describe('a Central dos dois PCs (registerCentralUpdater)', () => {
  type Updater = (fn: (local: { central?: { entries: unknown[] } }) => unknown) => void

  // A mescla e a gravação por dono são da storage (storage.central.test.ts); aqui, a fiação no App.
  it('o App registra o atualizador; o que a storage mescla chega à tela; ao sair, desregistra', async () => {
    updaterSpy.calls.length = 0
    const view = render(<UiProvider><App /></UiProvider>)
    await waitFor(() => expect(stored().some((c) => c.id === 'central')).toBe(true))
    const update = updaterSpy.calls.at(-1) as Updater | null
    expect(typeof update).toBe('function')
    const remote = { kind: 'request', id: 'r-outro-pc', ts: 5, text: 'do outro PC', state: 'delivered', origin: 'conversation', device: 'pc-outro' }
    await act(async () => update!((local) => ({ ...local, central: { entries: [...(local.central?.entries ?? []), remote] } })))
    await openCentral()
    expect(await screen.findByRole('button', { name: 'não era aqui: do outro PC' })).toBeTruthy()
    view.unmount()
    expect(updaterSpy.calls.at(-1)).toBeNull()
  })
})
