// @vitest-environment node
// Reparo do espelho do transcript pela sessão: o `mirror_error` do SDK não
// bloqueia a conversa. O reparo roda com backoff até o banco voltar, a
// nota "Espelhamento restaurado" só sai depois da tentativa completa (replay +
// verificação, injetada por index.ts) e um envio no meio do reparo segue na hora
// (o SDK continua pelo transcript local; só a retomada pelo banco espera).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSession } from './agentSession'
import type { BrowserController } from './browserController'
import { mirrorRepairText } from './mirrorRepair'
import { reconnectDelayMs } from './persistence/storageReconnect'

const offline = (): Error => Object.assign(new Error('timeout exceeded when trying to connect'), { code: 'ETIMEDOUT' })
const GATE_PASSED = 'passou do portão do espelho'

interface Internals {
  handleMessage(message: unknown): void
  mirrorFailed: boolean
  turnActive: boolean
  refreshMemoriesIfChanged: () => Promise<unknown>
}

function makeSession(repairMirror: (sessionId: string, configDir: string | undefined) => Promise<void>) {
  const emit = vi.fn()
  const session = new AgentSession(
    { convId: 'conv-espelho', cwd: '/proj' }, {} as BrowserController, emit, vi.fn(), vi.fn(),
    undefined, undefined, undefined, undefined, undefined, undefined, repairMirror
  )
  const internals = session as unknown as Internals
  // Só interessa se o envio passa do portão do espelho: o resto do send (catálogos,
  // prompt, stream do SDK) é coberto em agentSession.test.ts.
  internals.refreshMemoriesIfChanged = vi.fn(async () => {
    throw new Error(GATE_PASSED)
  })
  const events = (): Array<{ kind: string; text?: string; state?: string; messageUuid?: string }> =>
    emit.mock.calls.map((call) => call[0])
  const mirrorError = (): void =>
    internals.handleMessage({
      type: 'system',
      subtype: 'mirror_error',
      error: 'timeout exceeded when trying to connect',
      key: { projectKey: 'conv-espelho', sessionId: '11111111-1111-4111-8111-111111111111' }
    })
  return { session, internals, emit, events, mirrorError }
}

describe('AgentSession: mirror_error → reparo → desbloqueio', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reparo automático falha enquanto o banco está fora e, quando volta, restaura com a nota e libera o envio', async () => {
    const repairMirror = vi.fn(async () => undefined)
    repairMirror.mockRejectedValueOnce(offline()).mockRejectedValueOnce(offline())
    const { session, internals, events, mirrorError } = makeSession(repairMirror)

    mirrorError()
    expect(internals.mirrorFailed).toBe(true)
    expect(events().map((event) => event.text)).toContain(mirrorRepairText.started('timeout exceeded when trying to connect'))
    // Outro lote descartado na mesma queda não abre outro reparo nem outro aviso.
    mirrorError()
    expect(events().filter((event) => event.kind === 'status')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0))
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(1))
    expect(repairMirror).toHaveBeenCalledTimes(2)
    expect(internals.mirrorFailed).toBe(true)
    expect(events().some((event) => event.text === mirrorRepairText.restored)).toBe(false)

    await vi.advanceTimersByTimeAsync(reconnectDelayMs(2))
    expect(repairMirror).toHaveBeenCalledTimes(3)
    expect(repairMirror).toHaveBeenLastCalledWith('11111111-1111-4111-8111-111111111111', undefined)
    expect(internals.mirrorFailed).toBe(false)
    expect(events().filter((event) => event.text === mirrorRepairText.restored)).toHaveLength(1)
    expect(events()).toContainEqual({ kind: 'mirror-repair', state: 'restored' })

    await expect(session.send('oi', undefined, 'u-1')).rejects.toThrow(GATE_PASSED)
  })

  it('verificação reprovada (erro não transitório) não restaura nem bloqueia: o envio segue pelo transcript local', async () => {
    const repairMirror = vi.fn(async () => {
      throw new Error('O transcript espelhado não passou na verificação.')
    })
    const { session, internals, events, mirrorError } = makeSession(repairMirror)
    mirrorError()
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0))
    expect(internals.mirrorFailed).toBe(true)
    expect(events().some((event) => event.text === mirrorRepairText.restored)).toBe(false)
    expect(events().some((event) => event.kind === 'error' && event.text?.includes('Não consegui reparar'))).toBe(true)

    await expect(session.send('oi', undefined, 'u-1')).rejects.toThrow(GATE_PASSED)
  })
})

describe('AgentSession: envio durante o reparo pendente (o envio não espera o espelho)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('banco ainda fora: a mensagem segue na hora, nada volta para a fila; o reparo continua em segundo plano', async () => {
    let online = false
    const repairMirror = vi.fn(async () => {
      if (!online) throw offline()
    })
    const { session, internals, events, mirrorError } = makeSession(repairMirror)
    mirrorError()

    await expect(session.send('oi', undefined, 'u-1')).rejects.toThrow(GATE_PASSED)
    expect(repairMirror).not.toHaveBeenCalled() // o envio não tenta o reparo nem espera por ele
    expect(events().some((event) => event.kind === 'mirror-repair' && event.state === 'deferred')).toBe(false)
    expect(internals.mirrorFailed).toBe(true)

    // O reparo automático segue o backoff dele e restaura quando o banco volta.
    online = true
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0))
    expect(internals.mirrorFailed).toBe(false)
    expect(events()).toContainEqual({ kind: 'mirror-repair', state: 'restored' })
  })

  it('envio interno (recuperação) também segue na hora', async () => {
    const repairMirror = vi.fn(async () => {
      throw offline()
    })
    const { session, mirrorError } = makeSession(repairMirror)
    mirrorError()
    await expect(session.send('continue', undefined, 'r-1', 'pc', 'recovery')).rejects.toThrow(GATE_PASSED)
  })

  it('a verificação do turno anterior (handoff) não segura o envio seguinte', async () => {
    const { session, internals } = makeSession(vi.fn(async () => undefined))
    ;(internals as unknown as { handoffReady: Promise<void> }).handoffReady = new Promise<void>(() => undefined)
    await expect(session.send('oi', undefined, 'u-2')).rejects.toThrow(GATE_PASSED)
  })
})
