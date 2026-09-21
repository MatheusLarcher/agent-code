import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const pointerPath = join(homedir(), '.agent-code', 'location.json')
let legacyRoot = ''
try {
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'))
  if (typeof pointer.cacheDir === 'string') legacyRoot = pointer.cacheDir
} catch {
  // No selected folder means there is nothing to migrate.
}

const userData = process.env.AGENT_CODE_USER_DATA || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'agent-code-desktop')
const localRoot = join(userData, 'agent-code-local')
if (!legacyRoot || resolve(legacyRoot) === resolve(localRoot) || !existsSync(legacyRoot)) {
  process.stdout.write('storage migration: nothing to migrate\n')
  process.exit(0)
}

const modulePath = resolve('out/main/storageMigration.js')
if (!existsSync(modulePath)) {
  console.error(`storage migration: compiled module not found: ${modulePath}`)
  process.exit(1)
}
const { migrateLegacyStorage } = await import(pathToFileURL(modulePath).href)
const result = migrateLegacyStorage({ legacyRoot, localRoot })
if (result.failed.length) {
  console.error(`storage migration: failed: ${result.failed.join(', ')}`)
  process.exit(1)
}
console.log(`storage migration: migrated ${result.migrated.length}, skipped ${result.skipped.length}`)
