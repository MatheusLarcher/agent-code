/**
 * Geometrias, materiais e texturas COMPARTILHADOS da cena 3D: criados uma vez
 * por cena e liberados juntos em `dispose()`. Salas e personagens só montam
 * Meshes/InstancedMeshes em cima disto; o que é por sala (piso, placa, telas)
 * ou por personagem (roupa, pele) é liberado por quem criou.
 */
import {
  BoxGeometry,
  CircleGeometry,
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
import { createBodyGeometries } from './bodyGeo'
import { createConcreteTexture, createFeltTexture, createOakTexture, createRugTexture, createScreensaverTexture, createSkyTexture, createWoodTexture, createZTexture } from './textures'

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
    concrete: createConcreteTexture(anisotropy),
    oak: createOakTexture(anisotropy),
    felt: createFeltTexture(),
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
    /** Disco de raio 1 no plano XY (tapetes redondos: gire −π/2 em x). */
    disc: new CircleGeometry(1, 48),
    screen: new PlaneGeometry(SCREEN_W, SCREEN_H),
    leaf: new IcosahedronGeometry(0.5, 0),
    /** Cúpula (o giroflex do painel de energia). */
    dome: new SphereGeometry(0.15, 14, 12),
    /** O corpo dos agentes (bodyGeo.ts). */
    ...createBodyGeometries(),
    alert: new OctahedronGeometry(0.07, 0),
    bubble: new SphereGeometry(0.05, 10, 8)
  }
  const mat = {
    ground: lambert(0x24212a),
    floor: lambert(0xffffff, { map: tex.concrete }),
    wall: lambert(0xe6e7dc),
    wallCap: lambert(0xcfd0c4),
    baseboard: lambert(0x96774f),
    deskTop: lambert(0xffffff, { map: tex.oak }),
    deskLeg: lambert(0xeceade),
    chair: lambert(0x343935),
    chairSeat: lambert(0x48584d),
    frame: lambert(0x36423b),
    keyboard: lambert(0x36423b),
    mug: lambert(0xf2efe8),
    screenOff: lambert(0x0b0d10),
    screensaver: new MeshBasicMaterial({ map: tex.screensaver }),
    windowFrame: lambert(0xf4efe6),
    sky: new MeshBasicMaterial({ map: sky.texture }),
    skyNight: new MeshBasicMaterial({ map: night.texture }),
    glass: new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08, depthWrite: false }),
    corkFrame: lambert(0x6e4a2c),
    note: lambert(0xffffff),
    shelf: lambert(0xffffff, { map: tex.oak }),
    book: lambert(0xffffff),
    pot: lambert(0xc9c3b3),
    leaf: lambert(0x94a276),
    leafDark: lambert(0x6f8055),
    soil: lambert(0x4c3a25),
    metal: lambert(0x343935),
    steel: lambert(0xb9bec6),
    shade: lambert(0xfff0ce, { emissive: 0xffcc83, emissiveIntensity: 0.8, side: DoubleSide }),
    bulb: new MeshBasicMaterial({ color: 0xfff1d0 }),
    // Luminária apagada (economia, apagão, piscada do alerta): troca de material, não de luz.
    shadeOff: lambert(0xcbbd9f, { side: DoubleSide }),
    bulbOff: lambert(0x6f6a62),
    redLed: new MeshBasicMaterial({ color: 0xff3b30 }),
    greenLed: new MeshBasicMaterial({ color: 0x34c759 }),
    coffee: lambert(0x2a2d33),
    rug: lambert(0xffffff, { map: tex.rug }),
    door: lambert(0xd3bf9a),
    // ── escritório v2
    oakDark: lambert(0x96774f),
    cream: lambert(0xeceade),
    charcoal: lambert(0x36423b),
    felt: lambert(0xffffff, { map: tex.felt }),
    rugIsland: lambert(0xd0d3c6, { map: tex.felt }),
    rugPlaza: lambert(0xa9b7a2, { map: tex.felt }),
    rugLounge: lambert(0xe6e3d6, { map: tex.felt }),
    sofa: lambert(0xd3d6c5),
    sage: lambert(0x6c8170),
    brass: lambert(0xa58d61),
    paper: lambert(0xeee7d6),
    binder: lambert(0x6e796d),
    trail: lambert(0xeceae1),
    plaque: lambert(0xd4d7cc),
    /** Vidro claro (sala de reunião e parede de vidro): não escreve profundidade, não entra no clique. */
    pane: new MeshBasicMaterial({ color: 0xa1b4ab, transparent: true, opacity: 0.16, depthWrite: false, side: DoubleSide }),
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
