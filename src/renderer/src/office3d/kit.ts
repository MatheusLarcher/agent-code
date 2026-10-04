/**
 * Geometrias, materiais e texturas COMPARTILHADOS da cena 3D: criados uma vez
 * por cena e liberados juntos em `dispose()`. Salas e personagens só montam
 * Meshes/InstancedMeshes em cima disto; o que é por sala (piso, placa, telas)
 * ou por personagem (roupa, pele) é liberado por quem criou.
 */
import {
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  IcosahedronGeometry,
  MeshBasicMaterial,
  MeshLambertMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  SphereGeometry,
  SpriteMaterial,
  type BufferGeometry,
  type Material,
  type Texture
} from 'three'
import { createRugTexture, createScreensaverTexture, createSkyTexture, createWoodTexture, createZTexture } from './textures'

export const SCREEN_W = 0.88
export const SCREEN_H = 0.5

const lambert = (color: number, extra: ConstructorParameters<typeof MeshLambertMaterial>[0] = {}): MeshLambertMaterial =>
  new MeshLambertMaterial({ color, ...extra })

export type BubbleKind = 'permissao' | 'pergunta' | 'ok' | 'erro' | 'ampulheta'

const BUBBLE_COLORS: Record<BubbleKind, number> = {
  permissao: 0xffc400,
  pergunta: 0x4aa3ff,
  ok: 0x3ccf6e,
  erro: 0xff4d4d,
  ampulheta: 0xb0b6c0
}

/** Status do dono da mesa: a cor do monitor visto de LONGE (bloco emissivo, sem textura). */
export type ScreenStatus = 'working' | 'permission' | 'error' | 'done' | 'idle'

const STATUS_COLORS: Record<ScreenStatus, number> = {
  working: 0x4f8fe6,
  permission: BUBBLE_COLORS.permissao,
  error: BUBBLE_COLORS.erro,
  done: BUBBLE_COLORS.ok,
  idle: 0x1f2a40
}

export function createKit(anisotropy: number) {
  const tex = {
    wood: createWoodTexture(anisotropy),
    rug: createRugTexture(),
    screensaver: createScreensaverTexture(),
    z: createZTexture()
  }
  const sky = createSkyTexture()
  // Céu de noite com lua: as janelas no apagão (luar), seja qual for a hora.
  const night = createSkyTexture()
  night.draw(23)
  const geo = {
    box: new BoxGeometry(1, 1, 1),
    cyl: new CylinderGeometry(0.5, 0.5, 1, 12),
    cone: new CylinderGeometry(0.3, 0.5, 1, 12, 1, true),
    plane: new PlaneGeometry(1, 1),
    screen: new PlaneGeometry(SCREEN_W, SCREEN_H),
    leaf: new IcosahedronGeometry(0.5, 0),
    torso: new CylinderGeometry(0.16, 0.2, 0.46, 10),
    head: new SphereGeometry(0.15, 14, 12),
    hair: new SphereGeometry(0.162, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
    alert: new OctahedronGeometry(0.07, 0),
    bubble: new SphereGeometry(0.05, 10, 8)
  }
  const mat = {
    ground: lambert(0x24212a),
    floor: lambert(0xffffff, { map: tex.wood }),
    wall: lambert(0xeadfcb),
    wallCap: lambert(0x8a7560),
    baseboard: lambert(0x5b4636),
    deskTop: lambert(0xb08356),
    deskLeg: lambert(0x34363c),
    chair: lambert(0x2b2e36),
    chairSeat: lambert(0x3d4a63),
    frame: lambert(0x15171b),
    keyboard: lambert(0x2a2d33),
    mug: lambert(0xf2efe8),
    screenOff: lambert(0x0b0d10),
    screensaver: new MeshBasicMaterial({ map: tex.screensaver }),
    windowFrame: lambert(0xf4efe6),
    sky: new MeshBasicMaterial({ map: sky.texture }),
    skyNight: new MeshBasicMaterial({ map: night.texture }),
    glass: new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08, depthWrite: false }),
    corkFrame: lambert(0x6e4a2c),
    note: lambert(0xffffff),
    shelf: lambert(0x6b4a2f),
    book: lambert(0xffffff),
    pot: lambert(0xb5653e),
    leaf: lambert(0x3f8f4a),
    leafDark: lambert(0x2c6e38),
    soil: lambert(0x3a2a1e),
    metal: lambert(0x2b2b2b),
    steel: lambert(0xb9bec6),
    shade: lambert(0xffe2b0, { emissive: 0xffc878, emissiveIntensity: 0.85, side: DoubleSide }),
    bulb: new MeshBasicMaterial({ color: 0xfff1d0 }),
    // Luminária apagada (economia, apagão, piscada do alerta): troca de material, não de luz.
    shadeOff: lambert(0xcbbd9f, { side: DoubleSide }),
    bulbOff: lambert(0x6f6a62),
    redLed: new MeshBasicMaterial({ color: 0xff3b30 }),
    greenLed: new MeshBasicMaterial({ color: 0x34c759 }),
    coffee: lambert(0x2a2d33),
    rug: lambert(0xffffff, { map: tex.rug }),
    pufe: lambert(0xd9893b),
    door: lambert(0x9b6b43),
    signFrame: lambert(0x3b2a1c),
    signShadow: new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false }),
    pants: [0x2f3a52, 0x3b3b40, 0x4a3b2e, 0x26354a].map((c) => lambert(c)),
    shoe: lambert(0x1b1b1f),
    eye: new MeshBasicMaterial({ color: 0x111318 }),
    bubbles: Object.fromEntries(
      (Object.keys(BUBBLE_COLORS) as BubbleKind[]).map((k) => [k, lambert(BUBBLE_COLORS[k], { emissive: BUBBLE_COLORS[k], emissiveIntensity: 0.6 })])
    ) as Record<BubbleKind, MeshLambertMaterial>,
    status: Object.fromEntries((Object.keys(STATUS_COLORS) as ScreenStatus[]).map((k) => [k, new MeshBasicMaterial({ color: STATUS_COLORS[k] })])) as Record<
      ScreenStatus,
      MeshBasicMaterial
    >,
    z: new SpriteMaterial({ map: tex.z, transparent: true, depthWrite: false })
  }
  return {
    anisotropy,
    tex,
    sky,
    geo,
    mat,
    dispose(): void {
      for (const g of Object.values(geo) as BufferGeometry[]) g.dispose()
      const { pants, bubbles, status, ...rest } = mat
      for (const m of [...Object.values(rest), ...pants, ...Object.values(bubbles), ...Object.values(status)] as Material[]) m.dispose()
      for (const t of [...Object.values(tex), sky.texture, night.texture] as Texture[]) t.dispose()
    }
  }
}

export type Kit = ReturnType<typeof createKit>
