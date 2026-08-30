import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

interface BackupItem {
  source: string
  backup: string
  bytes: number
  sha256: string
}

async function existingSqliteSources(cacheDir: string, dbPath: string): Promise<string[]> {
  const sources = new Set([dbPath])
  const dataDir = join(cacheDir, 'data')
  const entries = await readdir(dataDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.db')) sources.add(join(dataDir, entry.name))
  }
  const existing: string[] = []
  for (const source of sources) {
    if ((await stat(source).catch(() => null))?.isFile()) existing.push(source)
  }
  return existing.sort()
}

async function digest(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

export async function backupSqliteForTransition(
  cacheDir: string,
  dbPath: string,
  transitionId: string
): Promise<string> {
  const root = join(cacheDir, 'migration-manifests', transitionId)
  await mkdir(root, { recursive: true })
  const items: BackupItem[] = []
  for (const [index, source] of (await existingSqliteSources(cacheDir, dbPath)).entries()) {
    const backup = join(root, `${String(index + 1).padStart(3, '0')}-${basename(dirname(source))}-${basename(source)}.bak`)
    await copyFile(source, backup)
    const info = await stat(backup)
    items.push({ source, backup, bytes: info.size, sha256: await digest(backup) })
  }
  const manifestPath = join(root, 'manifest.json')
  const temporary = `${manifestPath}.tmp`
  await writeFile(temporary, JSON.stringify({
    version: 1,
    transitionId,
    createdAt: new Date().toISOString(),
    sources: items
  }, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, manifestPath)
  return manifestPath
}
