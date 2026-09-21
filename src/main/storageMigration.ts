import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, copyFileSync, renameSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export interface MigrationPaths { legacyRoot: string; localRoot: string }
export interface MigrationResult { migrated: string[]; skipped: string[]; failed: string[] }
interface MigrationMarker { complete?: boolean; members?: Record<string, string> }
const marker = '.agent-code-migration.json'
const sidecars = (file: string) => [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]
function hash(file: string): string { return createHash('sha256').update(readFileSync(file)).digest('hex') }
function discover(root: string): string[] {
  const out: string[] = []
  const legacy = join(root, 'agent-code.db')
  if (existsSync(legacy)) out.push(legacy)
  const data = join(root, 'data')
  if (existsSync(data)) for (const name of readdirSync(data).sort((a, b) => a.localeCompare(b))) if (name.toLowerCase().endsWith('.db')) out.push(join(data, name))
  return out
}
export function moveSyncData(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const name of ['memories', 'skills']) {
    const src = join(from, name), dest = join(to, name)
    if (!existsSync(src) || existsSync(dest)) continue
    try { renameSync(src, dest) } catch {
      try { cpSync(src, dest, { recursive: true }); rmSync(src, { recursive: true, force: true }) } catch { /* preserve source */ }
    }
  }
}

export function migrateLegacyStorage(paths: MigrationPaths): MigrationResult {
  const result: MigrationResult = { migrated: [], skipped: [], failed: [] }
  const source = resolve(paths.legacyRoot), target = resolve(paths.localRoot)
  mkdirSync(target, { recursive: true })
  if (source === target || !existsSync(source)) return result
  const files = discover(source)
  let state: MigrationMarker = {}
  try { state = JSON.parse(readFileSync(join(target, marker), 'utf8')) as MigrationMarker } catch { /* fresh */ }
  const members = state.members ?? {}
  const pending: { src: string; dest: string; rel: string; before: string }[] = []
  for (const src of files) {
    const rel = basename(src) === 'agent-code.db' ? 'agent-code.db' : `data/${basename(src)}`
    const dest = join(target, rel)
    try {
      const sourceHash = hash(src)
      // Existing files are never silently accepted. They are skippable only when
      // the durable marker proves this member and the whole migration completed.
      if (existsSync(dest)) {
        if (state.complete === true && members[rel] === sourceHash && hash(dest) === sourceHash) result.skipped.push(rel)
        else result.failed.push(rel)
        continue
      }
      pending.push({ src, dest, rel, before: sourceHash })
    } catch { result.failed.push(rel) }
  }
  for (const item of pending) {
    const rel = item.dest.slice(target.length + 1).replaceAll('\\', '/')
    try {
      mkdirSync(dirname(item.dest), { recursive: true })
      const stage = `${item.dest}.migration-${process.pid}.tmp`
      copyFileSync(item.src, stage)
      if (hash(stage) !== item.before) { rmSync(stage, { force: true }); result.failed.push(rel); continue }
      renameSync(stage, item.dest)
      for (const side of sidecars(item.src).slice(1)) if (existsSync(side)) { const sideRel = side.slice(source.length + 1); const sideDest = join(target, sideRel); if (!existsSync(sideDest)) { mkdirSync(dirname(sideDest), { recursive: true }); copyFileSync(side, sideDest) } }
      const after = hash(item.src)
      if (after !== item.before) { result.failed.push(rel); continue }
      for (const side of sidecars(item.src)) rmSync(side, { force: true })
      result.migrated.push(rel)
      members[rel] = item.before
      state = { complete: false, members }
      writeFileSync(join(target, marker), JSON.stringify(state, null, 2))
    } catch { result.failed.push(rel) }
  }
  if (result.failed.length === 0 && files.every((src) => {
    const rel = basename(src) === 'agent-code.db' ? 'agent-code.db' : `data/${basename(src)}`
    return members[rel] !== undefined
  })) {
    state = { complete: true, members }
    writeFileSync(join(target, marker), JSON.stringify(state, null, 2))
  }
  return result
}
