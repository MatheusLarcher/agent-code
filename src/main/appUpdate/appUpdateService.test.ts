import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateState } from '../../shared/ipc'
import { AppUpdateService, CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, type UpdaterLike, type UpdaterLogger } from './appUpdateService'

/** O `autoUpdater` falso: emite os mesmos eventos do electron-updater. */
class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = false
  autoInstallOnAppQuit = true
  allowDowngrade = true
  forceDevUpdateConfig = false
  updateConfigPath: string | null = null
  logger: UpdaterLogger | null = null
  checks = 0
  installed: Array<[boolean | undefined, boolean | undefined]> = []
  /** O que a próxima verificação faz (emite eventos e resolve/rejeita). */
  script: () => Promise<unknown> = () => Promise.resolve(null)

  checkForUpdates(): Promise<unknown> {
    this.checks += 1
    return this.script()
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installed.push([isSilent, isForceRunAfter])
  }
}

function setup(options: { blockedBy?: string | null; devFeedConfigPath?: string | null } = {}) {
  const updater = new FakeUpdater()
  const states: AppUpdateState[] = []
  const lines: string[] = []
  const service = new AppUpdateService({
    updater,
    currentVersion: '0.1.145',
    log: (line) => lines.push(line),
    blockedBy: () => options.blockedBy ?? null,
    onChange: (state) => states.push(state),
    devFeedConfigPath: options.devFeedConfigPath ?? null,
    now: () => new Date('2026-10-24T03:00:00.000Z')
  })
  const phases = (): string[] => states.map((s) => s.phase)
  return { updater, service, states, lines, phases }
}

/** Uma verificação que acha a 0.2.0, baixa e deixa pronta. */
function foundAndDownloaded(updater: FakeUpdater, version = '0.2.0'): void {
  updater.script = async () => {
    updater.emit('checking-for-update')
    updater.emit('update-available', { version })
    updater.emit('download-progress', { percent: 42.7 })
    updater.emit('download-progress', { percent: 42.9 })
    updater.emit('update-downloaded', { version, downloadedFile: `C:\\cache\\AgentCode-setup-${version}.exe` })
    return { isUpdateAvailable: true }
  }
}

describe('AppUpdateService', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('configura o updater: baixa sozinho, nunca instala ao fechar, sem downgrade, com log', () => {
    const { updater } = setup()
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.allowDowngrade).toBe(false)
    expect(updater.forceDevUpdateConfig).toBe(false)
    expect(updater.logger).not.toBeNull()
  })

  it('feed de desenvolvimento liga forceDevUpdateConfig e aponta o yml', () => {
    const { updater, lines } = setup({ devFeedConfigPath: 'C:\\repo\\dev-app-update.yml' })
    expect(updater.forceDevUpdateConfig).toBe(true)
    expect(updater.updateConfigPath).toBe('C:\\repo\\dev-app-update.yml')
    expect(lines.join('\n')).toContain('feed de desenvolvimento')
  })

  it('encontrou → baixando → pronta, com versão, arquivo e canInstallNow', async () => {
    const { updater, service, phases, states, lines } = setup()
    foundAndDownloaded(updater)
    const result = await service.checkNow()
    expect(phases()).toEqual(['verificando', 'baixando', 'baixando', 'pronta'])
    expect(result.phase).toBe('pronta')
    expect(result.version).toBe('0.2.0')
    expect(result.percent).toBe(100)
    expect(result.canInstallNow).toBe(true)
    expect(result.blockedBy).toBeNull()
    expect(result.checkedAt).toBe('2026-10-24T03:00:00.000Z')
    expect(service.pendingInstaller()).toBe('C:\\cache\\AgentCode-setup-0.2.0.exe')
    // O progresso só publica em inteiros: 42.7 e 42.9 viram um único 42.
    expect(states.filter((s) => s.phase === 'baixando').map((s) => s.percent)).toEqual([0, 42])
    expect(lines.some((l) => l.includes('pronta 0.2.0'))).toBe(true)
  })

  it('versão igual ou menor → ocioso, com a hora da verificação', async () => {
    const { updater, service } = setup()
    updater.script = async () => {
      updater.emit('checking-for-update')
      updater.emit('update-not-available', { version: '0.1.145' })
      return { isUpdateAvailable: false }
    }
    const result = await service.checkNow()
    expect(result.phase).toBe('ocioso')
    expect(result.version).toBeNull()
    expect(result.checkedAt).toBe('2026-10-24T03:00:00.000Z')
    expect(result.error).toBeNull()
    expect(service.pendingInstaller()).toBeNull()
  })

  it('erro de rede não trava: fica em erro e a próxima verificação periódica tenta de novo', async () => {
    const { updater, service, lines } = setup()
    updater.script = async () => {
      updater.emit('checking-for-update')
      const error = new Error('net::ERR_INTERNET_DISCONNECTED')
      // O electron-updater emite 'error' E rejeita a mesma falha.
      updater.emit('error', error)
      throw error
    }
    service.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS)
    expect(updater.checks).toBe(1)
    expect(service.snapshot().phase).toBe('erro')
    expect(service.snapshot().error).toContain('ERR_INTERNET_DISCONNECTED')
    // A mesma falha chegou duas vezes (evento + rejeição) e foi registrada uma vez.
    expect(lines.filter((l) => l.startsWith('erro (')).length).toBe(1)

    updater.script = async () => {
      updater.emit('checking-for-update')
      updater.emit('update-not-available', { version: '0.1.145' })
      return { isUpdateAvailable: false }
    }
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(updater.checks).toBe(2)
    expect(service.snapshot().phase).toBe('ocioso')
    expect(service.snapshot().error).toBeNull()
    service.stop()
  })

  it('checkNow durante o download não chama o updater de novo', async () => {
    const { updater, service } = setup()
    let finish: () => void = () => undefined
    updater.script = () => {
      updater.emit('checking-for-update')
      updater.emit('update-available', { version: '0.2.0' })
      return new Promise((resolve) => {
        finish = () => resolve({ isUpdateAvailable: true })
      })
    }
    const first = service.checkNow()
    expect(service.snapshot().phase).toBe('baixando')
    const second = await service.checkNow()
    expect(second.phase).toBe('baixando')
    expect(updater.checks).toBe(1)
    finish()
    await first
  })

  it('agente trabalhando: pronta, mas canInstallNow falso com o motivo', async () => {
    const { updater, service } = setup({ blockedBy: 'A conversa "mapa" está com um turno em andamento.' })
    foundAndDownloaded(updater)
    const result = await service.checkNow()
    expect(result.phase).toBe('pronta')
    expect(result.canInstallNow).toBe(false)
    expect(result.blockedBy).toBe('A conversa "mapa" está com um turno em andamento.')
  })

  it('falha numa verificação posterior não apaga a atualização já pronta', async () => {
    const { updater, service } = setup()
    foundAndDownloaded(updater)
    await service.checkNow()
    updater.script = async () => {
      updater.emit('checking-for-update')
      const error = new Error('HTTP 503')
      updater.emit('error', error)
      throw error
    }
    const result = await service.checkNow()
    expect(result.phase).toBe('pronta')
    expect(result.version).toBe('0.2.0')
    expect(result.error).toBe('HTTP 503')
    expect(service.pendingInstaller()).toBe('C:\\cache\\AgentCode-setup-0.2.0.exe')
  })

  it('agendar só de pronta; instalando de pronta/agendada; voltar a pronta com o motivo', async () => {
    const { updater, service, phases } = setup()
    expect(service.markScheduled()).toBe(false)
    foundAndDownloaded(updater)
    await service.checkNow()
    expect(service.markScheduled()).toBe(true)
    expect(service.snapshot().phase).toBe('agendada')
    // Verificação periódica não mexe no agendamento.
    await service.checkNow()
    expect(updater.checks).toBe(1)
    expect(service.markInstalling()).toBe(true)
    expect(service.snapshot().phase).toBe('instalando')
    service.markReady('O instalador não subiu.')
    expect(service.snapshot().phase).toBe('pronta')
    expect(service.snapshot().error).toBe('O instalador não subiu.')
    expect(phases().slice(-3)).toEqual(['agendada', 'instalando', 'pronta'])
    service.quitAndInstall()
    expect(updater.installed).toEqual([[true, true]])
  })

  it('erro do updater durante a instalação devolve o indicador a pronta', async () => {
    const { updater, service } = setup()
    foundAndDownloaded(updater)
    await service.checkNow()
    service.markInstalling()
    updater.emit('error', new Error('spawn falhou'))
    expect(service.snapshot().phase).toBe('pronta')
    expect(service.snapshot().error).toBe('spawn falhou')
  })

  it('start agenda a primeira verificação e as periódicas; stop cancela', async () => {
    const { updater, service } = setup()
    service.start()
    service.start() // idempotente
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1)
    expect(updater.checks).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(updater.checks).toBe(1)
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(updater.checks).toBe(2)
    service.stop()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3)
    expect(updater.checks).toBe(2)
  })

  it('updater inativo (dev sem feed) não muda o estado', async () => {
    const { service, states } = setup()
    const result = await service.checkNow()
    expect(result.phase).toBe('ocioso')
    expect(states).toEqual([])
  })
})
