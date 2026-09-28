import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface InstallOptions {
  /** Pasta de origem da extensão (dev: src/chromeExtension; prod: resources/chrome-extension). */
  sourceDir: string
  /** Pasta que o usuário carrega no Chrome (userData/chrome-extension). */
  targetDir: string
  ports: readonly number[]
  token: string
}

/** Conteúdo do config.js gerado — script clássico carregado por importScripts. */
export function buildConfigJs(ports: readonly number[], token: string): string {
  return `self.AGENT_CODE_CONFIG = ${JSON.stringify({ ports: [...ports], token })}\n`
}

/** Versão esperada da extensão = `version` do manifest de origem. */
export function readManifestVersion(sourceDir: string): string {
  const manifest = JSON.parse(readFileSync(join(sourceDir, 'manifest.json'), 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error('manifest.json sem version')
  return manifest.version
}

/** Copia a extensão para a pasta instalada e grava config.js com portas e token. */
export function installExtensionFiles(opts: InstallOptions): string {
  if (!/^[0-9a-f]{32}$/.test(opts.token)) throw new Error('Token da ponte Chrome inválido')
  if (!existsSync(join(opts.sourceDir, 'manifest.json'))) {
    throw new Error(`Extensão não encontrada em ${opts.sourceDir}`)
  }
  mkdirSync(opts.targetDir, { recursive: true })
  cpSync(opts.sourceDir, opts.targetDir, {
    recursive: true,
    force: true,
    // Um config.js de origem (dev) nunca sobrescreve o gerado.
    filter: (src) => basename(src) !== 'config.js'
  })
  writeFileSync(join(opts.targetDir, 'config.js'), buildConfigJs(opts.ports, opts.token), 'utf8')
  return opts.targetDir
}

/** Caminhos comuns do chrome.exe no Windows; null se nenhum existir. */
export function findChromeExe(env: NodeJS.ProcessEnv = process.env, exists = existsSync): string | null {
  const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((r): r is string => !!r)
  for (const root of roots) {
    const exe = join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')
    if (exists(exe)) return exe
  }
  return null
}

/** Abre a página de extensões no Chrome, se o executável for encontrado. */
export function openChromeExtensionsPage(chromeExe: string | null = findChromeExe()): boolean {
  if (!chromeExe) return false
  try {
    const child = spawn(chromeExe, ['chrome://extensions'], { detached: true, stdio: 'ignore' })
    child.on('error', () => undefined)
    child.unref()
    return true
  } catch {
    return false
  }
}
