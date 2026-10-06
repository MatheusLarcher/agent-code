/**
 * Rig de um personagem no Mixamo pela API do próprio site (a mesma que a página
 * usa), com a sessão de uma conta logada: envia o ZIP (OBJ + MTL + cor,
 * glb_to_obj_zip.py), faz o auto-rig com os marcadores dados e o esqueleto
 * Standard (65 ossos, com dedos) e baixa o FBX com a pele na pose original.
 *
 *   node mixamo_rig.mjs <personagem.zip> <marcadores.json> <saida.fbx>
 *
 * O auto-rig pela API pode falhar ("Unknown error while generating motion"); o
 * caminho garantido é a tela do site: enviar e posicionar os marcadores lá e,
 * com MIXAMO_CHARACTER_ID=<id> MIXAMO_SKIP_RIG=1, este script só exporta.
 *
 * A sessão vem do arquivo apontado por MIXAMO_SESSION_FILE (o access_token do
 * localStorage de www.mixamo.com numa conta logada). Nunca grave esse arquivo no
 * repositório nem o imprima. Marcadores: chin, larm, rarm, lelbow, relbow,
 * lknee, rknee, groin em {x, y, z} nas coordenadas do OBJ (pulsos = larm/rarm;
 * esquerda = a do personagem, +X com ele de frente para +Z).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

const [zipArg, markersArg, outArg] = process.argv.slice(2)
if (!zipArg || !markersArg || !outArg) throw new Error('uso: node mixamo_rig.mjs <zip> <marcadores.json> <saida.fbx>')
const sessionFile = process.env.MIXAMO_SESSION_FILE
if (!sessionFile) throw new Error('defina MIXAMO_SESSION_FILE (arquivo com o access_token do Mixamo)')
const token = readFileSync(sessionFile, 'utf8').trim()
const API = 'https://www.mixamo.com/api/v1'
const H = { Authorization: `Bearer ${token}`, 'X-Api-Key': 'mixamo2' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function call(method, path, body) {
  const json = body !== undefined && !(body instanceof FormData)
  const r = await fetch(`${API}${path}`, { method, headers: json ? { ...H, 'Content-Type': 'application/json; charset=utf-8' } : H, body: json ? JSON.stringify(body) : body })
  const text = await r.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {}
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${text.slice(0, 300)}`)
  return data
}

async function poll(path, done, label, maxS = 600) {
  for (let s = 0; s < maxS; s += 3) {
    const d = await call('GET', path)
    const v = done(d)
    if (v) return d
    if (s % 15 === 0) console.log(`  ${label}: ${JSON.stringify(d).slice(0, 160)}`)
    await sleep(3000)
  }
  throw new Error(`${label}: tempo esgotado`)
}

// 1. Envio (ou o personagem já enviado: MIXAMO_CHARACTER_ID).
let id = process.env.MIXAMO_CHARACTER_ID
if (!id) {
const fd = new FormData()
fd.append('file', new Blob([readFileSync(zipArg)], { type: 'application/zip' }), basename(zipArg))
const up = await call('POST', '/characters', fd)
id = up.uuid ?? up.character_id ?? up.id
console.log('enviado:', JSON.stringify({ id, status: up.status }))
await poll(`/characters/${id}/monitor`, (d) => d.status === 'completed' || d.status === 'failed', 'processando o envio')
}
const ch = await call('GET', `/characters/${id}`)
console.log('personagem:', JSON.stringify({ status: ch.status, name: ch.name }))

// 2. Auto-rig (pulado com MIXAMO_SKIP_RIG=1: o rig foi feito pela tela de marcadores do site).
if (!process.env.MIXAMO_SKIP_RIG) {
// Auto-rig: marcadores (coordenadas do OBJ), frente +Z, simétrico, esqueleto Standard (sem skeleton-lod = 65 ossos, com dedos).
const markers = JSON.parse(readFileSync(markersArg, 'utf8'))
// Os marcadores ficam à frente do modelo (o site os põe no plano próximo da câmera ortográfica em +Z): z = 300 (cm).
// 'skeleton-lod' vazio = Standard (65 ossos, com dedos); sem a chave o Mixamo recusa.
const front = Object.fromEntries(Object.entries(markers).map(([k, v]) => [k, { x: v.x, y: v.y, z: 300 }]))
const rigging_inputs = { ...front, orientation: { x: 0, y: 0, z: 0, w: 1 }, symmetric: true, for: 'both', 'skeleton-lod': process.env.MIXAMO_LOD ?? '' }
const rig = await call('PUT', `/characters/${id}/rig`, { rigging_inputs })
console.log('rig pedido:', JSON.stringify({ status: rig?.status, message: rig?.message }))
// O job do rig: o status do personagem só muda quando ele termina (antes disso ainda diz needs_rigging).
await sleep(5000)
const job1 = await poll(`/characters/${id}/monitor`, (d) => d.status === 'completed' || d.status === 'failed', 'rigando')
const rigged = await call('GET', `/characters/${id}`)
if (rigged.status !== 'ready') console.error('rig:', JSON.stringify(job1.job_result ?? job1), '| personagem', id)
if (rigged.status !== 'ready') throw new Error('o Mixamo não conseguiu rigar com estes marcadores')
console.log('rigado')
}

// 3. Exportação: FBX binário, com pele, pose original.
const job = await call('POST', '/animations/export', {
  character_id: id,
  type: 'Character',
  product_name: basename(outArg, '.fbx'),
  preferences: { format: 'fbx7_2019', skin: 'true', mesh: 'original', fps: '30', reducekf: '0' },
  gms_hash: null
})
const fin = await poll(`/characters/${job.uuid ?? id}/monitor`, (d) => d.status === 'completed' || d.status === 'failed', 'exportando')
if (fin.status !== 'completed' || !fin.job_result) throw new Error(`exportação falhou: ${JSON.stringify(fin).slice(0, 300)}`)
const fbx = Buffer.from(await (await fetch(fin.job_result)).arrayBuffer())
writeFileSync(outArg, fbx)
console.log(`ok: ${outArg} (${(fbx.length / 1e6).toFixed(1)} MB) | personagem ${id}`)
