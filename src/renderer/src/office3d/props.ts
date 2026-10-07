/**
 * Objetos de mão do Escritório 3D — xícara, livro, regador, celular, pasta,
 * plaquinha "Posso?", post-it e, na festa do apagão, a lanterna (com o cone de
 * luz falso: malha aditiva, sem luz de verdade) e a fatia de pizza — e o "!"
 * que salta da cabeça. Geometria,
 * material e textura COMPARTILHADOS: criados uma vez por cena e liberados
 * juntos em `dispose()`; cada personagem monta só Groups/Meshes leves por cima,
 * sob demanda (na 1ª vez que precisa).
 *
 * Cada objeto é modelado "em pé" no próprio referencial (Y para cima, frente
 * em -Z); o animador gira o objeto contra a inclinação da mão para ele ficar
 * de pé no mundo (a xícara não derrama). Os pequenos levam userData.lod =
 * 'detail'; a xícara, 'small' (aparece no MÉDIO); a plaquinha e a lanterna,
 * nada (propShown).
 */
import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  Quaternion,
  SpriteMaterial,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D
} from 'three'
import type { PropKind } from './brain'
import type { Lod } from './lod'
import { canvas2d } from './textures'

const lambert = (color: number): MeshLambertMaterial => new MeshLambertMaterial({ color })

function texture(canvas: HTMLCanvasElement): CanvasTexture {
  const t = new CanvasTexture(canvas)
  t.colorSpace = SRGBColorSpace
  return t
}

/** Plaquinha "Posso?": cartolina branca, borda grossa e letra de mão. */
function signTexture(): CanvasTexture {
  const { canvas, ctx } = canvas2d(256, 160)
  if (ctx) {
    ctx.fillStyle = '#fffdf4'
    ctx.fillRect(0, 0, 256, 160)
    ctx.strokeStyle = '#2b2f3a'
    ctx.lineWidth = 12
    ctx.strokeRect(6, 6, 244, 148)
    ctx.fillStyle = '#c0392b'
    ctx.font = 'bold 64px "Segoe UI", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('Posso?', 128, 84)
  }
  return texture(canvas)
}

/** "!" num distintivo amarelo (sprite: sempre de frente para a câmera). */
function bangTexture(): CanvasTexture {
  const { canvas, ctx } = canvas2d(128, 128)
  if (ctx) {
    ctx.fillStyle = '#ffd23f'
    ctx.strokeStyle = '#1f2330'
    ctx.lineWidth = 8
    ctx.beginPath()
    ctx.arc(64, 64, 54, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#1f2330'
    ctx.font = 'bold 92px "Segoe UI", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('!', 64, 70)
  }
  return texture(canvas)
}

/** Facho da lanterna: forte na lente, some no fim do cone (alfa ao longo de v). */
function beamTexture(): CanvasTexture {
  const { canvas, ctx } = canvas2d(4, 64)
  if (ctx) {
    const g = ctx.createLinearGradient(0, 64, 0, 0)
    g.addColorStop(0, 'rgba(255,255,255,0)')
    g.addColorStop(0.75, 'rgba(255,255,255,0.35)')
    g.addColorStop(1, 'rgba(255,255,255,1)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 4, 64)
  }
  return texture(canvas)
}

/** Comprimento do facho da lanterna (m). */
export const BEAM_LENGTH = 2.3

export function createPropKit() {
  const tex = { sign: signTexture(), bang: bangTexture(), beam: beamTexture() }
  const beam = new CylinderGeometry(0.035, 0.62, BEAM_LENGTH, 18, 1, true)
  // A ponta fina (topo, v = 1) na lente e o facho para a frente (-Z).
  beam.rotateX(Math.PI / 2)
  beam.translate(0, 0, -BEAM_LENGTH / 2)
  const geo = {
    box: new BoxGeometry(1, 1, 1),
    cyl: new CylinderGeometry(0.5, 0.5, 1, 10),
    cone: new CylinderGeometry(0.25, 0.5, 1, 10),
    handle: new TorusGeometry(0.5, 0.16, 6, 10, Math.PI),
    plane: new PlaneGeometry(1, 1),
    beam,
    slice: new CylinderGeometry(0.5, 0.5, 1, 3)
  }
  const mat = {
    cup: lambert(0xf4f1ea),
    coffee: lambert(0x4a2c1a),
    cover: lambert(0x8e3b46),
    pages: lambert(0xf3ecd8),
    can: lambert(0x3f9a6c),
    phone: lambert(0x1b1d22),
    screen: new MeshBasicMaterial({ color: 0x8fd8ff }),
    folder: lambert(0xe2b65c),
    paper: lambert(0xfbf7ee),
    stick: lambert(0x8a6a48),
    sign: new MeshBasicMaterial({ map: tex.sign, side: DoubleSide }),
    note: lambert(0xfff27a),
    bang: new SpriteMaterial({ map: tex.bang, transparent: true, depthWrite: false }),
    torch: lambert(0x30343c),
    lens: new MeshBasicMaterial({ color: 0xfff6c8 }),
    // Aditivo, sem gravar profundidade, desenhado depois do escurecimento da sala.
    beam: new MeshBasicMaterial({ color: 0xffe9a8, map: tex.beam, transparent: true, opacity: 0.5, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }),
    cheese: lambert(0xf2c14e),
    pepperoni: lambert(0xb8322a),
    crust: lambert(0xc98a3a)
  }
  return {
    tex,
    geo,
    mat,
    dispose(): void {
      for (const g of Object.values(geo) as BufferGeometry[]) g.dispose()
      for (const m of Object.values(mat) as Material[]) m.dispose()
      for (const t of Object.values(tex)) t.dispose()
    }
  }
}

export type PropKit = ReturnType<typeof createPropKit>

/**
 * Onde o objeto fica na mão (referencial da mão: dedos em -Y, frente em -Z). A xícara é a exceção: é o
 * ponto dos dedos onde fica a alça (holdCup pendura a xícara por ele, de pé no mundo).
 */
export const GRIP: Record<PropKind, [number, number, number]> = {
  cup: [0, -0.07, -0.01],
  book: [-0.12, -0.08, -0.05],
  can: [0, -0.08, -0.02],
  phone: [0, -0.08, -0.02],
  folder: [0, -0.1, -0.03],
  sign: [0, -0.05, 0],
  note: [0, -0.08, -0.03],
  flashlight: [0, -0.05, -0.02],
  pizza: [0, -0.06, -0.04]
}

/**
 * O mesmo na mão do avatar GLB (agentAvatar.ts: encaixe com os eixos da mão do
 * boneco, mas a palma olha para dentro, −X na direita): o objeto fica na palma.
 */
export const GRIP_AVATAR: Record<PropKind, [number, number, number]> = {
  cup: [-0.03, -0.1, 0],
  book: [-0.1, -0.1, -0.04],
  can: [-0.05, -0.1, 0],
  phone: [-0.035, -0.1, 0],
  folder: [-0.035, -0.13, 0],
  sign: [-0.035, -0.08, 0],
  note: [-0.03, -0.1, 0],
  flashlight: [-0.04, -0.08, 0],
  pizza: [-0.04, -0.09, -0.02]
}

/** Quanto os dedos do avatar fecham em volta de cada objeto (0 aberta … 1 punho). */
export const HOLD_CURL: Record<PropKind, number> = { cup: 0.6, book: 0.3, can: 0.7, phone: 0.35, folder: 0.5, sign: 0.75, note: 0.3, flashlight: 0.75, pizza: 0.3 }

/** Inclinação fixa do objeto depois de endireitado (o celular fica deitado na mão, a lanterna aponta um pouco para o chão…). */
export const PROP_PITCH: Record<PropKind, number> = { cup: 0, book: 0, can: 0, phone: 0.6, folder: 0, sign: 0, note: 0, flashlight: -0.32, pizza: 0.35 }

/** Monta o objeto `kind` com as peças compartilhadas do kit. */
export function makeProp(kit: PropKit, kind: PropKind): Group {
  const g = new Group()
  g.name = `prop:${kind}`
  const { geo, mat } = kit
  const add = (gm: BufferGeometry, m: Material, s: [number, number, number], p: [number, number, number], r: [number, number, number] = [0, 0, 0]): Mesh => {
    const mesh = new Mesh(gm, m)
    mesh.scale.set(...s)
    mesh.position.set(...p)
    mesh.rotation.set(...r)
    g.add(mesh)
    return mesh
  }
  switch (kind) {
    case 'cup':
      add(geo.cyl, mat.cup, [0.075, 0.09, 0.075], [0, 0.045, 0])
      add(geo.cyl, mat.coffee, [0.064, 0.004, 0.064], [0, 0.088, 0])
      add(geo.handle, mat.cup, [0.05, 0.05, 0.05], [0.04, 0.045, 0], [0, 0, -Math.PI / 2])
      break
    case 'book':
      // Aberto em V, as páginas viradas para quem lê.
      add(geo.box, mat.cover, [0.13, 0.17, 0.012], [-0.065, 0, 0], [0.5, 0.35, 0])
      add(geo.box, mat.cover, [0.13, 0.17, 0.012], [0.065, 0, 0], [0.5, -0.35, 0])
      add(geo.box, mat.pages, [0.12, 0.16, 0.01], [-0.06, 0, 0.008], [0.5, 0.35, 0])
      add(geo.box, mat.pages, [0.12, 0.16, 0.01], [0.06, 0, 0.008], [0.5, -0.35, 0])
      break
    case 'can':
      add(geo.cyl, mat.can, [0.13, 0.13, 0.13], [0, 0.03, 0])
      add(geo.cyl, mat.can, [0.022, 0.2, 0.022], [0, 0.07, -0.12], [-1.05, 0, 0])
      add(geo.cone, mat.can, [0.05, 0.04, 0.05], [0, 0.12, -0.21], [-1.05, 0, 0])
      add(geo.handle, mat.can, [0.08, 0.08, 0.08], [0, 0.1, 0.02], [0, Math.PI / 2, 0])
      break
    case 'phone':
      add(geo.box, mat.phone, [0.065, 0.012, 0.12], [0, 0, 0])
      add(geo.plane, mat.screen, [0.055, 0.105, 1], [0, 0.0065, 0], [-Math.PI / 2, 0, 0])
      break
    case 'folder':
      add(geo.box, mat.folder, [0.24, 0.3, 0.02], [0, 0.1, -0.02])
      add(geo.box, mat.paper, [0.2, 0.26, 0.004], [0, 0.11, -0.033])
      break
    case 'sign':
      add(geo.cyl, mat.stick, [0.02, 0.42, 0.02], [0, 0.18, 0])
      add(geo.box, mat.stick, [0.4, 0.27, 0.015], [0, 0.48, 0])
      add(geo.plane, mat.sign, [0.37, 0.24, 1], [0, 0.48, -0.009], [0, Math.PI, 0])
      break
    case 'note':
      add(geo.box, mat.note, [0.07, 0.07, 0.004], [0, 0.02, -0.01])
      break
    case 'flashlight': {
      add(geo.cyl, mat.torch, [0.05, 0.16, 0.05], [0, 0, -0.03], [Math.PI / 2, 0, 0])
      add(geo.cyl, mat.lens, [0.062, 0.012, 0.062], [0, 0, -0.112], [Math.PI / 2, 0, 0])
      const cone = add(geo.beam, mat.beam, [1, 1, 1], [0, 0, -0.118])
      cone.renderOrder = 3
      cone.castShadow = false
      break
    }
    case 'pizza':
      // Fatia (prisma triangular achatado) com a ponta para a frente, borda e calabresa.
      add(geo.slice, mat.cheese, [0.17, 0.012, 0.17], [0, 0, -0.03], [0, Math.PI / 3, 0])
      add(geo.box, mat.crust, [0.15, 0.022, 0.03], [0, 0.004, 0.014])
      add(geo.cyl, mat.pepperoni, [0.03, 0.006, 0.03], [-0.015, 0.008, -0.025])
      add(geo.cyl, mat.pepperoni, [0.026, 0.006, 0.026], [0.02, 0.008, -0.005])
      break
  }
  // A marca segue propShown: some no MÉDIO ('detail') ou só no LONGE ('small').
  const tag = kind === 'sign' || kind === 'flashlight' ? null : kind === 'cup' ? 'small' : 'detail'
  if (tag) g.traverse((o) => void (o.userData.lod = tag))
  return g
}

/**
 * O objeto na mão aparece no nível `lod`? PERTO todos; MÉDIO só a plaquinha (informação), a lanterna
 * (efeito da festa) e a xícara (o café é a pausa que mais se vê na distância de uso — sem ela a mão
 * "segura nada"); LONGE nenhum.
 */
export function propShown(kind: PropKind, lod: Lod): boolean {
  return lod === 0 || (lod === 1 && (kind === 'sign' || kind === 'flashlight' || kind === 'cup'))
}

/** Onde os dedos pegam a xícara: a alça (no referencial da xícara, a alça em +X). */
export const CUP_HANDLE = new Vector3(0.062, 0.045, 0)
const AXIS_X = new Vector3(1, 0, 0)
/** A alça para trás (+Z do personagem): a xícara fica À FRENTE dos dedos, à vista, e não dentro do punho. */
const CUP_YAW = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2)
const qHand = new Quaternion()
const qTilt = new Quaternion()
const off = new Vector3()

/**
 * A xícara `p` (filha da mão, com o encaixe `p.userData.grip` de agentBody.hold) de pé no MUNDO, com o
 * rumo de `body` (o grupo do personagem) e pendurada pela alça no encaixe; só `tilt` a inclina em torno
 * do X dele (o gole leva a boca ao rosto). Pela mão de verdade (osso do avatar ou junta do boneco), não
 * pelos canais da pose: com um clipe do Mixamo no braço, a conta pelos canais deitava a xícara.
 */
export function holdCup(p: Object3D, body: Object3D, tilt: number): void {
  const hand = p.parent!
  hand.updateWorldMatrix(true, false)
  hand.getWorldQuaternion(qHand).invert()
  body.getWorldQuaternion(p.quaternion).multiply(qTilt.setFromAxisAngle(AXIS_X, tilt)).multiply(CUP_YAW).premultiply(qHand)
  const g = p.userData.grip as [number, number, number] | undefined
  if (g) p.position.set(g[0], g[1], g[2]).sub(off.copy(CUP_HANDLE).applyQuaternion(p.quaternion))
}
