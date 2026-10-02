/**
 * Objetos de mão do Escritório 3D — xícara, livro, regador, celular, pasta,
 * plaquinha "Posso?" e post-it — e o "!" que salta da cabeça. Geometria,
 * material e textura COMPARTILHADOS: criados uma vez por cena e liberados
 * juntos em `dispose()`; cada personagem monta só Groups/Meshes leves por cima,
 * sob demanda (na 1ª vez que precisa).
 *
 * Cada objeto é modelado "em pé" no próprio referencial (Y para cima, frente
 * em -Z); o animador gira o objeto contra a inclinação da mão para ele ficar
 * de pé no mundo (a xícara não derrama). Os pequenos levam userData.lod =
 * 'detail'; a plaquinha não — é informação (o agente pede permissão).
 */
import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  SpriteMaterial,
  SRGBColorSpace,
  TorusGeometry,
  type BufferGeometry,
  type Material
} from 'three'
import type { PropKind } from './brain'
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

export function createPropKit() {
  const tex = { sign: signTexture(), bang: bangTexture() }
  const geo = {
    box: new BoxGeometry(1, 1, 1),
    cyl: new CylinderGeometry(0.5, 0.5, 1, 10),
    cone: new CylinderGeometry(0.25, 0.5, 1, 10),
    handle: new TorusGeometry(0.5, 0.16, 6, 10, Math.PI),
    plane: new PlaneGeometry(1, 1)
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
    bang: new SpriteMaterial({ map: tex.bang, transparent: true, depthWrite: false })
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

/** Onde o objeto fica na mão (referencial da mão: dedos em -Y, frente em -Z). */
export const GRIP: Record<PropKind, [number, number, number]> = {
  cup: [0, -0.05, -0.05],
  book: [-0.12, -0.08, -0.05],
  can: [0, -0.08, -0.02],
  phone: [0, -0.08, -0.02],
  folder: [0, -0.1, -0.03],
  sign: [0, -0.05, 0],
  note: [0, -0.08, -0.03]
}

/** Inclinação fixa do objeto depois de endireitado (o celular fica deitado na mão, a pasta em pé…). */
export const PROP_PITCH: Record<PropKind, number> = { cup: 0, book: 0, can: 0, phone: 0.6, folder: 0, sign: 0, note: 0 }

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
  }
  if (kind !== 'sign') g.traverse((o) => void (o.userData.lod = 'detail'))
  return g
}
