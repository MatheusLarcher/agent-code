import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/**
 * Pastas de login das contas Claude. Cada conta extra tem a sua, passada ao CLI
 * empacotado como `CLAUDE_CONFIG_DIR`, com login OAuth próprio — é o que o CLI
 * suporta de fábrica. Ficam na raiz LOCAL do app (nunca na pasta sincronizada):
 * o CLI grava ali credencial, transcrições e telemetria a cada turno.
 */

/** Arquivos da configuração do usuário que a conta precisa enxergar: são o que
 *  ele percebe se sumir. Copiados só quando mudam. */
const CARRY_OVER_FILES = ['CLAUDE.md', 'settings.json']

/** Pastas da configuração do usuário compartilhadas por link (junction no
 *  Windows): skills, agentes, comandos e plugins instalados continuam os mesmos
 *  em qualquer conta. Nenhuma delas guarda credencial. */
const SHARED_DIRS = ['skills', 'agents', 'commands', 'plugins']

/** A pasta de configuração que o CLI usa quando não mandamos nenhuma. */
export function machineConfigDir(): string {
  return process.env['CLAUDE_CONFIG_DIR']?.trim() || join(homedir(), '.claude')
}

/** Onde o CLI guarda o `.claude.json` (e-mail da conta) de uma pasta de config. */
export function globalConfigFile(configDir: string | undefined): string {
  if (configDir) return join(configDir, '.claude.json')
  const custom = process.env['CLAUDE_CONFIG_DIR']?.trim()
  return custom ? join(custom, '.claude.json') : join(homedir(), '.claude.json')
}

export function accountsRoot(localDir: string): string {
  return join(localDir, 'claude-accounts')
}

/** Só letras, números, `-` e `_`: o id vira nome de pasta. */
export function isSafeAccountId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id)
}

export function accountDir(localDir: string, id: string): string {
  if (!isSafeAccountId(id)) throw new Error('id de conta inválido')
  return join(accountsRoot(localDir), id)
}

/**
 * Cria (ou atualiza) a pasta da conta: `0700` no Unix, `CLAUDE.md` e
 * `settings.json` copiados quando mudaram, pastas compartilhadas por link.
 * Melhor esforço nas cópias e links — o login da conta é o que importa.
 */
export function prepareAccountDir(dir: string, source = machineConfigDir()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    try {
      chmodSync(dir, 0o700)
    } catch {
      /* dono diferente: o mkdir já pediu 0700 */
    }
  }
  for (const name of CARRY_OVER_FILES) {
    try {
      const from = join(source, name)
      const to = join(dir, name)
      if (!existsSync(from)) continue
      const fresh = existsSync(to) && statSync(to).mtimeMs >= statSync(from).mtimeMs
      if (!fresh) copyFileSync(from, to)
    } catch (error) {
      console.warn(`[contas] não consegui copiar ${name} para a conta:`, (error as Error).message)
    }
  }
  for (const name of SHARED_DIRS) {
    try {
      const from = join(source, name)
      const to = join(dir, name)
      if (!existsSync(from) || existsSync(to) || isLink(to)) continue
      symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      console.warn(`[contas] não consegui ligar ${name} à conta:`, (error as Error).message)
    }
  }
  return dir
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Apaga a pasta de uma conta. Recusa qualquer caminho fora da raiz das contas,
 * e desfaz os links ANTES de apagar — senão a remoção poderia seguir o link e
 * apagar as skills/plugins do usuário.
 */
export function removeAccountDir(localDir: string, id: string): void {
  const root = resolve(accountsRoot(localDir))
  const dir = resolve(accountDir(localDir, id))
  if (!dir.startsWith(root + sep)) throw new Error('pasta de conta fora da raiz das contas')
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (isLink(path)) unlinkSync(path)
  }
  rmSync(dir, { recursive: true, force: true })
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** O que dá para saber da credencial SEM tirar o token da pasta. */
export interface CredentialInfo {
  /** Existe `.credentials.json` com login do claude.ai. */
  present: boolean
  /** Token vivo, ou renovável pelo refresh token. */
  live: boolean
  subscriptionType: string | null
  rateLimitTier: string | null
}

/**
 * Lê a validade da credencial de uma pasta de config (como o `oauthLive` do
 * Nexos). Devolve só metadados: accessToken e refreshToken ficam no arquivo.
 */
export function readCredentialInfo(configDir: string, now = Date.now()): CredentialInfo {
  const raw = readJson(join(configDir, '.credentials.json'))
  const block = raw?.claudeAiOauth as Record<string, unknown> | undefined
  if (!block || typeof block !== 'object' || !str(block.accessToken)) {
    return { present: false, live: false, subscriptionType: null, rateLimitTier: null }
  }
  let live = num(block.expiresAt) > now
  if (!live && str(block.refreshToken)) {
    const refreshExpiry = num(block.refreshTokenExpiresAt)
    live = refreshExpiry === 0 || refreshExpiry > now
  }
  return {
    present: true,
    live,
    subscriptionType: str(block.subscriptionType) || null,
    rateLimitTier: str(block.rateLimitTier) || null
  }
}

/** E-mail da conta logada numa pasta de config, pelo `.claude.json`. */
export function readOauthEmail(configDir: string | undefined): string | null {
  const account = readJson(globalConfigFile(configDir))?.oauthAccount as Record<string, unknown> | undefined
  return str(account?.emailAddress) || null
}
