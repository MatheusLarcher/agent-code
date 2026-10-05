/**
 * A fila só manda o próximo item quando o main confirma o fim REAL do turno
 * anterior (`waitTurnEnd`, central/queueHandoff.ts) — o `result`/`error` sai antes
 * do fim do stream, do handoff e do lease solto. E o 2º terminal atrasado do turno
 * que acabou (com o id dele, ou sem id durante a espera) não derruba o seguinte.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, configure, render, screen, waitFor } from '@testing-library/react'
import type { ChatEvent, TurnEndWait } from '@shared/ipc'
import { App } from '../App'
import { UiProvider } from '../ui/UiProvider'
import { cbs, emit, installApi, seedStorage, sentTexts, stored, streamEnd, toC1, typeInConversation, type FakeApi, type StoredMessage } from './centralAppKit'

configure({ asyncUtilTimeout: 10_000 })
window.HTMLElement.prototype.scrollIntoView = vi.fn()
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

vi.mock('./CentralPanel', async () => ({ CentralPanel: (await import('./centralAppKit')).MockCentralPanel }))

let api: FakeApi
/** Cada chamada do `waitTurnEnd` fica pendente até o teste soltar. */
let ends: Array<(v: TurnEndWait) => void>
let waitTurnEnd: ReturnType<typeof vi.fn>
beforeEach(() => {
  seedStorage()
  api = installApi(toC1)
  ends = []
  waitTurnEnd = vi.fn(() => new Promise<TurnEndWait>((resolve) => ends.push(resolve)))
  Object.assign(window.api as object, { waitTurnEnd })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const flush = () =>
  act(async () => {
    for (let i = 0; i < 60; i++) await Promise.resolve()
  })
/** O main confirma: o turno anterior acabou de fato. */
const turnEnded = async (): Promise<void> => {
  await waitFor(() => expect(ends.length).toBeGreaterThan(0))
  await act(async () => ends.shift()?.({ settled: true, reason: 'idle' }))
  await flush()
}
const uuidOf = (text: string): string => {
  const call = api.sendMessage.mock.calls.find((c: unknown[]) => c[1] === text)
  if (!call) throw new Error(`"${text}" não foi enviada`)
  return call[5] as string
}
const taskOf = (text: string): unknown => api.sendMessage.mock.calls.find((c: unknown[]) => c[1] === text)?.[7]
const done = (ids: string[]): ChatEvent => ({ kind: 'result', id: `ok-${ids[0]}`, isError: false, text: 'ok', durationMs: 1, turnIds: ids })
const failed = (ids: string[]): ChatEvent => ({ kind: 'result', id: `x-${ids[0]}`, isError: true, text: 'API Error: 529 overloaded', durationMs: 1, turnIds: ids })
const died = (ids: string[]): ChatEvent => ({ kind: 'error', id: `fim-${ids[0]}`, text: 'Agent stopped: aborted', turnIds: ids })
const bubble = (text: string): StoredMessage | undefined =>
  (stored().find((c) => c.id === 'c1') as { messages: StoredMessage[] } | undefined)?.messages.find((m) => m.kind === 'user' && m.text === text)

/** c1 roda "primeira" com as tarefas t1 e t2 do Forgia na fila. */
async function runningWithTwoTasks(): Promise<void> {
  render(<UiProvider><App /></UiProvider>)
  await typeInConversation('primeira')
  await waitFor(() => expect(sentTexts(api)).toEqual(['primeira']))
  await act(async () => {
    cbs.mcp?.({ taskId: 't1', convId: 'c1', text: 'tarefa 1' })
    cbs.mcp?.({ taskId: 't2', convId: 'c1', text: 'tarefa 2' })
  })
  await flush()
  expect(sentTexts(api)).toEqual(['primeira'])
}

describe('fila: o próximo item espera o fim real do turno anterior', () => {
  it('sucesso: o result não manda o próximo; o sinal do main manda', async () => {
    await runningWithTwoTasks()
    await emit(done([uuidOf('primeira')]))
    await flush()
    expect(waitTurnEnd).toHaveBeenCalledWith('c1')
    expect(sentTexts(api)).toEqual(['primeira'])
    // A bolha da tarefa já aparece (a conversa segue ocupada), mas o envio espera.
    await waitFor(() => expect(screen.getAllByText('tarefa 1').length).toBeGreaterThan(0))
    await turnEnded()
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira', 'tarefa 1']))
    expect(taskOf('tarefa 1')).toBe('t1')
  })

  it('erro na tarefa 1 (regra 2) com a sessão ainda ocupada: a tarefa 2 só sai depois do sinal de ocioso', async () => {
    await runningWithTwoTasks()
    await emit(done([uuidOf('primeira')]))
    await turnEnded()
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira', 'tarefa 1']))
    const t1 = uuidOf('tarefa 1')
    await emit(failed([t1]))
    await flush()
    await waitFor(() => expect(waitTurnEnd).toHaveBeenCalledTimes(2))
    expect(sentTexts(api)).toEqual(['primeira', 'tarefa 1'])
    // Rabo sem id do turno que acabou (fim do stream) durante a espera: ignorado.
    await emit(streamEnd)
    await flush()
    expect(sentTexts(api)).toEqual(['primeira', 'tarefa 1'])
    await turnEnded()
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira', 'tarefa 1', 'tarefa 2']))
    expect(taskOf('tarefa 2')).toBe('t2')
    // O rabo `error` derrubou a sessão: a tarefa 2 sai numa sessão nova.
    expect(api.startAgent).toHaveBeenCalledTimes(2)
  })

  it('2º terminal atrasado da tarefa 1 (com o id dela) depois de a tarefa 2 sair: não a derruba nem despacha outra', async () => {
    await runningWithTwoTasks()
    await emit(done([uuidOf('primeira')]))
    await turnEnded()
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira', 'tarefa 1']))
    const t1 = uuidOf('tarefa 1')
    await emit(failed([t1]))
    await turnEnded()
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira', 'tarefa 1', 'tarefa 2']))
    await typeInConversation('depois')
    await flush()
    await emit(died([t1]))
    await flush()
    // A tarefa 2 segue rodando: sem erro, e a mensagem da fila não saiu.
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 1600)))
    expect(bubble('tarefa 2')?.error).toBeUndefined()
    expect(sentTexts(api)).toEqual(['primeira', 'tarefa 1', 'tarefa 2'])
    expect(waitTurnEnd).toHaveBeenCalledTimes(2)
    // O fim real da tarefa 2 é que solta a fila.
    await emit(done([uuidOf('tarefa 2')]))
    await turnEnded()
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira', 'tarefa 1', 'tarefa 2', 'depois']))
  })

  it('sinal que falha ou main sem o canal: a fila não trava', async () => {
    waitTurnEnd.mockImplementation(() => Promise.reject(new Error('canal ausente')))
    await runningWithTwoTasks()
    await emit(done([uuidOf('primeira')]))
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira', 'tarefa 1']))
  })
})
