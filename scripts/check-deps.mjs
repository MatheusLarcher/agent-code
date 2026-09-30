// Confere que toda lib de `dependencies` do package.json existe em node_modules.
//
//   node scripts/check-deps.mjs                 -> node_modules do repositorio (antes do build)
//   node scripts/check-deps.mjs --verify <app>  -> node_modules dentro do app empacotado
//
// O electron-builder so copia o que JA esta instalado na maquina de build: uma lib
// nova no package.json sem `npm install` sai do setup sem erro e so quebra em uso.
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const i = process.argv.indexOf('--verify')
const appDir = i === -1 ? root : resolve(root, process.argv[i + 1] ?? '')
const where = join(appDir, 'node_modules')

const deps = Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies ?? {})
const missing = deps.filter((name) => !existsSync(join(where, name, 'package.json')))

if (missing.length) {
  console.error(`Dependencias ausentes em ${where}:`)
  for (const name of missing) console.error(`  - ${name}`)
  process.exit(1)
}
console.log(`Dependencias: ${deps.length} de ${deps.length} presentes em ${where}.`)
