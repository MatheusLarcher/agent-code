import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const output = resolve('out/main/storageMigration.js')
mkdirSync(dirname(output), { recursive: true })
copyFileSync(resolve('scripts/storageMigration.mjs'), output)
