import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { app, shell } from 'electron'
import { loadConfig, updateConfig } from '../config'
import type { ChromeBridgeStatus } from '../../shared/chromeBridge'
import { CHROME_EXTENSION_ID } from './extensionId'
import { installExtensionFiles, openChromeExtensionsPage, readManifestVersion } from './install'
import { CHROME_BRIDGE_PORTS } from './protocol'
import { ChromeBridge } from './server'
import { setChromeBridge } from './state'

let bridge: ChromeBridge | null = null

export function chromeBridgeStatus(): ChromeBridgeStatus {
  return (
    bridge?.getStatus() ?? { listening: false, port: null, connected: false, extensionVersion: null, userAgent: null }
  )
}

function sourceDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'chrome-extension')
    : join(app.getAppPath(), 'src', 'chromeExtension')
}

function targetDir(): string {
  return join(app.getPath('userData'), 'chrome-extension')
}

async function ensureToken(): Promise<string> {
  const current = loadConfig().chromeBridgeToken
  if (/^[0-9a-f]{32}$/.test(current)) return current
  const token = randomBytes(16).toString('hex')
  await updateConfig({ chromeBridgeToken: token })
  return token
}

function install(token: string): string {
  return installExtensionFiles({ sourceDir: sourceDir(), targetDir: targetDir(), ports: CHROME_BRIDGE_PORTS, token })
}

/** Boot: garante o token, atualiza a pasta da extensão e sobe a ponte. Nunca lança. */
export async function startChromeBridge(onStatus: (status: ChromeBridgeStatus) => void): Promise<void> {
  try {
    const token = await ensureToken()
    install(token)
    if (bridge) return
    bridge = new ChromeBridge({ extensionId: CHROME_EXTENSION_ID, token, version: readManifestVersion(sourceDir()) })
    bridge.on('status', onStatus)
    setChromeBridge(bridge)
    await bridge.start()
  } catch (error) {
    console.error(`[chrome-bridge] não subiu: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function stopChromeBridge(): void {
  void bridge?.stop()
}

/** Botão "Instalar extensão": reescreve a pasta, abre-a e tenta abrir chrome://extensions. */
export async function openInstall(): Promise<string> {
  const dir = install(await ensureToken())
  const err = await shell.openPath(dir)
  if (err) console.error(`[chrome-bridge] openPath: ${err}`)
  openChromeExtensionsPage()
  return dir
}
