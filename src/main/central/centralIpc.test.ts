// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Channels } from '../../shared/ipc'
import type { CentralCorrection, CentralRouteRequest } from '../../shared/central'

// O cliente de verdade puxa a config (electron): aqui ele é de mentira, e é o PADRÃO do IPC.
const client = vi.hoisted(() => ({ askTypeSafe: vi.fn(), typeSafeConfigured: vi.fn() }))
vi.mock('../typesafe/client', () => client)

import { registerCentralIpc, type CentralIpcDeps, type CentralIpcListener } from './centralIpc'
import type { CentralChangeHandler, CentralLoadQuery } from './centralIndexStore'
import type { VersionedConversationLike } from './centralIndex'
import { PROJ_A, PROJ_B, SANDBOX_ROOT, conv, deferred } from './centralStoreTestKit'

const pick = (choice: string, confidence: number) => ({ type: 'choice', choice, confidence, probabilities: { [choice]: confidence } })

const a1Target = { kind: 'conversation', convId: 'a1', cwd: PROJ_A, project: 'proj-a', title: 'Login torto', sandbox: false }

let dir = ''

beforeEach(async () => {
  client.askTypeSafe.mockReset()
  client.typeSafeConfigured.mockReset()
  client.typeSafeConfigured.mockResolvedValue(true)
  dir = await mkdtemp(join(tmpdir(), 'ac-central-ipc-'))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

function setup(over: Partial<CentralIpcDeps> = {}, rows: VersionedConversationLike[] = [conv('a1', { title: 'Login torto' }), conv('b1', { title: 'API', cwd: PROJ_B })]) {
  const handlers = new Map<string, CentralIpcListener>()
  const listeners = new Set<CentralChangeHandler>()
  const load = vi.fn(async (_query?: CentralLoadQuery): Promise<VersionedConversationLike[]> => rows)
  const handle = registerCentralIpc({
    handle: (channel, listener) => void handlers.set(channel, listener),
    load,
    subscribe: (handler) => {
      listeners.add(handler)
      return () => void listeners.delete(handler)
    },
    sandboxRoot: () => SANDBOX_ROOT,
    isSandbox: (cwd) => cwd.startsWith(SANDBOX_ROOT),
    correctionsFile: () => join(dir, 'central', 'corrections.jsonl'),
    exists: () => true,
    indexDeadlineMs: 40,
    ...over
  })
  const route = (payload: unknown) => Promise.resolve(handlers.get(Channels.centralRoute)!(null, payload))
  const correct = (payload: unknown) => Promise.resolve(handlers.get(Channels.centralCorrection)!(null, payload))
  const emit = (...ids: string[]): void => {
    for (const listener of listeners) listener(ids.map((entityId) => ({ entity: 'conversation', entityId })))
  }
  return { handlers, listeners, load, handle, route, correct, emit }
}

const request = (over: Partial<CentralRouteRequest> = {}): CentralRouteRequest => ({
  text: 'o botão ficou torto',
  attachments: [],
  recent: [{ convId: 'a1', request: 'arruma o login', replyStart: 'Arrumei', cwd: PROJ_A, title: 'Login torto' }],
  ...over
})

describe('registerCentralIpc — central:route', () => {
  it('registra os dois canais', () => {
    const { handlers } = setup()
    expect(Channels.centralRoute).toBe('central:route')
    expect(Channels.centralCorrection).toBe('central:correction')
    expect([...handlers.keys()].sort()).toEqual(['central:correction', 'central:route'])
  })

  it('pedido inválido rejeita na fronteira, sem índice nem TypeSafe', async () => {
    const { route, load } = setup()
    for (const bad of [undefined, null, {}, { ...request(), text: '   ' }, { ...request(), recent: 'x' }, { ...request(), exclude: { kind: 'x' } }]) {
      await expect(route(bad)).rejects.toThrow(/rota da Central/)
    }
    expect(load).not.toHaveBeenCalled()
    expect(client.typeSafeConfigured).not.toHaveBeenCalled()
    expect(client.askTypeSafe).not.toHaveBeenCalled()
  })

  it('TypeSafe desligado: heurística (typesafe-failed) sem chamar o serviço', async () => {
    client.typeSafeConfigured.mockResolvedValue(false)
    const { route } = setup()
    await expect(route(request())).resolves.toEqual({
      kind: 'ask',
      reason: 'typesafe-failed',
      options: [{ target: a1Target }, { target: { kind: 'new-conversation', cwd: PROJ_A, project: 'proj-a' } }, { target: { kind: 'new-sandbox' } }]
    })
    expect(client.askTypeSafe).not.toHaveBeenCalled()
  })

  it('TypeSafe ligado: decideRoute com o índice e o askTypeSafe (texto aparado)', async () => {
    client.askTypeSafe.mockResolvedValue({ continua: pick('d1', 0.9), projeto: pick('p1', 0.9) })
    const { route, load } = setup()
    await expect(route(request({ text: '  o botão ficou torto  ' }))).resolves.toEqual({
      kind: 'direct',
      target: a1Target,
      rule: 'continua',
      confidence: 0.9,
      why: 'continua “Login torto”'
    })
    expect(load).toHaveBeenCalledWith({ includeDeleted: false })
    expect(client.askTypeSafe).toHaveBeenCalledTimes(1)
    const [sent] = client.askTypeSafe.mock.calls[0]
    expect(sent.state.message.text).toBe('o botão ficou torto')
    expect(Object.keys(sent.questions).sort()).toEqual(['continua', 'projeto'])
  })

  it('TypeSafe sem resposta: ask typesafe-failed, nunca rejeita', async () => {
    client.askTypeSafe.mockResolvedValue(null)
    const { route } = setup()
    await expect(route(request())).resolves.toMatchObject({ kind: 'ask', reason: 'typesafe-failed' })
  })

  it('índice que falha: heurística, sem chamar o TypeSafe', async () => {
    const { route } = setup({ load: vi.fn(async () => Promise.reject(new Error('banco fora'))) })
    await expect(route(request())).resolves.toMatchObject({ kind: 'ask', reason: 'typesafe-failed' })
    expect(client.askTypeSafe).not.toHaveBeenCalled()
  })

  it('índice que demora além do prazo: sem índice anterior, heurística no prazo', async () => {
    const pending = deferred<VersionedConversationLike[]>()
    const { route } = setup({ load: vi.fn(() => pending.promise) })
    const started = Date.now()
    await expect(route(request())).resolves.toMatchObject({ kind: 'ask', reason: 'typesafe-failed' })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(client.askTypeSafe).not.toHaveBeenCalled()
    pending.resolve([])
  })

  it('índice que demora além do prazo: com um índice anterior, roteia com ele', async () => {
    client.askTypeSafe.mockResolvedValue({ continua: pick('d1', 0.9), projeto: pick('p1', 0.9) })
    const rows = [conv('a1', { title: 'Login torto' })]
    const slow = deferred<VersionedConversationLike[]>()
    const load = vi.fn((query?: CentralLoadQuery) => (query?.ids ? slow.promise : Promise.resolve(rows)))
    const { route, emit } = setup({ load })

    await route(request())
    emit('a1')
    await expect(route(request())).resolves.toMatchObject({ kind: 'direct', target: a1Target })
    expect(load).toHaveBeenLastCalledWith({ ids: ['a1'] })
    expect(client.askTypeSafe).toHaveBeenCalledTimes(2)
    slow.resolve(rows)
  })

  it('o feed da PRÓPRIA Central não recarrega o índice; o das outras conversas sim', async () => {
    client.askTypeSafe.mockResolvedValue(null)
    const { route, emit, load } = setup()
    await route(request())
    emit('central')
    await route(request())
    expect(load).toHaveBeenCalledTimes(1)
    emit('b1', 'central')
    await route(request())
    expect(load).toHaveBeenCalledTimes(2)
    expect(load).toHaveBeenLastCalledWith({ ids: ['b1'] })
  })

  it('falha inesperada vira heurística e só a mensagem do erro vai ao log', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    client.askTypeSafe.mockRejectedValue(new Error('boom'))
    const { route } = setup()
    await expect(route(request({ text: 'segredo do usuário' }))).resolves.toMatchObject({ kind: 'ask', reason: 'typesafe-failed' })
    const logged = errors.mock.calls.flat().join(' ')
    expect(logged).toContain('boom')
    expect(logged).not.toContain('segredo do usuário')

    client.typeSafeConfigured.mockRejectedValue(new Error('config'))
    await expect(route(request())).resolves.toMatchObject({ kind: 'ask', reason: 'typesafe-failed' })
  })
})

describe('registerCentralIpc — central:correction', () => {
  const correction = (text = 'o botão ficou torto'): CentralCorrection => ({
    ts: 1_759_400_000_000,
    text,
    attachments: ['print.png'],
    from: { kind: 'conversation', convId: 'a1', cwd: PROJ_A, project: 'proj-a', title: 'Login torto', sandbox: false },
    fromRule: 'continua',
    fromConfidence: 0.7,
    to: { kind: 'new-sandbox' }
  })

  it('acrescenta UMA linha JSON por correção, criando a pasta', async () => {
    const { correct } = setup()
    await expect(correct(correction('primeira'))).resolves.toBeUndefined()
    await correct({ ...correction('segunda'), lixo: 'descartado' })
    const lines = (await readFile(join(dir, 'central', 'corrections.jsonl'), 'utf8')).split('\n')
    expect(lines.at(-1)).toBe('')
    expect(lines.slice(0, -1).map((line) => JSON.parse(line))).toEqual([correction('primeira'), correction('segunda')])
  })

  it('correção inválida rejeita e não grava nada', async () => {
    const { correct } = setup()
    await expect(correct({ ...correction(), to: { kind: 'x' } })).rejects.toThrow(/Correção da Central/)
    expect(existsSync(join(dir, 'central'))).toBe(false)
  })

  it('erro de disco vai ao log (só a mensagem) e não rejeita; a próxima grava normalmente', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await writeFile(join(dir, 'arquivo'), 'não é pasta')
    let file = join(dir, 'arquivo', 'corrections.jsonl')
    const { correct } = setup({ correctionsFile: () => file })

    await expect(correct(correction('texto privado'))).resolves.toBeUndefined()
    expect(errors).toHaveBeenCalledTimes(1)
    expect(String(errors.mock.calls[0][0])).toMatch(/^\[central\] correção não gravada: /)
    expect(errors.mock.calls.flat().join(' ')).not.toContain('texto privado')

    file = join(dir, 'ok', 'corrections.jsonl')
    await correct(correction('depois'))
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(correction('depois'))
  })
})

describe('registerCentralIpc — aquecimento e descarte', () => {
  it('prewarm carrega o índice em segundo plano depois do atraso (uma vez), só com o TypeSafe ligado', async () => {
    vi.useFakeTimers()
    const { handle, load } = setup()
    handle.prewarm(5_000)
    handle.prewarm(5_000)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(load).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(load).toHaveBeenCalledTimes(1)

    client.typeSafeConfigured.mockResolvedValue(false)
    const off = setup()
    off.handle.prewarm(5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(off.load).not.toHaveBeenCalled()
  })

  it('a rota depois do prewarm usa o índice já carregado (sem nova carga)', async () => {
    vi.useFakeTimers()
    client.askTypeSafe.mockResolvedValue({ continua: pick('d1', 0.9), projeto: pick('p1', 0.9) })
    const { handle, load, route } = setup()
    handle.prewarm(10)
    await vi.advanceTimersByTimeAsync(10)
    vi.useRealTimers()
    await expect(route(request())).resolves.toMatchObject({ kind: 'direct', target: a1Target })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('registrar não lê a raiz do sandbox nem assina o feed: o índice nasce no 1º uso, uma vez só', async () => {
    client.askTypeSafe.mockResolvedValue(null)
    const sandboxRoot = vi.fn(() => SANDBOX_ROOT)
    const { route, load, listeners } = setup({ sandboxRoot })
    expect(sandboxRoot).not.toHaveBeenCalled()
    expect(listeners.size).toBe(0)
    expect(client.typeSafeConfigured).not.toHaveBeenCalled()

    await route(request())
    await route(request())
    expect(sandboxRoot).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(1)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('a raiz do sandbox que falha não derruba a rota (heurística)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { route } = setup({
      sandboxRoot: () => {
        throw new Error('sem pasta local')
      }
    })
    await expect(route(request())).resolves.toMatchObject({ kind: 'ask', reason: 'typesafe-failed' })
    expect(String(errors.mock.calls[0]?.[0])).toContain('sem pasta local')
    expect(client.askTypeSafe).not.toHaveBeenCalled()
  })

  it('dispose cancela o aquecimento e solta o feed; depois dele, nada de carga', async () => {
    vi.useFakeTimers()
    client.askTypeSafe.mockResolvedValue(null)
    const { handle, load, listeners, route } = setup()
    await route(request())
    expect(listeners.size).toBe(1)
    handle.prewarm(100)
    handle.dispose()
    await vi.advanceTimersByTimeAsync(100)
    expect(listeners.size).toBe(0)
    await expect(route(request())).resolves.toMatchObject({ kind: 'ask' })
    expect(load).toHaveBeenCalledTimes(1)
  })
})
