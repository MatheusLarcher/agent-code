// Copia o 7za.exe do próprio electron-builder para `out/7zip/`, de onde ele vai
// para resources/7zip. É o extrator da atualização rápida (main/appUpdate/fastSwap.ts):
// depois do download, o app abre o AgentCode-setup.exe como 7z e extrai a versão
// nova numa pasta irmã, em segundo plano.
//
// Tem que ser o MESMO 7-Zip que montou o pacote: o electron-builder 26 usa o 24.x,
// com o filtro ARM64 (onnxruntime-node traz binários arm64) — o 7zip-bin do npm
// (21.07) não lê esse filtro e a extração sai incompleta.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

if (process.platform !== 'win32') {
  console.log('7-Zip: staging ignorado fora do Windows.')
  process.exit(0)
}

const require = createRequire(import.meta.url)
const { getPath7za } = require('app-builder-lib/out/toolsets/7zip.js')
const bin = await getPath7za()
const dest = resolve(import.meta.dirname, '..', 'out', '7zip')
mkdirSync(dest, { recursive: true })
copyFileSync(bin, join(dest, '7za.exe'))
const license = join(dirname(dirname(bin)), 'LICENSE.txt')
if (existsSync(license)) copyFileSync(license, join(dest, 'LICENSE.txt'))
console.log(`7-Zip: copiado ${bin}`)
