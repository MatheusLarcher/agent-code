// Renderiza um GLB com three.js num Chromium headless (Playwright), sem servidor:
// as rotas http://sandbox.local/* são servidas do disco por page.route.
//
// Uso: node render_glb.mjs <arquivo.glb> <saida-prefixo> [poses=rest,sit,wave]
// Poses mexem os ossos pela DIREÇÃO no mundo (osso → filho), sem depender dos
// eixos locais do rig: é o mesmo problema que o adaptador do app vai resolver.
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { chromium } = require(join(REPO, 'node_modules/playwright'))
const HERE = dirname(fileURLToPath(import.meta.url))
const THREE_DIR = join(REPO, 'node_modules/three')

const [glbArg, outPrefix = 'render', posesArg = 'rest,sit,wave'] = process.argv.slice(2)
if (!glbArg) throw new Error('uso: node render_glb.mjs <arquivo.glb> <saida-prefixo> [poses]')
const glbPath = resolve(glbArg)

const PAGE = `<!doctype html><html><body style="margin:0;background:#cfd3d8">
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

const W = 640, H = 900
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setSize(W, H)
renderer.outputColorSpace = THREE.SRGBColorSpace
document.body.appendChild(renderer.domElement)
const scene = new THREE.Scene()
scene.background = new THREE.Color(0xcfd3d8)
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture
const sun = new THREE.DirectionalLight(0xffffff, 1.6)
sun.position.set(2, 4, 3)
scene.add(sun, new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.6))
const camera = new THREE.PerspectiveCamera(30, W / H, 0.05, 50)

const gltf = await new GLTFLoader().loadAsync('/glb')
const model = gltf.scene
scene.add(model)
model.updateMatrixWorld(true)
// ?mat=lambert: o material do resto do escritório (cor + normal map, sem brilho PBR).
if (new URLSearchParams(location.search).get('mat') === 'lambert') {
  model.traverse((o) => {
    if (!o.isMesh) return
    const m = o.material
    o.material = new THREE.MeshLambertMaterial({ map: m.map, normalMap: m.normalMap, side: m.side })
  })
}

const bones = {}
model.traverse((o) => { if (o.isBone) bones[o.name.toLowerCase().replace(/^mixamorig[:_]?/, '')] = o })
const info = { bones: Object.keys(bones), meshes: 0, skinned: 0, tris: 0, materials: [] }
model.traverse((o) => {
  if (!o.isMesh) return
  info.meshes++
  if (o.isSkinnedMesh) info.skinned++
  info.tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3
  const m = o.material
  info.materials.push({ type: m.type, map: !!m.map, normalMap: !!m.normalMap, roughnessMap: !!m.roughnessMap, metalnessMap: !!m.metalnessMap })
})

const v = new THREE.Vector3(), w = new THREE.Vector3(), q = new THREE.Quaternion(), qp = new THREE.Quaternion()
function child(b) { return b.children.find((c) => c.isBone) }
// Gira o osso para que (osso → filho) aponte para dir (mundo).
function aim(name, dir) {
  const b = bones[name], c = b && child(b)
  if (!b || !c) return false
  model.updateMatrixWorld(true)
  b.getWorldPosition(v); c.getWorldPosition(w)
  const cur = w.sub(v).normalize()
  const delta = new THREE.Quaternion().setFromUnitVectors(cur, new THREE.Vector3(...dir).normalize())
  b.getWorldQuaternion(q); b.parent.getWorldQuaternion(qp)
  b.quaternion.copy(qp.invert().multiply(delta).multiply(q))
  b.updateMatrixWorld(true)
  return true
}
const POSES = {
  rest: [],
  // Sentado digitando: coxas à frente, canelas para baixo, braços à frente, antebraços convergindo.
  sit: [['leftupleg', [0, -0.05, 1]], ['rightupleg', [0, -0.05, 1]], ['leftleg', [0, -1, 0.05]], ['rightleg', [0, -1, 0.05]],
        ['leftarm', [0.18, -0.6, 0.78]], ['rightarm', [-0.18, -0.6, 0.78]], ['leftforearm', [-0.25, -0.15, 0.95]], ['rightforearm', [0.25, -0.15, 0.95]]],
  // Acenando com a direita (a direita do personagem fica em -X quando ele olha para +Z).
  wave: [['rightarm', [-0.55, 0.8, 0.15]], ['rightforearm', [-0.05, 1, 0.1]], ['leftarm', [0.25, -1, 0.05]]],
}
window.renderPose = (pose, view) => {
  const missing = POSES[pose].filter(([n, d]) => !aim(n, d)).map(([n]) => n)
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3())
  const dist = (size.y / 2) / Math.tan(THREE.MathUtils.degToRad(15)) * 1.15
  const ang = view === 'front' ? 0 : view === 'side' ? Math.PI / 2 : Math.PI / 5
  camera.position.set(center.x + Math.sin(ang) * dist, center.y + size.y * 0.08, center.z + Math.cos(ang) * dist)
  camera.lookAt(center)
  renderer.render(scene, camera)
  return { missing, height: +size.y.toFixed(3), info }
}
window.ready = true
</script></body></html>`

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 640, height: 900 } })
page.on('pageerror', (e) => console.error('pageerror:', e.message))
await page.route('http://sandbox.local/**', async (route) => {
  const path = new URL(route.request().url()).pathname
  if (path === '/' || path === '/index.html') return route.fulfill({ contentType: 'text/html', body: PAGE })
  if (path === '/glb') return route.fulfill({ contentType: 'model/gltf-binary', body: readFileSync(glbPath) })
  if (path.startsWith('/three/')) {
    const file = join(THREE_DIR, path.slice('/three/'.length))
    if (existsSync(file)) return route.fulfill({ contentType: 'text/javascript', body: readFileSync(file) })
  }
  return route.fulfill({ status: 404, body: 'not found' })
})
await page.goto(`http://sandbox.local/?mat=${process.env.MAT ?? ''}`)
await page.waitForFunction(() => window.ready === true, null, { timeout: 120000 })

for (const pose of posesArg.split(',')) {
  const view = pose === 'wave' ? 'front' : 'three-quarter'
  // Cada pose parte do repouso: recarrega a página.
  if (pose !== posesArg.split(',')[0]) {
    await page.reload()
    await page.waitForFunction(() => window.ready === true, null, { timeout: 120000 })
  }
  const r = await page.evaluate(([p, v]) => window.renderPose(p, v), [pose, view])
  const out = join(HERE, `${outPrefix}-${pose}.png`)
  await page.screenshot({ path: out })
  console.log(pose, JSON.stringify({ missing: r.missing, height: r.height }), '->', out)
  if (pose === posesArg.split(',')[0]) console.log('info', JSON.stringify(r.info))
}
await browser.close()
