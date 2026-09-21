import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const marker = '.agent-code-migration.json'
const sidecars = (file) => [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
function discover(root) {
  const files = []
  const legacy = join(root, 'agent-code.db')
  if (existsSync(legacy)) files.push(legacy)
  const data = join(root, 'data')
  if (existsSync(data)) for (const name of readdirSync(data).sort((a, b) => a.localeCompare(b))) if (name.toLowerCase().endsWith('.db')) files.push(join(data, name))
  return files
}

export function migrateLegacyStorage({ legacyRoot, localRoot }) {
  const result = { migrated: [], skipped: [], failed: [] }
  const source = resolve(legacyRoot), target = resolve(localRoot)
  if (source === target || !existsSync(source)) return result
  mkdirSync(target, { recursive: true })
  const files = discover(source)
  let state = {}
  try { state = JSON.parse(readFileSync(join(target, marker), 'utf8')) } catch { /* fresh */ }
  const members = state.members ?? {}
  const pending = []
  for (const src of files) {
    const rel = basename(src) === 'agent-code.db' ? 'agent-code.db' : `data/${basename(src)}`
    const dest = join(target, rel)
    try {
      const sourceHash = hash(src)
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
  if (result.failed.length === 0 && files.every((src) => members[basename(src) === 'agent-code.db' ? 'agent-code.db' : `data/${basename(src)}`] !== undefined)) {
    writeFileSync(join(target, marker), JSON.stringify({ complete: true, members }, null, 2))
  }
  return result
}
