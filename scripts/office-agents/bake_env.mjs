// Assa o ambiente do PBR dos agentes (PMREM do RoomEnvironment) num Chromium
// headless (Playwright) com o three do projeto e grava os texels prontos:
// o app só sobe a textura (agentModels.ts), sem compilar no primeiro desenho
// os shaders do PMREM (desfoque + filtro GGX: ~380 ms de travada no ANGLE).
//
// Uso: node bake_env.mjs <saida.bin> [lado do cubo=128]
// Formato (gzip): "PMRM", uint32 largura, uint32 altura, depois RGBA HalfFloat
// (Uint16, linhas de baixo para cima, como o WebGL lê e sobe).
import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const require = createRequire(import.meta.url)
const repo = resolve(import.meta.dirname, '../..')
const { chromium } = require(join(repo, 'node_modules/playwright'))
const THREE_DIR = join(repo, 'node_modules/three')
const [outArg, sizeArg = '128'] = process.argv.slice(2)
if (!outArg) throw new Error('uso: node bake_env.mjs <saida.bin> [lado]')

const PAGE = `<!doctype html><html><body>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
window.bake = (size) => {
  const renderer = new THREE.WebGLRenderer()
  const pmrem = new THREE.PMREMGenerator(renderer)
  const rt = pmrem.fromScene(new RoomEnvironment(), 0.04, 0.1, 100, { size })
  const { width, height } = rt
  const px = new Uint16Array(width * height * 4)
  renderer.readRenderTargetPixels(rt, 0, 0, width, height, px)
  let s = ''
  const bytes = new Uint8Array(px.buffer)
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return { width, height, b64: btoa(s) }
}
window.ready = true
</script></body></html>`

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage()
page.on('pageerror', (e) => console.error('pageerror:', e.message))
await page.route('http://sandbox.local/**', async (route) => {
  const path = new URL(route.request().url()).pathname
  if (path === '/') return route.fulfill({ contentType: 'text/html', body: PAGE })
  if (path.startsWith('/three/')) {
    const file = join(THREE_DIR, path.slice('/three/'.length))
    if (existsSync(file)) return route.fulfill({ contentType: 'text/javascript', body: readFileSync(file) })
  }
  return route.fulfill({ status: 404, body: 'not found' })
})
await page.goto('http://sandbox.local/')
await page.waitForFunction(() => window.ready === true, null, { timeout: 120000 })
const { width, height, b64 } = await page.evaluate((n) => window.bake(n), Number(sizeArg))
const head = Buffer.alloc(12)
head.write('PMRM', 0, 'ascii')
head.writeUInt32LE(width, 4)
head.writeUInt32LE(height, 8)
const raw = Buffer.concat([head, Buffer.from(b64, 'base64')])
const gz = gzipSync(raw, { level: 9 })
writeFileSync(resolve(outArg), gz)
console.log(`ok: ${resolve(outArg)} | ${width}x${height} HalfFloat | ${(raw.length / 1024).toFixed(0)} KB -> gzip ${(gz.length / 1024).toFixed(0)} KB`)
await browser.close()
