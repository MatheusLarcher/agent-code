import type { Camera, Material, Object3D, Scene, Texture } from 'three'
import type { RendererLike } from './engineTypes'

/**
 * O aquecimento da GPU do Escritório 3D, antes dos quadros: os shaders do que vai
 * aparecer compilam em paralelo (compileAsync, extensão KHR_parallel_shader_compile),
 * com luzes e ambiente já postos, uma peça da cena por fatia de tempo; depois, cada
 * programa pronto faz o 1º uso (`onFirstUse`: as posições dos uniforms, uma ida e
 * volta síncrona à GPU por uniform) também em fatias — sem isso o 1º quadro travava
 * até ~0,5 s, e cada sala nova travava de novo. No pré-carregamento (aba ainda
 * fechada), também as texturas sobem uma por fatia e um quadro invisível (o palco
 * escondido mede 1×1) faz a passada de sombras: abrir a aba só desenha.
 * Enquanto algum aquecimento corre (`busy`), o motor não desenha.
 */
export interface GpuWarmupHost {
  readonly renderer: RendererLike
  readonly scene: Scene
  readonly camera: Camera
  paused(): boolean
  disposed(): boolean
  /** O quadro invisível usou o tamanho do palco escondido: a volta remede. */
  sizeStale(): void
}

/** Teto de um aquecimento: contexto perdido no meio (o compileAsync não resolve) não segura os quadros para sempre. */
export const WARMUP_LIMIT_MS = 4000

export class GpuWarmup {
  /** Aquecimentos em curso. Começa em 1: o inicial (`begin`, no fim do construtor do motor) segura os quadros pedidos antes. */
  private running = 1
  private host: GpuWarmupHost | null = null

  /** `settled`: um aquecimento acabou (o motor pede o quadro). */
  constructor(private readonly settled: () => void) {}

  get busy(): boolean {
    return this.running > 0
  }

  /** O aquecimento inicial: a cena toda, já montada com o 1º feed (e, com a aba fechada, a GPU). */
  begin(host: GpuWarmupHost): void {
    this.host = host
    this.run([host.scene], true)
  }

  /** Roda o `sync` da cena e aquece o que ele acrescentou (a sala de um projeto novo) antes do quadro. */
  sync(run: () => void): void {
    const scene = this.host?.scene
    if (!scene) return run()
    const before = new Set(scene.children)
    run()
    const added = scene.children.filter((child) => !before.has(child))
    if (!added.length) return
    this.running++
    this.run(added, false)
  }

  private run(objects: Object3D[], initial: boolean): void {
    const host = this.host
    const done = (): void => {
      this.running--
      this.settled()
    }
    // Sem compileAsync (o renderer falso dos testes), desenha direto.
    if (!host?.renderer.compileAsync) return done()
    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<void>((resolve) => (timer = setTimeout(resolve, WARMUP_LIMIT_MS)))
    void Promise.race([warmGpu(host, objects, initial), limit]).finally(() => {
      clearTimeout(timer)
      done()
    })
  }
}

const yieldTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
/** Trabalho máximo por fatia (ms) antes de devolver a vez à tela. */
const SLICE_MS = 8

/** Fatias de tempo: `step` roda item a item e devolve a vez à tela a cada SLICE_MS (ou ao parar). */
async function sliced<T>(items: Iterable<T>, stop: () => boolean, step: (item: T) => void): Promise<boolean> {
  let start = performance.now()
  for (const item of items) {
    if (stop()) return false
    step(item)
    if (performance.now() - start < SLICE_MS) continue
    await yieldTask()
    start = performance.now()
  }
  return !stop()
}

/** O 1º uso de cada programa pronto (o que o quadro faria no `setProgram`). */
async function firstUse(host: GpuWarmupHost): Promise<void> {
  const ready = (host.renderer.info?.programs ?? []).filter((program) => program.isReady?.() !== false)
  await sliced(ready, () => host.disposed(), (program) => program.getUniforms?.())
}

function sceneTextures(scene: Scene): Set<Texture> {
  const seen = new Set<Texture>()
  scene.traverse((object) => {
    const material = (object as Object3D & { material?: Material | Material[] }).material
    for (const m of Array.isArray(material) ? material : material ? [material] : []) {
      for (const value of Object.values(m)) if ((value as Texture | null)?.isTexture) seen.add(value as Texture)
    }
  })
  return seen
}

/** Aba ainda fechada: as texturas e a passada de sombras saem antes do 1º quadro. A aba abriu no meio: o quadro sobe o resto. */
async function preloadGpu(host: GpuWarmupHost): Promise<void> {
  const closed = (): boolean => !host.paused() || host.disposed()
  const upload = host.renderer.initTexture?.bind(host.renderer)
  if (upload && !(await sliced(sceneTextures(host.scene), closed, upload))) return
  if (closed()) return
  try {
    host.renderer.render(host.scene, host.camera)
  } catch {
    /* o quadro de verdade tenta de novo */
  }
  host.sizeStale()
}

/**
 * Compila `objects` — no aquecimento inicial, peça por peça da cena (a parte síncrona do
 * compile monta o código de cada shader) —, faz o 1º uso dos programas e, com a aba
 * fechada no aquecimento inicial, pré-carrega a GPU. Nunca rejeita.
 */
async function warmGpu(host: GpuWarmupHost, objects: Object3D[], initial: boolean): Promise<void> {
  try {
    const pieces = initial ? objects.flatMap((object) => object.children) : objects
    const compiling: Array<Promise<unknown> | undefined> = []
    await sliced(pieces, () => host.disposed(), (piece) => compiling.push(host.renderer.compileAsync?.(piece, host.camera, host.scene)))
    await Promise.all(compiling)
    await firstUse(host)
    if (initial && host.paused()) await preloadGpu(host)
  } catch {
    /* sem aquecimento, o quadro compila no caminho, como antes */
  }
}
