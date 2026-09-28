// @vitest-environment node
// Reparo do espelho do transcript pela sessão: o `mirror_error` do SDK não
// bloqueia mais para sempre. O reparo roda com backoff até o banco voltar, a
// nota "Espelhamento restaurado" só sai depois da tentativa completa (replay +
// verificação, injetada por index.ts) e um envio no meio do reparo ou segue (banco
// de volta) ou volta para a fila de espera da conversa (banco ainda fora).
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

  it('verificação reprovada (erro não transitório) não restaura: sem nota, envio segue bloqueado', async () => {
    const repairMirror = vi.fn(async () => {
      throw new Error('O transcript espelhado não passou na verificação.')
    })
    const { session, internals, events, mirrorError } = makeSession(repairMirror)
    mirrorError()
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0))
    expect(internals.mirrorFailed).toBe(true)
    expect(events().some((event) => event.text === mirrorRepairText.restored)).toBe(false)
    expect(events().some((event) => event.kind === 'error' && event.text?.includes('Não consegui reparar'))).toBe(true)

    await expect(session.send('oi', undefined, 'u-1')).resolves.toBeUndefined()
    expect(internals.refreshMemoriesIfChanged).not.toHaveBeenCalled()
  })
})

describe('AgentSession: envio durante o reparo pendente', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('banco já voltou: o envio tenta o reparo na hora e segue normalmente', async () => {
    const repairMirror = vi.fn(async () => undefined)
    const { session, internals, events, mirrorError } = makeSession(repairMirror)
    mirrorError()

    // Antes do primeiro degrau do backoff: quem repara é o próprio envio.
    await expect(session.send('oi', undefined, 'u-1')).rejects.toThrow(GATE_PASSED)
    expect(repairMirror).toHaveBeenCalledTimes(1)
    expect(internals.mirrorFailed).toBe(false)
    expect(events().some((event) => event.text === mirrorRepairText.restored)).toBe(true)
    expect(events().some((event) => event.kind === 'mirror-repair' && event.state === 'deferred')).toBe(false)
  })

  it('banco ainda fora: mensagem clara, NÃO envia e devolve a mensagem para a fila de espera; sai quando o reparo concluir', async () => {
    let online = false
    const repairMirror = vi.fn(async () => {
      if (!online) throw offline()
    })
    const { session, internals, events, mirrorError } = makeSession(repairMirror)
    mirrorError()

    await expect(session.send('oi', undefined, 'u-1')).resolves.toBeUndefined()
    expect(internals.refreshMemoriesIfChanged).not.toHaveBeenCalled()
    expect(internals.turnActive).toBe(false)
    expect(events().map((event) => event.text)).toContain(mirrorRepairText.queued)
    expect(events()).toContainEqual({ kind: 'mirror-repair', state: 'deferred', messageUuid: 'u-1' })

    // O reparo automático continua; ao concluir, o renderer drena a fila.
    online = true
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(1))
    expect(internals.mirrorFailed).toBe(false)
    expect(events()).toContainEqual({ kind: 'mirror-repair', state: 'restored' })
    await expect(session.send('oi', undefined, 'u-1')).rejects.toThrow(GATE_PASSED)
  })

  it('envio interno sem fila (recuperação) espera o reparo em vez de ser devolvido', async () => {
    let online = false
    const repairMirror = vi.fn(async () => {
      if (!online) throw offline()
    })
    const { session, events, mirrorError } = makeSession(repairMirror)
    mirrorError()

    const sent = session.send('continue', undefined, 'r-1', 'pc', 'recovery').catch((error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(0)
    expect(events().map((event) => event.text)).toContain(mirrorRepairText.waiting)
    expect(events().some((event) => event.kind === 'mirror-repair' && event.state === 'deferred')).toBe(false)

    online = true
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(1))
    expect(await sent).toBe(GATE_PASSED)
  })
})
