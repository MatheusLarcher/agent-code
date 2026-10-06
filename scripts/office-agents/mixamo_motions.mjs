// Converte os clipes do Mixamo (FBX sem pele, no esqueleto do Mixamo) num arquivo de movimentos
// do Escritório, num Chromium headless (Playwright) com o three do projeto — sem servidor.
//
// Uso: node mixamo_motions.mjs <pasta-com-fbx> <meta.json> <saida.bin> [fps=24]
// (no Windows com o Agent Code instalado: PLAYWRIGHT_BROWSERS_PATH=%LOCALAPPDATA%ms-playwright)
//
// Cada clipe vira, quadro a quadro, a rotação de cada SEGMENTO do corpo no referencial do
// personagem (olhando para −Z), relativa ao repouso alinhado das poses (poses.ts com tudo zero:
// tronco e cabeça na vertical, braços e pernas retos para baixo) — o mesmo espaço dos "slots"
// do avatar (agentRest.ts / agentAvatar.ts). Assim o mesmo clipe anima o boneco procedural,
// o avatar v1 (Mixamo) e o da Central (Meshy), sem depender do esqueleto de cada um.
// Mais a altura e o avanço da bacia (relativos ao comprimento da perna) e o quanto os dedos fecham.
//
// Formato (gzip; dentro, little-endian): "MOV1", u32 tamanho do JSON, JSON { fps, slots, clips: [{ key, frames,
// loop, offset }] }, depois os quadros: por quadro, SLOTS × 4 int16 (quaternion × 32767) e 5 int16
// (bacia y, z, x × 10000; dedos esquerda, direita × 32767).
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const require = createRequire(import.meta.url)
const repo = resolve(import.meta.dirname, '../..')
const { chromium } = require(join(repo, 'node_modules/playwright'))
const THREE_DIR = join(repo, 'node_modules/three')

const [dirArg, metaArg, outArg, fpsArg] = process.argv.slice(2)
if (!dirArg || !metaArg || !outArg) throw new Error('uso: node mixamo_motions.mjs <pasta-fbx> <meta.json> <saida.bin> [fps]')
const FPS = Number(fpsArg || 24)
const meta = JSON.parse(readFileSync(resolve(metaArg), 'utf8'))
const files = readdirSync(resolve(dirArg)).filter((f) => f.endsWith('.fbx')).map((f) => f.slice(0, -4)).sort()

const PAGE = `<!doctype html><html><body>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'

// Os segmentos, na ordem do arquivo (o app lê na mesma: motionLibrary.ts MOTION_SLOTS).
const SLOTS = ['hips', 'spine', 'neck', 'head', 'armL', 'foreL', 'handL', 'armR', 'foreR', 'handR', 'legL', 'kneeL', 'footL', 'legR', 'kneeR', 'footR']
const BONE = {
  hips: 'Hips', spine0: 'Spine', spine1: 'Spine1', spine: 'Spine2', neck: 'Neck', head: 'Head', headTop: 'HeadTop_End',
  armL: 'LeftArm', foreL: 'LeftForeArm', handL: 'LeftHand', midL: 'LeftHandMiddle1', idx1L: 'LeftHandIndex1', idx2L: 'LeftHandIndex2', idx3L: 'LeftHandIndex3',
  armR: 'RightArm', foreR: 'RightForeArm', handR: 'RightHand', midR: 'RightHandMiddle1', idx1R: 'RightHandIndex1', idx2R: 'RightHandIndex2', idx3R: 'RightHandIndex3',
  legL: 'LeftUpLeg', kneeL: 'LeftLeg', footL: 'LeftFoot', toeL: 'LeftToeBase', legR: 'RightUpLeg', kneeR: 'RightLeg', footR: 'RightFoot', toeR: 'RightToeBase'
}
const UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0)
const buf = async (p) => (await fetch(p)).arrayBuffer()
const wpos = (o) => o.getWorldPosition(new THREE.Vector3())

function find(root) {
  const by = {}
  root.traverse((o) => { if (o.isBone || o.type === 'Bone' || o.isObject3D) { const n = o.name.replace(/^mixamorig\\d*[:_]?/i, ''); if (!by[n]) by[n] = o } })
  const out = {}
  for (const [k, n] of Object.entries(BONE)) out[k] = by[n] || null
  return out
}

// O mesmo alinhamento do agentRest.ts: mira cada osso pela direção osso → filho.
function aim(root, bone, child, dir) {
  root.updateMatrixWorld(true)
  const cur = wpos(child).sub(wpos(bone))
  if (cur.lengthSq() < 1e-10) return
  const delta = new THREE.Quaternion().setFromUnitVectors(cur.normalize(), dir)
  const q = bone.getWorldQuaternion(new THREE.Quaternion())
  const qp = bone.parent.getWorldQuaternion(new THREE.Quaternion())
  bone.quaternion.copy(qp.invert().multiply(delta).multiply(q))
}

window.convert = async (key, fps) => {
  const fbx = new FBXLoader().parse(await buf('/fbx/' + key), '')
  const clip = fbx.animations[0]
  if (!clip) throw new Error(key + ': sem animação')
  const root = new THREE.Group()
  root.rotation.y = Math.PI
  root.add(fbx)
  const b = find(fbx)
  for (const k of ['hips', 'spine', 'neck', 'head', 'armL', 'foreL', 'handL', 'armR', 'foreR', 'handR', 'legL', 'kneeL', 'footL', 'legR', 'kneeR', 'footR']) if (!b[k]) throw new Error(key + ': falta ' + k)
  // Repouso (o bind do FBX): guarda as rotações locais para voltar a elas.
  const bones = []
  fbx.traverse((o) => { if (o.isBone || o.type === 'Bone') bones.push(o) })
  const bindQ = new Map(bones.map((o) => [o, o.quaternion.clone()]))
  const bindP = new Map(bones.map((o) => [o, o.position.clone()]))
  root.updateMatrixWorld(true)
  const floorY = Math.min(wpos(b.toeL || b.footL).y, wpos(b.toeR || b.footR).y)
  const leg = wpos(b.legL).distanceTo(wpos(b.kneeL)) + wpos(b.kneeL).distanceTo(wpos(b.footL)) + (wpos(b.footL).y - floorY)
  const hips0 = wpos(b.hips)
  // De pé, a bacia fica a esta altura do chão (o repouso do FBX sem pele pode ter a bacia na origem; o chão
  // dos clipes do Mixamo é y = 0): a altura do clipe é medida contra ela.
  const standH = hips0.y - floorY
  // Repouso alinhado (o mesmo encadeamento do prepareAvatar).
  const chain = [[b.hips, b.spine0, UP], [b.spine0, b.spine1, UP], [b.spine1, b.spine, UP], [b.spine, b.neck, UP], [b.neck, b.head, UP]]
  if (b.headTop) chain.push([b.head, b.headTop, UP])
  for (const s of ['L', 'R']) chain.push([b['leg' + s], b['knee' + s], DOWN], [b['knee' + s], b['foot' + s], DOWN], [b['arm' + s], b['fore' + s], DOWN], [b['fore' + s], b['hand' + s], DOWN], [b['hand' + s], b['mid' + s], DOWN])
  for (const [a, c, d] of chain) if (a && c) aim(root, a, c, d)
  for (const s of ['L', 'R']) {
    const toe = b['toe' + s]
    if (!toe) continue
    root.updateMatrixWorld(true)
    const dd = wpos(toe).sub(wpos(b['foot' + s]))
    aim(root, b['foot' + s], toe, new THREE.Vector3(0, dd.y, -Math.hypot(dd.x, dd.z)).normalize())
  }
  root.updateMatrixWorld(true)
  const restInv = {}
  for (const k of SLOTS) restInv[k] = b[k].getWorldQuaternion(new THREE.Quaternion()).invert()
  for (const o of bones) { o.quaternion.copy(bindQ.get(o)); o.position.copy(bindP.get(o)) }
  // Amostra o clipe.
  const mixer = new THREE.AnimationMixer(fbx)
  const action = mixer.clipAction(clip)
  action.play()
  const frames = Math.max(1, Math.round(clip.duration * fps))
  const out = new Int16Array(frames * (SLOTS.length * 4 + 5))
  const q = new THREE.Quaternion()
  const curl = (s) => {
    const h = wpos(b['hand' + s]), i1 = b['idx1' + s], i2 = b['idx2' + s], i3 = b['idx3' + s]
    if (!i1 || !i2 || !i3) return 0
    const base = wpos(i1).sub(h).normalize()
    const tip = wpos(i3).sub(wpos(i2)).normalize()
    return Math.max(0, Math.min(1, Math.acos(Math.max(-1, Math.min(1, base.dot(tip)))) / 2.4))
  }
  let o = 0
  for (let f = 0; f < frames; f++) {
    mixer.setTime(Math.min(clip.duration, f / fps))
    root.updateMatrixWorld(true)
    for (const k of SLOTS) {
      b[k].getWorldQuaternion(q).multiply(restInv[k])
      if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w)
      out[o++] = Math.round(q.x * 32767); out[o++] = Math.round(q.y * 32767); out[o++] = Math.round(q.z * 32767); out[o++] = Math.round(q.w * 32767)
    }
    const h = wpos(b.hips)
    const clampI = (v) => Math.max(-32767, Math.min(32767, Math.round(v)))
    out[o++] = clampI(((h.y - standH) / leg) * 10000)
    out[o++] = clampI(((h.z - hips0.z) / leg) * 10000)
    out[o++] = clampI(((h.x - hips0.x) / leg) * 10000)
    out[o++] = Math.round(curl('L') * 32767)
    out[o++] = Math.round(curl('R') * 32767)
  }
  const bytes = new Uint8Array(out.buffer)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return { frames, duration: clip.duration, b64: btoa(s), slots: SLOTS }
}
window.ready = true
</script></body></html>`

const browser = await chromium.launch()
const page = await browser.newPage()
page.on('pageerror', (e) => console.error('pageerror:', e.message))
await page.route('http://sandbox.local/**', async (route) => {
  const path = decodeURIComponent(new URL(route.request().url()).pathname)
  if (path === '/') return route.fulfill({ contentType: 'text/html', body: PAGE })
  if (path.startsWith('/fbx/')) return route.fulfill({ contentType: 'application/octet-stream', body: readFileSync(join(resolve(dirArg), path.slice(5) + '.fbx')) })
  if (path.startsWith('/three/')) {
    const file = join(THREE_DIR, path.slice('/three/'.length))
    if (existsSync(file)) return route.fulfill({ contentType: 'text/javascript', body: readFileSync(file) })
  }
  return route.fulfill({ status: 404, body: 'not found' })
})
await page.goto('http://sandbox.local/')
await page.waitForFunction(() => window.ready === true, null, { timeout: 120000 })

const clips = []
const chunks = []
let offset = 0
let slots = null
for (const key of files) {
  try {
    const r = await page.evaluate(([k, fps]) => window.convert(k, fps), [key, FPS])
    const data = Buffer.from(r.b64, 'base64')
    slots = r.slots
    clips.push({ key, frames: r.frames, loop: !!meta[key]?.loop, offset })
    chunks.push(data)
    offset += data.length
    console.log(`ok ${key}: ${r.duration.toFixed(2)} s, ${r.frames} quadros`)
  } catch (e) {
    console.error('falhou', key, e.message)
  }
}
const header = Buffer.from(JSON.stringify({ fps: FPS, slots, clips }), 'utf8')
const head = Buffer.alloc(8)
head.write('MOV1', 0, 'ascii')
head.writeUInt32LE(header.length, 4)
const pad = Buffer.alloc((2 - ((8 + header.length) % 2)) % 2)
// Gzip, como o ambiente.bin (o app descomprime com DecompressionStream).
const gz = gzipSync(Buffer.concat([head, header, pad, ...chunks]), { level: 9 })
writeFileSync(resolve(outArg), gz)
console.log(`movimentos: ${clips.length} clipes, ${((8 + header.length + offset) / 1e6).toFixed(2)} MB (gzip ${(gz.length / 1e6).toFixed(2)} MB) -> ${resolve(outArg)}`)
await browser.close()
