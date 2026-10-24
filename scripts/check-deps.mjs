// Confere que toda lib de `dependencies` do package.json existe em node_modules.
//
//   node scripts/check-deps.mjs                 -> node_modules do repositorio (antes do build)
//   node scripts/check-deps.mjs --verify <app>  -> node_modules dentro do app empacotado
//
// O electron-builder so copia o que JA esta instalado na maquina de build: uma lib
// nova no package.json sem `npm install` sai do setup sem erro e so quebra em uso.
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Pacotes que o electron-vite EMBUTE no bundle do main (`exclude` do
// externalizeDepsPlugin em electron.vite.config.ts): no app empacotado nao
// existem em node_modules; a prova e uma marca deles dentro de out/main/index.js.
// (Antes do build, no repositorio, ainda precisam estar em node_modules.)
const BUNDLED_IN_MAIN = { 'electron-updater': 'checkForUpdatesAndNotify' }

const root = resolve(import.meta.dirname, '..')
const i = process.argv.indexOf('--verify')
const verifying = i !== -1
const appDir = verifying ? resolve(root, process.argv[i + 1] ?? '') : root
const where = join(appDir, 'node_modules')
const bundleFile = join(appDir, 'out', 'main', 'index.js')
const bundle = verifying && existsSync(bundleFile) ? readFileSync(bundleFile, 'utf8') : ''

const deps = Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies ?? {})
const bundled = (name) => verifying && Object.hasOwn(BUNDLED_IN_MAIN, name)
const missing = deps.filter((name) =>
  bundled(name) ? !bundle.includes(BUNDLED_IN_MAIN[name]) : !existsSync(join(where, name, 'package.json'))
)

if (missing.length) {
  console.error(`Dependencias ausentes em ${where}:`)
  for (const name of missing) console.error(`  - ${name}${bundled(name) ? ` (embutida: marca ausente em ${bundleFile})` : ''}`)
  process.exit(1)
}
const embedded = deps.filter(bundled).length
console.log(
  `Dependencias: ${deps.length} de ${deps.length} presentes em ${where}` +
    (embedded ? ` (${embedded} embutida(s) em out/main/index.js).` : '.')
)
