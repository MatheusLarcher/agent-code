import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isValidName } from './planningModel'

/**
 * A migração dos planejamentos da raiz legada (<cwd>/docs/spec/<slug>/, que só
 * viajava pelo git) para a raiz na pasta de dados (<dataDir>/planning/<projectKey>/
 * <slug>/, que acompanha o usuário entre PCs como as conversas e as memórias).
 *
 * - Só entra plano legado com _roteiro.md (pasta real, não link) que AINDA não
 *   exista na raiz nova. Plano já existente lá nunca é sobrescrito, e o legado
 *   nunca é apagado.
 * - Copia só o formato do plano: _roteiro.md, _canvas.json, cards/ e _handoff/.
 *   O _sandbox/ fica no projeto (código descartável, local de cada PC); symlink
 *   e junction ficam de fora (apontariam para fora da pasta).
 * - Cópia numa pasta temporária irmã (.<slug>.<uuid>.tmp) e um rename no fim:
 *   ninguém vê o plano pela metade. Se outro processo chegou antes, o rename
 *   falha, a temporária sai e o plano dele fica.
 * - Dentro do processo, uma fila por raiz nova serializa as migrações: duas
 *   chamadas simultâneas (listPlans + openPlan) não copiam o mesmo plano duas vezes.
 */

/** Os itens do plano que viajam. Pastas copiadas por inteiro (só arquivos e pastas reais). */
const MIGRATED_FILES = ['_roteiro.md', '_canvas.json'] as const
const MIGRATED_DIRS = ['cards', '_handoff'] as const

/**
 * Chave do projeto na pasta de dados: o nome da pasta do projeto em
 * minúsculas, sem acento, com o resto virando '-'. Não depende do caminho
 * absoluto, então é a mesma nos dois PCs mesmo que o projeto more em lugares
 * diferentes (C:\GitHub\app e D:\dev\app → "app").
 */
export function projectKey(projectCwd: string): string {
  const base = path.basename(path.resolve(projectCwd))
  const key = base
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return key || 'projeto'
}

const migrationQueues = new Map<string, Promise<unknown>>()

function inMigrationQueue<T>(newRoot: string, work: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? newRoot.toLowerCase() : newRoot
  const run = (migrationQueues.get(key) ?? Promise.resolve()).then(work)
  const tail = run.catch(() => undefined)
  migrationQueues.set(key, tail)
  void tail.then(() => {
    if (migrationQueues.get(key) === tail) migrationQueues.delete(key)
  })
  return run
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/** Pasta real (não link) em `p`? */
async function isRealDir(p: string): Promise<boolean> {
  try {
    const st = await fs.lstat(p)
    return st.isDirectory() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

/** Copia `src` para `dst` só com arquivos comuns e pastas reais; links ficam de fora. */
async function copyTree(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true })
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dst, entry.name)
    if (entry.isDirectory()) await copyTree(from, to)
    else if (entry.isFile()) await fs.copyFile(from, to)
  }
}

/** O plano legado `slug` tem o que migrar (pasta real com _roteiro.md comum)? */
async function isMigratable(legacyRoot: string, slug: string): Promise<boolean> {
  if (!isValidName(slug)) return false
  const dir = path.join(legacyRoot, slug)
  if (!(await isRealDir(dir))) return false
  try {
    return (await fs.lstat(path.join(dir, '_roteiro.md'))).isFile()
  } catch {
    return false
  }
}

/** Copia um plano legado para a raiz nova. `true` = copiou agora. */
async function migrateOne(legacyRoot: string, newRoot: string, slug: string): Promise<boolean> {
  const target = path.join(newRoot, slug)
  if (await exists(target)) return false
  if (!(await isMigratable(legacyRoot, slug))) return false
  const src = path.join(legacyRoot, slug)
  await fs.mkdir(newRoot, { recursive: true })
  const tmp = path.join(newRoot, `.${slug}.${randomUUID()}.tmp`)
  try {
    await fs.mkdir(tmp)
    for (const name of MIGRATED_FILES) {
      const from = path.join(src, name)
      const st = await fs.lstat(from).catch(() => null)
      if (st?.isFile()) await fs.copyFile(from, path.join(tmp, name))
    }
    for (const name of MIGRATED_DIRS) {
      const from = path.join(src, name)
      if (await isRealDir(from)) await copyTree(from, path.join(tmp, name))
    }
    // Conferido de novo logo antes do rename: no POSIX, rename sobre pasta
    // vazia a substituiria. Se alguém chegou antes, o plano dele fica.
    if (await exists(target)) return false
    await fs.rename(tmp, target)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // Outro processo (ou o outro PC, pelo sincronizador) criou o destino entre a
    // conferência e o rename: não é erro, o plano dele vale.
    if ((code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM') && (await exists(target))) return false
    throw err
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Migra os planos legados que ainda não estão na raiz nova: todos, ou só
 * `slug` quando informado. Devolve os slugs copiados agora. Sem pasta legada,
 * nada a fazer. Idempotente: a segunda chamada não copia nada.
 */
export async function migrateLegacyPlans(legacyRoot: string, newRoot: string, slug?: string): Promise<string[]> {
  const norm = (p: string): string => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
  if (norm(legacyRoot) === norm(newRoot)) return []
  return inMigrationQueue(newRoot, async () => {
    let slugs: string[]
    if (slug !== undefined) {
      slugs = [slug]
    } else {
      try {
        slugs = (await fs.readdir(legacyRoot, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
      }
    }
    const copied: string[] = []
    for (const name of slugs.sort()) {
      if (await migrateOne(legacyRoot, newRoot, name)) copied.push(name)
    }
    return copied
  })
}
