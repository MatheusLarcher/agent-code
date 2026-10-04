/**
 * A Central no App inteiro — o Stop do "não era aqui", caso a caso pelo que o main
 * manda (agentSession.ts): a conversa fica "parando" (ocupada para todo despacho)
 * até o terminal do turno parado — o `result` com uma carência curta para o
 * `error` do fim do stream, ou o próprio `error`. Sem turno para parar (o envio
 * nem saiu), não há terminal a esperar. Sem saída do modelo e sem terminal (o Stop
 * pegou a mensagem antes de o turno começar), a reserva de 3 s solta. Depois de
 * soltar, NADA é engolido: o terminal seguinte é do turno que saiu da fila.
 * Relógio falso só no trecho da espera (`flush` deixa as promessas assentarem).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ChatEvent } from '@shared/ipc'
import { App } from '../App'
import { UiProvider } from '../ui/UiProvider'
import { STOP_GRACE_MS, STOP_SETTLE_MS } from './stopHold'
import {
  cbs,
  centralRequests,
  emit,
  installApi,
  result,
  seedStorage,
  sendInCentral,
  sends,
  sentTexts,
  stored,
  streamEnd,
  toC1,
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

const settle = (ms = 50) => act(async () => new Promise<void>((resolve) => setTimeout(resolve, ms)))
/** Com o relógio falso: deixa as promessas (o window.api falso resolve na hora) assentarem. */
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
/** O main entrega o limite de uso como um `result` com erro, sem texto antes (agentSession.ts:2422-2426). */
const usageLimit: ChatEvent = { kind: 'result', id: 'lim', isError: true, usageExhausted: true, text: "You've hit your usage limit.", durationMs: 1 }
const said = (id: string, text: string): ChatEvent => ({ kind: 'assistant-text', id, text, final: true })
const c1 = () => stored().find((c) => c.id === 'c1') as { recovery?: { reason: string }; messages: StoredMessage[] } | undefined
const bubble = (text: string) => c1()?.messages.find((m) => m.kind === 'user' && m.text === text)

/** c1 roda "primeira" (da Central) e tem "segunda" (da Central) na fila. `output`: o turno já falou. */
async function runningPlusQueued(output: boolean): Promise<void> {
  render(<UiProvider><App /></UiProvider>)
  await sendInCentral('primeira')
  await waitFor(() => expect(sentTexts(api)).toEqual(['primeira']))
  if (output) await emit(said('a1', 'Olhando o filtro.'))
  await sendInCentral('segunda')
  await waitFor(() => expect(centralRequests()[1]?.state).toBe('delivered'))
}
/** Relógio falso daqui em diante, e o "não era aqui" na primeira. */
async function notHereOnFirst(): Promise<void> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  fireEvent.click(screen.getByRole('button', { name: 'não era aqui: primeira' }))
  await flush()
  expect(api.interrupt).toHaveBeenCalledWith('c1')
}
/** O turno que saiu da fila bate no limite de uso: a falha aparece (erro na bolha + retomada), nada fica preso. */
async function expectLimitShows(text: string): Promise<void> {
  await emit(usageLimit)
  await advance(2000) // a gravação (com atraso) leva o estado ao "banco"
  expect(bubble(text)?.error).toBeTruthy()
  expect(c1()?.recovery).toMatchObject({ reason: 'limit' })
}

describe('Stop do "não era aqui" com o turno rodando: "parando" até o terminal do turno parado', () => {
  it('Stop limpo (só o result): envios no meio esperam, a fila sai depois da carência; o limite de uso do turno seguinte aparece', async () => {
    await runningPlusQueued(true)
    await notHereOnFirst()
    // No meio da espera: celular e MCP enfileiram; o "agora" não entra no turno parado.
    await act(async () => cbs.inbound?.({ convId: 'c1', text: 'do celular' }))
    await act(async () => cbs.mcp?.({ taskId: 't1', convId: 'c1', text: 'tarefa mcp' }))
    // (consultas síncronas daqui em diante: o waitFor não anda com o relógio falso)
    fireEvent.click(screen.getAllByTitle(/^Conversa — duplo-clique para renomear$/)[0])
    await flush()
    fireEvent.click(screen.getAllByRole('button', { name: 'agora' })[0])
    await flush()
    await advance(STOP_SETTLE_MS * 3) // a reserva curta não solta: o turno falou, o terminal dele vem
    expect(sentTexts(api)).toEqual(['primeira'])
    expect(api.injectNow).not.toHaveBeenCalled()
    await emit(result) // o result do turno parado
    await advance(STOP_GRACE_MS - 1)
    expect(sentTexts(api)).toEqual(['primeira'])
    await advance(1)
    expect(sentTexts(api)).toEqual(['primeira', 'segunda'])
    await expectLimitShows('segunda')
  })

  it('Stop limpo com o error do fim do stream: a fila sai no error, sem esperar a carência, e a bolha da segunda não herda erro', async () => {
    await runningPlusQueued(true)
    await notHereOnFirst()
    await emit(result)
    await emit(streamEnd)
    await flush()
    expect(sentTexts(api)).toEqual(['primeira', 'segunda'])
    await advance(2000)
    expect(bubble('segunda')).toBeTruthy()
    expect(bubble('segunda')?.error).toBeUndefined()
    expect(c1()?.recovery).toBeUndefined()
    await emit(said('a2', 'feito'))
    await emit(result)
    await flush()
    expect(sentTexts(api)).toEqual(['primeira', 'segunda'])
  })

  it('o CLI ainda produzindo depois do recibo (recibo por prazo): a reserva de 3 s não solta; só o terminal do turno parado', async () => {
    await runningPlusQueued(true)
    await notHereOnFirst()
    await advance(STOP_SETTLE_MS * 2)
    await emit(said('a3', 'ainda escrevendo'))
    await advance(STOP_SETTLE_MS * 2)
    expect(sentTexts(api)).toEqual(['primeira'])
    await emit(result)
    await advance(STOP_GRACE_MS)
    expect(sentTexts(api)).toEqual(['primeira', 'segunda'])
  })

  it('Stop antes de o turno começar (sem saída, sem terminal): a fila sai 3000 ms depois do recibo, nem 1 ms antes; o result seguinte é do turno que saiu', async () => {
    await runningPlusQueued(false)
    await notHereOnFirst()
    await advance(STOP_SETTLE_MS - 1)
    expect(sentTexts(api)).toEqual(['primeira'])
    await advance(1)
    expect(sentTexts(api)).toEqual(['primeira', 'segunda'])
    await expectLimitShows('segunda')
  })
})

describe('"não era aqui" enquanto o destino ainda conecta (sem query: nada a esperar)', () => {
  it('a mensagem parada no connect nunca sai em c1; vai só para o destino escolhido, que fica com a âncora', async () => {
    let finishStart!: (value: unknown) => void
    api.startAgent.mockImplementationOnce(() => new Promise((resolve) => (finishStart = resolve)))
    render(<UiProvider><App /></UiProvider>)
    await sendInCentral('R')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(centralRequests()[0]?.state).toBe('delivered'))
    fireEvent.click(await screen.findByRole('button', { name: 'não era aqui: R' }))
    await waitFor(() => expect(api.interrupt).toHaveBeenCalledWith('c1'))
    fireEvent.click(await screen.findByRole('button', { name: 'escolher 0: R' }))
    await waitFor(() => expect(sends(api)).toHaveLength(1))
    const [[dest]] = sends(api)
    expect(dest).not.toBe('c1')
    await act(async () => finishStart({ ok: true }))
    await settle()
    expect(sends(api)).toEqual([[dest, 'R']])
    await waitFor(() => expect(centralRequests()[0]).toMatchObject({ state: 'delivered', anchor: { convId: dest } }))
  })

  it('com fila: a fila sai já no recibo (sem reserva), só a segunda vai a c1, e o limite de uso dela aparece', async () => {
    let finishStart!: (value: unknown) => void
    api.startAgent.mockImplementationOnce(() => new Promise((resolve) => (finishStart = resolve)))
    render(<UiProvider><App /></UiProvider>)
    await sendInCentral('primeira')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await sendInCentral('segunda')
    await waitFor(() => expect(centralRequests()[1]?.state).toBe('delivered'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fireEvent.click(screen.getByRole('button', { name: 'não era aqui: primeira' }))
    await flush()
    await act(async () => finishStart({ ok: true }))
    await flush()
    expect(sends(api)).toEqual([['c1', 'segunda']])
    await expectLimitShows('segunda')
  })
})
