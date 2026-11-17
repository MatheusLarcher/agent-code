// O Chromium do Playwright é a RESERVA do navegador do agente: só entra em PC sem
// Google Chrome, e só é baixado na primeira vez que for preciso (não viaja no
// instalador). Fica na pasta local da máquina — ver `playwrightBrowsersDir`.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { machineLocalDir } from './machineLocalDir'

/** Para onde o app empacotado aponta `PLAYWRIGHT_BROWSERS_PATH` (fora do OneDrive e do instalador). */
export function playwrightBrowsersDir(): string {
  return join(machineLocalDir(), 'ms-playwright')
}

export const NO_BROWSER_MESSAGE = 'Instale o Google Chrome ou conecte à internet para baixar o navegador'

const DOWNLOAD_TIMEOUT_MS = 15 * 60_000

/** O Chromium do Playwright já está no disco? */
export async function chromiumInstalled(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright')
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
}

function playwrightCli(): string {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('playwright/package.json')), 'cli.js')
}

/** Uma linha por evento: a barra de progresso reescreve a mesma linha com `\r`. */
export function progressLines(chunk: string): string[] {
  return chunk
    .split(/[\r\n]+/)
    .map((l) => l.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim())
    .filter(Boolean)
}

/** Das linhas do download, fica o que conta: sem as dezenas de "37% of 150 MiB". */
export function summarizeProgress(lines: string[], keep = 8): string[] {
  const out: string[] = []
  for (const line of lines) {
    const isBar = /\d+%/.test(line)
    if (isBar && out.length && /\d+%/.test(out[out.length - 1])) out[out.length - 1] = line
    else out.push(line)
  }
  return out.slice(-keep)
}

/** O motivo da falha, sem as linhas de pilha (`at …`) que o CLI despeja no fim. */
export function failureReason(lines: string[]): string {
  return summarizeProgress(
    lines.filter((l) => !/^at\s/.test(l)),
    3
  ).join(' | ')
}

export interface InstallOptions {
  /** Node que roda o cli.js: o próprio Electron (ELECTRON_RUN_AS_NODE), como o rea.mjs. */
  execPath?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

function runInstall(onLine: (line: string) => void, opts: InstallOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.execPath ?? process.execPath, [playwrightCli(), 'install', 'chromium', '--no-shell'], {
      env: { ...(opts.env ?? process.env), ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const tail: string[] = []
    const feed = (chunk: Buffer): void => {
      for (const line of progressLines(chunk.toString())) {
        tail.push(line)
        if (tail.length > 40) tail.shift()
        onLine(line)
      }
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`o download não terminou em ${Math.round((opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS) / 60_000)} min`))
    }, opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(failureReason(tail) || `playwright install saiu com código ${code}`))
    })
  })
}

let downloading: Promise<void> | null = null

/** Baixa o Chromium (uma vez; pedidos simultâneos esperam o mesmo download). */
export function installChromium(onLine: (line: string) => void = () => undefined, opts: InstallOptions = {}): Promise<void> {
  downloading ??= runInstall(onLine, opts).finally(() => {
    downloading = null
  })
  return downloading
}
