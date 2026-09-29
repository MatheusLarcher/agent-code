/**
 * Modo sandbox: conversa que não exige escolher pasta. Cada conversa ganha a
 * sua subpasta em `<localDir>\sandbox` — local ao PC, fora do OneDrive e fora
 * da instalação (sem permissão de escrita e substituída ao atualizar).
 *
 * O sandbox é identificado pelo CAMINHO: toda conversa com `cwd` dentro de
 * `sandboxRoot()` é do sandbox. Sem flag na conversa, sem migração no banco.
 */
import { randomBytes } from 'crypto'
import { mkdir } from 'fs/promises'
import { join, relative, resolve, isAbsolute } from 'path'
import { getCacheInfo } from './store'

/** Raiz do sandbox: `<localDir>\sandbox`. */
export function sandboxRoot(): string {
  return join(getCacheInfo().localDir, 'sandbox')
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Nome da subpasta: `AAAA-MM-DD_HH-MM_<4 hex>`. Não usa o título: a conversa
 *  ainda não tem título quando nasce, e renomear a pasta depois quebraria a sessão. */
export function sandboxDirName(now: Date, suffix: () => string = () => randomBytes(2).toString('hex')): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}`
  return `${date}_${time}_${suffix()}`
}

/** `cwd` está DENTRO de `root` (a raiz em si não conta). Sem diferenciar
 *  maiúsculas no Windows; `..` é resolvido antes da comparação. */
export function isInsideSandbox(root: string, cwd: string): boolean {
  if (!root || !cwd) return false
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
  const rel = relative(fold(resolve(root)), fold(resolve(cwd)))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function isSandboxPath(cwd: string): boolean {
  return isInsideSandbox(sandboxRoot(), cwd)
}

/** Cria (recursivo) uma subpasta nova em `root` e devolve o caminho absoluto.
 *  Colisão no mesmo minuto é improvável (4 hex), mas tenta de novo se houver. */
export async function createSandboxDirIn(root: string, now = new Date()): Promise<string> {
  await mkdir(root, { recursive: true })
  for (let attempt = 0; ; attempt++) {
    const path = resolve(root, sandboxDirName(now))
    try {
      await mkdir(path)
      return path
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 8) throw err
    }
  }
}

export function createSandboxDir(now = new Date()): Promise<string> {
  return createSandboxDirIn(sandboxRoot(), now)
}

/** Respostas do IPC: erro de disco vira `{ error }`, nunca lança para o renderer. */
export async function sandboxCreateResult(): Promise<{ path: string } | { error: string }> {
  try {
    return { path: await createSandboxDir() }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
