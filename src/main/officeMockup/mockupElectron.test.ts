import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  windows: [] as Array<{ opts: Record<string, unknown>; openHandler?: () => unknown; events: Map<string, (...a: unknown[]) => void>; destroyed: boolean }>,
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  schemes: [] as unknown[],
  partitions: [] as string[],
  capturePerm: null as null | ((wc: unknown, p: string, cb: (ok: boolean) => void) => void)
}))

vi.mock('electron', () => {
  class BrowserWindow {
    webContents: Record<string, unknown>
    constructor(opts: Record<string, unknown>) {
      const rec = { opts, events: new Map<string, (...a: unknown[]) => void>(), destroyed: false } as (typeof h.windows)[number]
      h.windows.push(rec)
      this.webContents = {
        setAudioMuted: vi.fn(),
        setWindowOpenHandler: (fn: () => unknown) => void (rec.openHandler = fn),
        on: (ev: string, fn: (...a: unknown[]) => void) => void rec.events.set(ev, fn),
        off: vi.fn(),
        loadURL: vi.fn(async () => rec.events.get('did-finish-load')?.()),
        capturePage: vi.fn(async () => ({ isEmpty: () => false, toPNG: () => Buffer.from([137, 80, 78, 71]) }))
      }
    }
    isDestroyed(): boolean {
      return false
    }
    destroy(): void {}
  }
  const ses = {
    protocol: { handle: vi.fn() },
    setPermissionRequestHandler: (fn: typeof h.capturePerm) => void (h.capturePerm = fn),
    setPermissionCheckHandler: vi.fn()
  }
  return {
    BrowserWindow,
    protocol: { registerSchemesAsPrivileged: (s: unknown[]) => h.schemes.push(...s), handle: vi.fn() },
    session: { fromPartition: (p: string) => (h.partitions.push(p), ses) }
  }
})

import { Channels } from '../../shared/ipc'
import { CAPTURE_PARTITION, registerMockupScheme, setupOfficeMockup } from './mockupElectron'

beforeEach(() => {
  h.windows.length = 0
  h.handlers.clear()
})

describe('agent-mockup no Electron (mockupElectron)', () => {
  it('esquema padrão e seguro, sem bypassCSP nem CORS', () => {
    registerMockupScheme()
    expect(h.schemes).toEqual([{ scheme: 'agent-mockup', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
  })

  it('janela de captura escondida, sandbox, sem Node, partição em memória; janela nova e navegação recusadas; sem permissões', async () => {
    const m = setupOfficeMockup({ handle: (c, fn) => void h.handlers.set(c, fn) })
    expect(h.partitions).toEqual([CAPTURE_PARTITION])
    expect(CAPTURE_PARTITION.startsWith('persist:')).toBe(false)
    const perm = vi.fn()
    h.capturePerm!(null, 'media', perm)
    expect(perm).toHaveBeenCalledWith(false)
    // Pedido inválido não abre janela; arquivo que não existe também não.
    const cap = h.handlers.get(Channels.officeMockupCapture)!
    expect(await cap(null, { cwd: 5 })).toEqual({ ok: false, error: 'pedido inválido' })
    expect(await cap(null, { cwd: 'C:\\nao-existe', path: 'C:\\nao-existe\\a.html' })).toMatchObject({ ok: false })
    expect(h.windows).toHaveLength(0)
    // A janela nasce na 1ª captura válida (aqui, chamando a fábrica pela própria fila).
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-el-'))
    fs.writeFileSync(path.join(dir, 'a.html'), '<p>')
    const res = (await cap(null, { cwd: dir, path: path.join(dir, 'a.html') })) as { ok: boolean }
    expect(res.ok).toBe(true)
    const w = h.windows[0]
    expect(w.opts).toMatchObject({ show: false, paintWhenInitiallyHidden: true, width: 1280, height: 640 })
    expect(w.opts.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, partition: CAPTURE_PARTITION })
    expect(w.openHandler!()).toEqual({ action: 'deny' })
    const nav = { preventDefault: vi.fn() }
    w.events.get('will-navigate')!(nav)
    expect(nav.preventDefault).toHaveBeenCalled()
    m.release()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
