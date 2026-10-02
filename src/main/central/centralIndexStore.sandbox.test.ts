// @vitest-environment node
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createCentralIndexStore } from './centralIndexStore'
import { SANDBOX_ROOT, conv, ids, makeDb, setup } from './centralStoreTestKit'

// ../sandbox de mentira, que conta quantas vezes é CARREGADO (o de verdade puxa o electron via ./store).
// O store só o pega por `import()` na hora da carga, então o mock é registrado a cada teste (doMock).
const sandboxModule = {
  loads: 0,
  isInsideSandbox: vi.fn<(root: string, cwd: string) => boolean>(),
  sandboxRoot: vi.fn<() => string>()
}

beforeEach(() => {
  vi.resetModules()
  sandboxModule.loads = 0
  sandboxModule.isInsideSandbox.mockReset()
  sandboxModule.sandboxRoot.mockReset()
  vi.doMock('../sandbox', () => {
    sandboxModule.loads++
    return { isInsideSandbox: sandboxModule.isInsideSandbox, sandboxRoot: sandboxModule.sandboxRoot }
  })
})

describe('createCentralIndexStore — raiz e predicado do sandbox', () => {
  it('com a raiz e o predicado injetados, ../sandbox nunca é carregado (a loja roda fora do Electron)', async () => {
    const inSandbox = join(SANDBOX_ROOT, 'x1')
    const isSandbox = vi.fn((cwd: string) => cwd === inSandbox)
    const db = makeDb([conv('p'), conv('s', { cwd: inSandbox })])
    const { store } = setup(db, { isSandbox })

    const index = await store.getIndex()
    store.invalidate()
    await store.getIndex()

    expect(sandboxModule.loads).toBe(0)
    expect(isSandbox).toHaveBeenCalledWith(inSandbox)
    expect(index.byId.get('s')).toMatchObject({ sandbox: true, project: 'sandbox' })
    expect(index.byId.get('p')).toMatchObject({ sandbox: false, project: 'proj-a' })
    expect(index.projects.find((p) => p.sandbox)?.cwd).toBe(SANDBOX_ROOT)
  })

  it('sem o predicado, usa o isInsideSandbox do app com a raiz injetada (e não pergunta a raiz ao app)', async () => {
    sandboxModule.isInsideSandbox.mockImplementation((root, cwd) => cwd.startsWith(`${root}-marcada`))
    const marked = `${SANDBOX_ROOT}-marcada-1`
    const db = makeDb([conv('s', { cwd: marked }), conv('p')])
    const { store } = setup(db)

    const index = await store.getIndex()

    expect(sandboxModule.loads).toBe(1)
    expect(sandboxModule.isInsideSandbox).toHaveBeenCalledWith(SANDBOX_ROOT, marked)
    expect(sandboxModule.sandboxRoot).not.toHaveBeenCalled()
    expect(index.byId.get('s')?.sandbox).toBe(true)
    expect(index.byId.get('p')?.sandbox).toBe(false)
  })

  it('sem a raiz, pergunta ao app (e o predicado injetado continua valendo)', async () => {
    sandboxModule.sandboxRoot.mockReturnValue('/app/sandbox')
    const db = makeDb([conv('s', { cwd: '/app/sandbox/x' })])
    const store = createCentralIndexStore({
      load: db.load,
      exists: () => true,
      isSandbox: (cwd) => cwd.startsWith('/app/sandbox/')
    })

    const index = await store.getIndex()

    expect(sandboxModule.loads).toBe(1)
    expect(index.projects[0]).toMatchObject({ sandbox: true, cwd: '/app/sandbox' })
    expect(sandboxModule.isInsideSandbox).not.toHaveBeenCalled()
    store.dispose()
  })

  it('o app é carregado uma vez só, mesmo com várias cargas', async () => {
    sandboxModule.sandboxRoot.mockReturnValue(SANDBOX_ROOT)
    sandboxModule.isInsideSandbox.mockReturnValue(false)
    const db = makeDb([conv('a'), conv('b')])
    const store = createCentralIndexStore({ load: db.load, exists: () => true })

    await store.getIndex()
    store.invalidate()
    await store.getIndex()
    store.invalidate('a')
    expect(ids(await store.getIndex())).toEqual(['a', 'b'])

    expect(sandboxModule.loads).toBe(1)
    expect(sandboxModule.sandboxRoot).toHaveBeenCalledTimes(1)
    store.dispose()
  })

  it('o `load` é chamado de imediato por getIndex(), antes de qualquer espera pelo app', () => {
    const db = makeDb([conv('a')])
    const store = createCentralIndexStore({ load: db.load, exists: () => true })
    void store.getIndex().catch(() => undefined)
    expect(db.load).toHaveBeenCalledTimes(1)
    store.dispose()
  })
})
