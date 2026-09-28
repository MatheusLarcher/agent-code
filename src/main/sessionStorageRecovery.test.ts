// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createSessionStorageRecovery, type RecoverableSession } from './sessionStorageRecovery'
import type { StorageStatus } from './persistence/types'

function status(state: StorageStatus['state']): StorageStatus {
  return {
    backend: 'postgres',
    state,
    writable: state === 'postgres-ready',
    installationId: 'install-1',
    targetDatabase: 'agent-code',
    hasPassword: true
  }
}

/** Sessão cujo turno termina quando o teste manda. */
function fakeSession() {
  let finish!: () => void
  let idle = new Promise<void>((resolve) => (finish = resolve))
  const session = {
    waitForIdle: vi.fn(() => idle),
    dispose: vi.fn(),
    storageRestored: vi.fn(),
    finishTurn: () => finish(),
    idleNow: () => {
      idle = Promise.resolve()
    }
  }
  return session
}

function setup() {
  let state: StorageStatus['state'] = 'postgres-ready'
  const sessions = new Map<string, RecoverableSession>()
  const forget = vi.fn()
  const renewLeases = vi.fn()
  const onStatus = createSessionStorageRecovery({
    sessions,
    currentState: () => state,
    forget,
    renewLeases
  })
  const publish = (next: StorageStatus['state']) => {
    state = next
    onStatus(status(next))
  }
  return { sessions, forget, renewLeases, publish }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('sessões de agente numa queda do banco', () => {
  it('sessão ociosa com o banco ainda fora é descartada', async () => {
    const { sessions, forget, publish } = setup()
    const session = fakeSession()
    session.idleNow()
    sessions.set('c1', session)
    publish('postgres-offline')
    await settle()
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(sessions.has('c1')).toBe(false)
    expect(forget).toHaveBeenCalledWith('c1')
  })

  it('turno em andamento e banco de volta antes do fim: a sessão segue viva, leases renovados e reparo disparado', async () => {
    const { sessions, forget, renewLeases, publish } = setup()
    const session = fakeSession()
    sessions.set('c1', session)
    publish('postgres-offline')
    publish('postgres-ready')
    expect(renewLeases).toHaveBeenCalledTimes(1)
    expect(session.storageRestored).toHaveBeenCalledTimes(1)
    session.finishTurn()
    await settle()
    expect(session.dispose).not.toHaveBeenCalled()
    expect(sessions.get('c1')).toBe(session)
    expect(forget).not.toHaveBeenCalled()
  })

  it('sessão trocada no meio da espera (novo start) não é descartada', async () => {
    const { sessions, forget, publish } = setup()
    const old = fakeSession()
    sessions.set('c1', old)
    publish('postgres-offline')
    const replacement = fakeSession()
    sessions.set('c1', replacement)
    old.finishTurn()
    await settle()
    expect(old.dispose).not.toHaveBeenCalled()
    expect(replacement.dispose).not.toHaveBeenCalled()
    expect(sessions.get('c1')).toBe(replacement)
    expect(forget).not.toHaveBeenCalled()
  })

  it('offline publicado várias vezes na mesma queda registra uma espera só por sessão', async () => {
    const { sessions, forget, publish } = setup()
    const session = fakeSession()
    sessions.set('c1', session)
    publish('postgres-offline')
    publish('postgres-offline')
    publish('postgres-offline')
    expect(session.waitForIdle).toHaveBeenCalledTimes(1)
    session.finishTurn()
    await settle()
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(forget).toHaveBeenCalledTimes(1)
  })

  it('postgres-ready sem queda anterior (abertura normal) não renova nem dispara nada', () => {
    const { sessions, renewLeases, publish } = setup()
    const session = fakeSession()
    sessions.set('c1', session)
    publish('postgres-ready')
    expect(renewLeases).not.toHaveBeenCalled()
    expect(session.storageRestored).not.toHaveBeenCalled()
  })
})
