// O MCP "rea" (rea-agents, engenharia reversa) embutido no app: o pacote viaja
// no setup (electron-builder.yml) e o rea.mjs roda pelo Node do próprio Electron
// (ELECTRON_RUN_AS_NODE=1) — sem npm, Node global nem ~/.claude.json na máquina
// do usuário. O resolvedor e a checagem de existência entram por parâmetro (teste).
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export interface ReaStdioConfig {
  type: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
}

export interface ReaMcpDeps {
  /** Caminho absoluto do package.json do rea-agents; lança se não instalado. */
  resolvePackageJson?: () => string
  exists?: (path: string) => boolean
  execPath?: string
  env?: NodeJS.ProcessEnv
}

/** Variáveis do ambiente que o rea usa (Ghidra/Java), repassadas só quando definidas. */
const PASS_THROUGH_ENV = ['GHIDRA_INSTALL_DIR', 'JAVA_HOME'] as const

function defaultResolvePackageJson(): string {
  // Mesmo caminho do claudeCli.ts: o main é externalizado, então o require acha
  // node_modules subindo de out/main — no repositório e em resources/app do exe.
  return createRequire(import.meta.url).resolve('rea-agents/package.json')
}

/** Caminho absoluto do rea.mjs, ou null se o rea-agents não estiver instalado. */
export function reaScriptPath(deps: ReaMcpDeps = {}): string | null {
  const exists = deps.exists ?? existsSync
  let pkg: string
  try {
    pkg = (deps.resolvePackageJson ?? defaultResolvePackageJson)()
  } catch {
    return null
  }
  const script = join(dirname(pkg), 'scripts', 'rea.mjs')
  return exists(script) ? script : null
}

/** Config stdio do MCP "rea" para a sessão, ou null se o rea.mjs não existir. */
export function reaMcpConfig(deps: ReaMcpDeps = {}): ReaStdioConfig | null {
  const script = reaScriptPath(deps)
  if (!script) return null
  const source = deps.env ?? process.env
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' }
  for (const name of PASS_THROUGH_ENV) {
    const value = source[name]
    if (value) env[name] = value
  }
  return { type: 'stdio', command: deps.execPath ?? process.execPath, args: [script, 'mcp'], env }
}
