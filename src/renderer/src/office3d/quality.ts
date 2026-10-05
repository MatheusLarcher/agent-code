/**
 * Qualidade global do Escritório 3D e os números do HUD de desempenho (DEV).
 *
 * O nível global é o mais detalhado entre as salas à vista (scene.updateView):
 * LONGE baixa o pixelRatio para FAR_PIXEL_SCALE (o "embaçado"), liga a névoa
 * suave e desliga a sombra do sol (scene.setQuality); voltar desfaz. O shadow
 * map do renderer fica com autoUpdate desligado e só é refeito quando a cena
 * acusa mudança no que projeta sombra (`shadowDirty`).
 */
import type { RendererLike } from './engine'
import { FAR_PIXEL_SCALE, type Lod } from './lod'
import type { OfficeScene } from './scene'

export interface EngineStats {
  /** Quadros por segundo do laço (vale enquanto ele roda). */
  fps: number
  /** renderer.info.render do último quadro (com o passo de sombra quando ele roda). */
  calls: number
  triangles: number
  /** Salas à vista / total. */
  rooms: number
  roomsTotal: number
  /** Nível global: 0 perto, 1 médio, 2 longe. */
  lod: Lod
  pixelRatio: number
  /** Vezes que o shadow map foi refeito desde a montagem. */
  shadowUpdates: number
  /** Intervalo entre quadros seguidos (ms): média e P95 dos últimos FRAME_WINDOW. */
  frameMs: number
  frameP95: number
  /** Trabalho do quadro no JS (animar + render, ms): média e P95. */
  workMs: number
  workP95: number
}

/** Quadros na janela da média e do P95 do tempo de quadro. */
export const FRAME_WINDOW = 300

/** Média e P95 de `n` amostras de `buf`. */
export function meanP95(buf: Float32Array, n: number): [number, number] {
  if (n === 0) return [0, 0]
  const a = Array.from(buf.subarray(0, n)).sort((x, y) => x - y)
  return [a.reduce((s, x) => s + x, 0) / n, a[Math.min(n - 1, Math.floor(n * 0.95))]]
}

export class Quality {
  readonly stats: EngineStats
  level: Lod = 0
  private t0 = 0
  private frames = 0
  private prev = -1
  private readonly gaps = new Float32Array(FRAME_WINDOW)
  private readonly work = new Float32Array(FRAME_WINDOW)
  private gapN = 0
  private workN = 0
  private slot = 0

  constructor(
    private readonly renderer: RendererLike,
    private readonly base: number
  ) {
    renderer.setPixelRatio(base)
    this.stats = { fps: 0, calls: 0, triangles: 0, rooms: 0, roomsTotal: 0, lod: 0, pixelRatio: base, shadowUpdates: 0, frameMs: 0, frameP95: 0, workMs: 0, workP95: 0 }
  }

  /** Depois do culling/LOD: o nível global decide resolução, névoa (pela distância da câmera) e sol. */
  apply(scene: OfficeScene, level: Lod, camDistance: number): void {
    if (level !== this.level) {
      this.level = level
      const ratio = this.base * (level === 2 ? FAR_PIXEL_SCALE : 1)
      this.renderer.setPixelRatio(ratio)
      this.stats.pixelRatio = ratio
    }
    scene.setQuality(level, camDistance)
    this.stats.lod = level
    this.stats.rooms = scene.visibleRooms
    this.stats.roomsTotal = scene.zoneCount
  }

  /** Antes do render: pede o shadow map só se algo que projeta sombra mudou (e o sol projeta). */
  shadows(scene: OfficeScene): void {
    if (!scene.shadowDirty || !scene.castsShadows) return
    scene.shadowDirty = false
    const sm = this.renderer.shadowMap
    if (!sm) return
    sm.needsUpdate = true
    this.stats.shadowUpdates++
  }

  /** Depois do render: contadores do renderer, quadros por segundo (janela de ~0,5 s) e o tempo de quadro (`end` = fim do trabalho). */
  measure(now: number, end = now): void {
    const i = this.slot
    this.slot = (i + 1) % FRAME_WINDOW
    this.work[i] = end - now
    this.workN = Math.min(FRAME_WINDOW, this.workN + 1)
    if (this.prev >= 0) {
      this.gaps[i] = now - this.prev
      this.gapN = Math.min(FRAME_WINDOW, this.gapN + 1)
    }
    this.prev = now
    const info = this.renderer.info?.render
    if (info) {
      this.stats.calls = info.calls
      this.stats.triangles = info.triangles
    }
    this.frames++
    const span = now - this.t0
    if (span >= 500) {
      this.stats.fps = Math.round((this.frames * 1000) / span)
      ;[this.stats.frameMs, this.stats.frameP95] = meanP95(this.gaps, this.gapN)
      ;[this.stats.workMs, this.stats.workP95] = meanP95(this.work, this.workN)
      this.t0 = now
      this.frames = 0
    }
  }

  /** O laço vai recomeçar depois de parado: a janela do fps começa agora. */
  restart(now: number): void {
    this.t0 = now
    this.frames = 0
    // O intervalo de um quadro parado até o próximo não é tempo de quadro.
    this.prev = -1
  }
}
