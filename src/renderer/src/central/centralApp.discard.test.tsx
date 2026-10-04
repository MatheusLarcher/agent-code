/**
 * A Central no App inteiro — o que sai do destino sem rodar e o envio que falha:
 * item da Central descartado da fila (Stop comum, lixeira, conversa apagada) volta
 * a perguntar em vez de ficar "entregue" para sempre; e, num envio que falha, a
 * Central é a única dona do reenvio do pedido dela (o destino não oferece "Tentar
 * de novo" para ele), enquanto o reenvio de um turno comum entra na Central (A1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App } from '../App'
import { UiProvider } from '../ui/UiProvider'
import {
  KEY,
  cbs,
  centralRequests,
  conv,
  emit,
  installApi,
  openCentral,
  openConversation,
  result,
  seedStorage,
  sendInCentral,
  sends,
  sentTexts,
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

const routed = () => centralRequests().find((e) => e.origin === 'central')
const settle = (ms = 50) => act(async () => new Promise<void>((resolve) => setTimeout(resolve, ms)))

/** c1 ocupada com um turno do campo; a Central entrega um pedido que fica na fila de c1. */
async function queuedFromCentral(): Promise<void> {
  render(<UiProvider><App /></UiProvider>)
  await typeInConversation('primeira')
  await waitFor(() => expect(sentTexts(api)).toEqual(['primeira']))
  await sendInCentral('segunda, pela Central')
  await waitFor(() => expect(routed()?.state).toBe('delivered'))
}

describe('item da Central descartado da fila do destino', () => {
  it('Stop comum (descarta a fila): o pedido volta a perguntar e nunca sai em c1', async () => {
    await queuedFromCentral()
    await act(async () => cbs.remoteInterrupt?.({ convId: 'c1' }))
    await waitFor(() => expect(routed()).toMatchObject({ state: 'asking', ask: { reason: 'target-missing' } }))
    expect(routed()).not.toHaveProperty('anchor')
    await emit(result)
    expect(sentTexts(api)).toEqual(['primeira'])
  })

  it('lixeira na fila do destino: idem', async () => {
    await queuedFromCentral()
    await openConversation('Conversa')
    fireEvent.click((await screen.findAllByTitle('Remover da fila'))[0])
    await waitFor(() => expect(routed()).toMatchObject({ state: 'asking', ask: { reason: 'target-missing' } }))
    await emit(result)
    expect(sentTexts(api)).toEqual(['primeira'])
  })

  it('conversa apagada com o pedido na fila: idem (sem oferecer a conversa apagada)', async () => {
    await queuedFromCentral()
    await act(async () => cbs.remoteAction?.({ type: 'delete', convId: 'c1' }))
    await waitFor(() => expect(routed()).toMatchObject({ state: 'asking', ask: { reason: 'target-missing' } }))
    expect(api.centralRoute).toHaveBeenLastCalledWith(expect.objectContaining({ forceAsk: true, exclude: expect.objectContaining({ convId: 'c1' }) }))
  })
})

describe('envio que falha: a Central é a única dona do reenvio do pedido dela', () => {
  it('o envio do pedido da Central falha: a bolha com "Tentar de novo" sai de c1, a Central pergunta e a escolha entrega uma vez', async () => {
    api.sendMessage.mockRejectedValueOnce(new Error('sem sessão viva'))
    render(<UiProvider><App /></UiProvider>)
    await sendInCentral('R')
    await waitFor(() => expect(routed()).toMatchObject({ state: 'asking', ask: { reason: 'target-missing' } }))
    await openConversation('Conversa')
    await settle()
    expect(screen.queryByRole('button', { name: /Tentar de novo/ })).toBeNull()
    await waitFor(() => expect(storedConv('c1')?.messages.some((m) => m.text === 'R')).toBe(false))
    await openCentral()
    fireEvent.click(await screen.findByRole('button', { name: 'escolher 0: R' }))
    await waitFor(() => expect(sends(api).filter(([, text]) => text === 'R')).toHaveLength(2))
    const [first, second] = sends(api).filter(([, text]) => text === 'R')
    expect(first[0]).toBe('c1')
    expect(second[0]).not.toBe('c1')
    await settle()
    expect(sends(api).filter(([, text]) => text === 'R')).toHaveLength(2)
    await waitFor(() => expect(routed()).toMatchObject({ state: 'delivered', anchor: { convId: second[0] } }))
  })

  it('"Tentar de novo" de um turno comum entra na Central (A1), sem duplicar o que já foi adotado', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([conv('c1', 'Conversa', '/proj', { messages: [{ kind: 'user', id: 'u-velha', text: 'antiga', error: 'Falha ao enviar: sem sessão' }] })])
    )
    render(<UiProvider><App /></UiProvider>)
    fireEvent.click(await screen.findByRole('button', { name: /Tentar de novo/ }))
    await waitFor(() => expect(sentTexts(api)).toEqual(['antiga']))
    await waitFor(() =>
      expect(centralRequests()).toEqual([expect.objectContaining({ origin: 'conversation', text: 'antiga', anchor: { convId: 'c1', msgId: 'u-velha' } })])
    )
    // Um turno comum que falha agora: adotado no envio; o reenvio não duplica.
    await emit(result)
    api.sendMessage.mockRejectedValueOnce(new Error('sem sessão viva'))
    await typeInConversation('oi')
    fireEvent.click(await screen.findByRole('button', { name: /Tentar de novo/ }))
    await waitFor(() => expect(sentTexts(api)).toEqual(['antiga', 'oi', 'oi']))
    await waitFor(() => expect(centralRequests().filter((e) => e.text === 'oi')).toHaveLength(1))
    await settle(600)
    expect(centralRequests().filter((e) => e.text === 'oi')).toHaveLength(1)
  })
})
