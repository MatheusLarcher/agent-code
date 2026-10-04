import type { IpcMain } from 'electron'
import { Channels, type AndroidToolchainStatus } from '../../shared/ipc'
import { detect, ensureInstalled, isInstalling } from './androidEnv'

/**
 * Settings › Android: see and install the Android toolchain (JDK, SDK,
 * emulator, AVD) ahead of time — the same idempotent install the agent's
 * `android_setup` and the phone APK build run on demand.
 */
export async function androidToolchainStatus(): Promise<AndroidToolchainStatus> {
  const d = await detect()
  return { ready: d.ready, missing: d.missing, installing: isInstalling() }
}

export function registerAndroidToolchainIpc(ipcMain: IpcMain): void {
  ipcMain.handle(Channels.androidToolchainStatus, () => androidToolchainStatus())
  ipcMain.handle(Channels.androidToolchainInstall, async (e) => {
    const send = (line: string): void => {
      if (!e.sender.isDestroyed()) e.sender.send(Channels.androidToolchainProgress, line)
    }
    try {
      const d = await ensureInstalled(send)
      return d.ready ? { ok: true } : { ok: false, error: `Ainda faltam: ${d.missing.join(', ')}` }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
