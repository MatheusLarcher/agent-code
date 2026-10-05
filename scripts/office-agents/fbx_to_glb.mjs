// Converte o FBX do Mixamo (com pele) num GLB para o Escritório, num Chromium
// headless (Playwright) com o three do projeto — sem servidor: as rotas
// http://sandbox.local/* são servidas do disco por page.route.
//
// Uso: node fbx_to_glb.mjs <mixamo.fbx> <fonte-texturas.glb> <saida.glb>
//
// - Escala: o Mixamo exporta em cm; o modelo é escalado para ter a altura do
//   GLB de texturas (o do Meshy, em metros).
// - Material: UM MeshStandardMaterial com as texturas PBR do GLB de texturas
//   (cor, normal, metal/rugosidade — as UVs são as mesmas: o OBJ enviado ao
//   Mixamo saiu dele, glb_to_obj_zip.py); os grupos de material da malha somem.
// - Sem clipe de animação (o app anima pelas próprias poses).
// Depois: tint_mask.py (máscara da roupa) → compress_glb.py → inspect_glb.py → render_glb.mjs.
import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const repo = resolve(import.meta.dirname, '../..')
const { chromium } = require(join(repo, 'node_modules/playwright'))
const THREE_DIR = join(repo, 'node_modules/three')

const [fbxArg, texArg, outArg] = process.argv.slice(2)
if (!fbxArg || !texArg || !outArg) throw new Error('uso: node fbx_to_glb.mjs <mixamo.fbx> <fonte-texturas.glb> <saida.glb>')

const PAGE = `<!doctype html><html><body>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'

const buf = async (p) => (await fetch(p)).arrayBuffer()
const height = (o) => { o.updateMatrixWorld(true); return new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3()).y }

window.convert = async () => {
  const fbx = new FBXLoader().parse(await buf('/fbx'), '')
  const tex = await new GLTFLoader().parseAsync(await buf('/tex'), '')
  let src = null
  tex.scene.traverse((o) => { if (o.isMesh && !src) src = o.material })
  const scale = height(tex.scene) / height(fbx)
  fbx.scale.multiplyScalar(scale)
  const mat = new THREE.MeshStandardMaterial({
    name: 'agent', map: src.map, normalMap: src.normalMap, roughnessMap: src.roughnessMap, metalnessMap: src.metalnessMap,
    roughness: 1, metalness: 1, side: src.side
  })
  const info = { scale, meshes: 0, skinned: 0, bones: 0, groups: 0, mats: [] }
  const drop = []
  fbx.traverse((o) => {
    if (o.isBone) info.bones++
    if (!o.isMesh) return
    if (!o.isSkinnedMesh) { drop.push(o); return }
    info.meshes++
    info.skinned++
    info.groups += o.geometry.groups.length
    info.mats.push(Array.isArray(o.material) ? o.material.map((m) => m.name) : o.material.name)
    o.geometry.clearGroups()
    o.material = mat
  })
  for (const o of drop) o.removeFromParent()
  info.height = height(fbx)
  const scene = new THREE.Scene()
  scene.add(fbx)
  const glb = await new GLTFExporter().parseAsync(scene, { binary: true, animations: [], onlyVisible: false })
  const bytes = new Uint8Array(glb)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return { info, b64: btoa(s) }
}
window.ready = true
</script></body></html>`

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage()
page.on('pageerror', (e) => console.error('pageerror:', e.message))
page.on('console', (m) => m.type() === 'warning' && console.warn('console:', m.text()))
await page.route('http://sandbox.local/**', async (route) => {
  const path = new URL(route.request().url()).pathname
  if (path === '/') return route.fulfill({ contentType: 'text/html', body: PAGE })
  if (path === '/fbx') return route.fulfill({ contentType: 'application/octet-stream', body: readFileSync(resolve(fbxArg)) })
  if (path === '/tex') return route.fulfill({ contentType: 'model/gltf-binary', body: readFileSync(resolve(texArg)) })
  if (path.startsWith('/three/')) {
    const file = join(THREE_DIR, path.slice('/three/'.length))
    if (existsSync(file)) return route.fulfill({ contentType: 'text/javascript', body: readFileSync(file) })
  }
  return route.fulfill({ status: 404, body: 'not found' })
})
await page.goto('http://sandbox.local/')
await page.waitForFunction(() => window.ready === true, null, { timeout: 120000 })
const { info, b64 } = await page.evaluate(() => window.convert())
writeFileSync(resolve(outArg), Buffer.from(b64, 'base64'))
console.log('ok:', resolve(outArg), JSON.stringify(info))
await browser.close()
