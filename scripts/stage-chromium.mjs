// Copia o Chromium do Playwright (e o winldd, usado no Windows) para
// `out/ms-playwright/`, de onde o electron-builder o embute em resources/.
// Caminho relativo de propósito: `extraResources.from` absoluto é resolvido
// contra a raiz do projeto pelo electron-builder e nunca acha o arquivo.
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { chromium } from 'playwright'

if (process.platform !== 'win32') {
  console.log('Chromium: staging ignorado fora do Windows.')
  process.exit(0)
}

const exe = chromium.executablePath() // …/ms-playwright/chromium-<rev>/chrome-win64/chrome.exe
const chromiumDir = dirname(dirname(exe))
const browsersRoot = dirname(chromiumDir)
const dest = resolve(import.meta.dirname, '..', 'out', 'ms-playwright')
mkdirSync(dest, { recursive: true })

const copy = (name) => {
  const from = join(browsersRoot, name)
  if (!existsSync(from)) return false
  cpSync(from, join(dest, name), { recursive: true })
  console.log(`Chromium: copiado ${name}`)
  return true
}

if (!copy(chromiumDir.split(/[\\/]/).pop())) {
  console.error(`Chromium não encontrado em ${chromiumDir}. Rode: npx playwright install chromium`)
  process.exit(1)
}
// winldd é opcional (só usado no diagnóstico de dependências do Windows).
const winldd = ['winldd-1007', 'winldd-1006'].find((n) => existsSync(join(browsersRoot, n)))
if (winldd) copy(winldd)
