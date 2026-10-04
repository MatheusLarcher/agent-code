/**
 * Identidade de turno no App inteiro (`turnIds`, shared/ipc.ts): o main diz de qual
 * envio é cada terminal, então o terminal ATRASADO de um turno parado nunca fecha
 * nem marca como falho o turno que saiu da fila depois dele — e o terminal do turno
 * corrente nunca é engolido. Os três casos que a espera por tempo (stopHold.ts) não
 * resolvia: turno mudo cujo `result` chega depois da reserva de 3 s; `error` do fim
 * do stream depois da carência de 500 ms; turno que falou e ficou calado > 30 s.
 * Relógio falso só no trecho da espera (`flush` deixa as promessas assentarem).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ChatEvent } from '@shared/ipc'
import { App } from '../App'
import { UiProvider } from '../ui/UiProvider'
import { STOP_GRACE_MS, STOP_SAFETY_MS, STOP_SETTLE_MS } from './stopHold'
import {
  cbs,
  centralRequests,
  emit,
  installApi,
  seedStorage,
  sendInCentral,
  sentTexts,
  stored,
  toC1,
  typeInConversation,
  type FakeApi,
  type StoredMessage
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
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const flush = () =>
  act(async () => {
    for (let i = 0; i < 60; i++) await Promise.resolve()
  })
const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
  await flush()
}

/** O `messageUuid` com que o App mandou `text` ao main (6º argumento do sendMessage). */
const uuidOf = (text: string): string => {
  const call = api.sendMessage.mock.calls.find((c: unknown[]) => c[1] === text)
  if (!call) throw new Error(`"${text}" não foi enviada`)
  return call[5] as string
}
/** O `result` do turno interrompido (o CLI fecha o turno parado com erro). */
const aborted = (ids: string[]): ChatEvent => ({ kind: 'result', id: `ab-${ids[0]}`, isError: true, text: 'error_during_execution', durationMs: 1, turnIds: ids })
const done = (ids: string[]): ChatEvent => ({ kind: 'result', id: `ok-${ids[0]}`, isError: false, text: 'ok', durationMs: 1, turnIds: ids })
const died = (ids: string[]): ChatEvent => ({ kind: 'error', id: `fim-${ids[0]}`, text: 'Agent stopped: aborted', turnIds: ids })
const said = (id: string, text: string, ids: string[]): ChatEvent => ({ kind: 'assistant-text', id, text, final: true, turnIds: ids })
const limitOf = (ids: string[]): ChatEvent => ({ kind: 'result', id: 'lim', isError: true, usageExhausted: true, text: "You've hit your usage limit.", durationMs: 1, turnIds: ids })

const c1 = () =>
  stored().find((c) => c.id === 'c1') as
    | { recovery?: { reason: string }; messages: StoredMessage[]; tokens: { output: number; cost: number } }
    | undefined
const bubble = (text: string) => c1()?.messages.find((m) => m.kind === 'user' && m.text === text)

/** c1 roda "primeira" (da Central) com "segunda" e "terceira" (da Central) na fila. */
async function runningPlusTwoQueued(output: boolean): Promise<void> {
  render(<UiProvider><App /></UiProvider>)
  await sendInCentral('primeira')
  await waitFor(() => expect(sentTexts(api)).toEqual(['primeira']))
  if (output) await emit(said('a1', 'Olhando o filtro.', [uuidOf('primeira')]))
  await sendInCentral('segunda')
  await waitFor(() => expect(centralRequests()[1]?.state).toBe('delivered'))
  await sendInCentral('terceira')
  await waitFor(() => expect(centralRequests()[2]?.state).toBe('delivered'))
}
/** Relógio falso daqui em diante, e o "não era aqui" na primeira (o Stop que mantém a fila). */
async function notHereOnFirst(): Promise<void> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  fireEvent.click(screen.getByRole('button', { name: 'não era aqui: primeira' }))
  await flush()
  expect(api.interrupt).toHaveBeenCalledWith('c1')
}
/** O turno da segunda segue aberto: sem erro, sem retomada, e a terceira não saiu. */
async function secondStillRunning(): Promise<void> {
  await advance(2000) // a gravação (com atraso) leva o estado ao "banco"
  expect(sentTexts(api)).toEqual(['primeira', 'segunda'])
  expect(bubble('segunda')?.error).toBeUndefined()
  expect(c1()?.recovery).toBeUndefined()
}

describe('terminal atrasado do turno parado, identificado pelo main: nunca é do turno seguinte', () => {
  it('(1) turno mudo cujo result chega > 3 s depois do recibo: descartado; o fim real da segunda solta a terceira', async () => {
    await runningPlusTwoQueued(false)
    const first = uuidOf('primeira')
    await notHereOnFirst()
    await advance(STOP_SETTLE_MS) // a reserva curta solta: a segunda sai
    expect(sentTexts(api)).toEqual(['primeira', 'segunda'])
    const second = uuidOf('segunda')
    await advance(1000)
    await emit(aborted([first]))
    await secondStillRunning()
    await emit(said('a2', 'feito', [second]))
    await emit(done([second]))
    await flush()
    expect(sentTexts(api)).toEqual(['primeira', 'segunda', 'terceira'])
  })

  it('(2) error do fim do stream > 500 ms depois do result: descartado do turno da segunda', async () => {
    await runningPlusTwoQueued(true)
    const first = uuidOf('primeira')
    await notHereOnFirst()
    await emit(aborted([first]))
    await advance(STOP_GRACE_MS)
    expect(sentTexts(api)).toEqual(['primeira', 'segunda'])
    await advance(500)
    await emit(died([first]))
    await secondStillRunning()
  })

  it('(3) turno que falou e calou > 30 s: a reserva longa solta; o result tardio é descartado e o limite real da segunda aparece', async () => {
    await runningPlusTwoQueued(true)
    const first = uuidOf('primeira')
    await notHereOnFirst()
    await advance(STOP_SAFETY_MS)
    expect(sentTexts(api)).toEqual(['primeira', 'segunda'])
    const second = uuidOf('segunda')
    await emit(aborted([first]))
    await secondStillRunning()
    await emit(limitOf([second]))
    await advance(2000)
    expect(bubble('segunda')?.error).toBeTruthy()
    expect(c1()?.recovery).toMatchObject({ reason: 'limit' })
  })
})

describe('o terminal identificado do turno parado solta na hora; o do turno corrente nunca é engolido', () => {
  it('result com o id do turno parado: a fila sai sem esperar a carência', async () => {
    await runningPlusTwoQueued(true)
    const first = uuidOf('primeira')
    await notHereOnFirst()
    await emit(aborted([first]))
    await flush()
    expect(sentTexts(api)).toEqual(['primeira', 'segunda'])
  })

  it('o error que carrega o id da segunda (a query morreu com ela) é dela: aparece como falha', async () => {
    await runningPlusTwoQueued(true)
    const first = uuidOf('primeira')
    await notHereOnFirst()
    await emit(aborted([first]))
    await flush()
    await emit(died([uuidOf('segunda')]))
    await advance(2000)
    expect(bubble('segunda')?.error).toBeTruthy()
    expect(c1()?.recovery).toBeTruthy()
  })

  it('o result tardio do turno parado ainda conta tokens e custo da conversa', async () => {
    await runningPlusTwoQueued(true)
    const first = uuidOf('primeira')
    await notHereOnFirst()
    await advance(STOP_SAFETY_MS)
    expect(sentTexts(api)).toEqual(['primeira', 'segunda'])
    await emit({ ...aborted([first]), usage: { input: 3, output: 7, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.25 } as ChatEvent)
    await secondStillRunning()
    expect(c1()?.tokens).toMatchObject({ output: 7, cost: 0.25 })
  })
})

describe('Stop comum (descarta a fila) e uma mensagem nova logo depois', () => {
  it('o result atrasado do turno parado não fecha o turno da mensagem nova', async () => {
    render(<UiProvider><App /></UiProvider>)
    await typeInConversation('primeira')
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira']))
    const first = uuidOf('primeira')
    await act(async () => cbs.remoteInterrupt?.({ convId: 'c1' }))
    await typeInConversation('nova')
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira', 'nova']))
    await typeInConversation('outra')
    await emit(done([first]))
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 50)))
    expect(sentTexts(api)).toEqual(['primeira', 'nova'])
    await emit(done([uuidOf('nova')]))
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira', 'nova', 'outra']))
  })
})
