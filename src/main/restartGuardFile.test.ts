// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppRestartCoordinator, type RestartActivity } from './appRestart'
import { RESTART_GUARD_FILENAME, startRestartGuardFile } from './restartGuardFile'

const roots: string[] = []
const stops: Array<() => void> = []
afterEach(() => {
  stops.splice(0).forEach((stop) => stop())
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  vi.useRealTimers()
})

function host(): ConstructorParameters<typeof AppRestartCoordinator>[0] {
  return {
    arm: async () => ({ commit: async () => {}, cancel: async () => {} }),
    flush: async () => {},
    quit: () => {},
    report: () => {}
  }
}
function fixture(): { dir: string; path: string; coordinator: AppRestartCoordinator } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-code-guard-'))
  roots.push(dir)
  return { dir, path: join(dir, RESTART_GUARD_FILENAME), coordinator: new AppRestartCoordinator(host()) }
}
const read = (path: string): { idle: boolean; blockedBy: string | null; sessions: number; at: string } =>
  JSON.parse(readFileSync(path, 'utf8'))

describe('estado de reinício publicado para o relançador', () => {
  it('sem sessão nenhuma, o app está ocioso', () => {
    const { dir, path, coordinator } = fixture()
    stops.push(startRestartGuardFile(coordinator, dir))
    expect(read(path)).toMatchObject({ idle: true, blockedBy: null, sessions: 0 })
  })

  it('qualquer conversa ocupada bloqueia, inclusive a que pediria o reinício', () => {
    const { dir, path, coordinator } = fixture()
    const state: RestartActivity = { busy: true }
    coordinator.register('conversa-1', () => state)
    stops.push(startRestartGuardFile(coordinator, dir))
    const busy = read(path)
    expect(busy.idle).toBe(false)
    expect(busy.blockedBy).toContain('conversa-1')
    expect(busy.sessions).toBe(1)
  })

  it('atualiza sozinho quando a conversa desocupa', () => {
    vi.useFakeTimers()
    const { dir, path, coordinator } = fixture()
    const state: RestartActivity = { busy: true }
    coordinator.register('conversa-1', () => state)
    stops.push(startRestartGuardFile(coordinator, dir, 1_000))
    expect(read(path).idle).toBe(false)
    state.busy = false
    vi.advanceTimersByTime(1_000)
    expect(read(path).idle).toBe(true)
  })

  it('um envio em andamento bloqueia mesmo sem conversa marcada como ocupada', () => {
    const { dir, path, coordinator } = fixture()
    coordinator.register('conversa-1', () => ({ busy: false }))
    const done = coordinator.enter()
    stops.push(startRestartGuardFile(coordinator, dir))
    expect(read(path)).toMatchObject({ idle: false, blockedBy: 'Inicialização ou envio pendente.' })
    done()
  })

  it('estado ilegível de uma sessão bloqueia em vez de virar "ocioso"', () => {
    const { dir, path, coordinator } = fixture()
    coordinator.register('quebrada', () => { throw new Error('sem estado') })
    stops.push(startRestartGuardFile(coordinator, dir))
    expect(read(path).idle).toBe(false)
    expect(read(path).blockedBy).toContain('quebrada')
  })

  it('carimba a hora e apaga o arquivo ao parar — snapshot velho não vale', () => {
    const { dir, path, coordinator } = fixture()
    const stop = startRestartGuardFile(coordinator, dir)
    const at = Date.parse(read(path).at)
    expect(Number.isFinite(at)).toBe(true)
    expect(Math.abs(Date.now() - at)).toBeLessThan(10_000)
    stop()
    expect(existsSync(path)).toBe(false)
  })
})
