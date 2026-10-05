/**
 * Modelos GLB dos agentes, um conjunto por cena (OfficeScene cria e libera):
 * o main lê resources/office-agents/<nome>.glb e devolve os bytes por IPC
 * (window.api.officeAgentFile; o file:// do app empacotado não serve ao
 * GLTFLoader), o renderer faz `GLTFLoader.parse` e agentRest.ts prepara o
 * esqueleto. Cada modelo carrega UMA vez, sob demanda, sem travar a entrada no
 * escritório: cada passo pesado (ambiente, texturas na GPU, shader compilado
 * em paralelo) na sua tarefa e no máximo SWAPS_PER_FRAME trocas de corpo por
 * quadro; enquanto carrega (ou se falhar — aviso no log) o agente segue com o
 * boneco atual. O ambiente do PBR vem ASSADO (ambiente.bin, o PMREM do
 * RoomEnvironment: gerá-lo no app recompilava os shaders do PMREM no 1º
 * desenho, ~380 ms de travada); é um só por cena, compartilhado pelos
 * materiais dos agentes e liberado aqui.
 *
 * Chave de teste (só DEV, agentPreview.ts): ligada, TODOS os agentes viram o
 * avatar v1 ("principal") com a roupa na cor da seed; desligada, nada muda.
 * `version` sobe quando a chave vira ou um modelo fica pronto: cada personagem
 * compara com o que aplicou e troca de corpo no próximo update.
 */
import {
  Color,
  CubeUVReflectionMapping,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  PerspectiveCamera,
  RGBAFormat,
  Texture,
  WebGLRenderer,
  type Scene
} from 'three'
import { GLTFLoader, type GLTFLoaderPlugin, type GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { AvatarBody } from './agentAvatar'
import { prepareAvatar, type AvatarTemplate } from './agentRest'
import type { RendererLike } from './engineTypes'

/** O renderer da cena (subir texturas e compilar o shader antes pedem um WebGLRenderer de verdade). */
export type AgentRenderer = RendererLike | null

/** O modelo da prova de conceito: o avatar v1. */
export const PREVIEW_MODEL = 'principal'
/** Trocas de corpo por quadro (cada uma clona um esqueleto): 30 agentes de uma vez travariam o quadro. */
export const SWAPS_PER_FRAME = 3
/** O ambiente do PBR já assado (scripts/office-agents/bake_env.mjs: PMREM do RoomEnvironment). */
export const ENV_FILE = 'ambiente.bin'

/** Devolve a vez ao navegador: cada passo pesado da carga fica na sua tarefa, nenhuma vira quadro longo. */
const yieldTask = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let preview = false
const listeners = new Set<() => void>()

/** A chave de teste está ligada? */
export function avatarPreview(): boolean {
  return preview
}

/** Liga/desliga a chave de teste; devolve o estado novo. */
export function setAvatarPreview(on: boolean): boolean {
  if (on !== preview) {
    preview = on
    for (const f of listeners) f()
  }
  return preview
}

type Fetch = (name: string) => Promise<Uint8Array | null>

/**
 * As imagens embutidas no GLB saem direto dos bytes (createImageBitmap de um
 * Blob), sem URL: o GLTFLoader faria `blob:` + fetch, e a CSP do app
 * (default-src/img-src sem blob:) recusa — em dev e no app empacotado.
 */
function bitmapImages(parser: GLTFParser): GLTFLoaderPlugin {
  const json = parser.json as { images: Array<{ bufferView?: number; mimeType?: string }> }
  const cache = new Map<number, Promise<Texture>>()
  const original = parser.loadImageSource.bind(parser)
  parser.loadImageSource = (index, loader) => {
    const src = json.images[index]
    if (src.bufferView === undefined) return original(index, loader)
    let p = cache.get(index)
    if (!p) {
      p = (parser.getDependency('bufferView', src.bufferView) as Promise<ArrayBuffer>)
        .then((buf) => createImageBitmap(new Blob([buf], { type: src.mimeType }), { premultiplyAlpha: 'none' }))
        .then((bmp) => {
          const t = new Texture(bmp)
          t.needsUpdate = true
          t.userData.mimeType = src.mimeType
          return t
        })
      cache.set(index, p)
      return p
    }
    return p.then((t) => t.clone())
  }
  return { name: 'agent_bitmap_images' }
}

const defaultFetch: Fetch = (name) =>
  typeof window !== 'undefined' && window.api?.officeAgentFile ? window.api.officeAgentFile(name) : Promise.resolve(null)

/**
 * O ambiente assado: "PMRM", largura e altura (uint32), depois RGBA HalfFloat
 * no layout CubeUV do PMREM do three (descomprimido; bake_env.mjs). Null se o
 * formato não bate. Puro (sem GPU): o material usa direto, sem PMREM no app.
 */
export function parseEnv(raw: Uint8Array): DataTexture | null {
  if (raw.length < 12 || String.fromCharCode(raw[0], raw[1], raw[2], raw[3]) !== 'PMRM') return null
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const w = view.getUint32(4, true)
  const h = view.getUint32(8, true)
  const bytes = w * h * 8
  if (!w || !h || raw.length !== 12 + bytes) return null
  const px = new Uint16Array(raw.slice(12).buffer)
  const t = new DataTexture(px, w, h, RGBAFormat, HalfFloatType)
  t.mapping = CubeUVReflectionMapping
  t.magFilter = t.minFilter = LinearFilter
  t.generateMipmaps = false
  t.colorSpace = LinearSRGBColorSpace
  t.needsUpdate = true
  return t
}

async function gunzip(gz: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export class AgentModels {
  /** Sobe a cada mudança (chave, modelo pronto): o personagem refaz o corpo quando difere do dele. */
  version = 0
  /** Quanto durou cada passo da última carga (ms; o HUD/harness de desempenho lê). */
  readonly timings: Record<string, number> = {}
  private readonly ready = new Map<string, AvatarTemplate>()
  private readonly loading = new Set<string>()
  private readonly failed = new Set<string>()
  private env: DataTexture | null = null
  /** Um avatar fora da cena que segura o programa do shader já compilado (sem ele o three o liberaria). */
  private readonly warm: AvatarBody[] = []
  private disposed = false
  private readonly off: () => void
  private lap: (k: string) => void = () => {}
  private windowAt = -1
  private used = 0
  private retry = false

  constructor(
    private readonly renderer: AgentRenderer,
    private readonly onChange: () => void,
    /** A cena do escritório: o shader do avatar compila com as luzes e a névoa dela. */
    private readonly target: Scene | null = null,
    private readonly fetch: Fetch = defaultFetch
  ) {
    const f = (): void => this.bump()
    listeners.add(f)
    this.off = () => listeners.delete(f)
  }

  private bump(): void {
    this.version++
    this.onChange()
  }

  /** Uma troca de corpo neste quadro? Até SWAPS_PER_FRAME; sem vaga, pede outro quadro (os que faltam trocam nele). */
  claim(): boolean {
    const now = performance.now()
    if (now - this.windowAt > 8) {
      this.windowAt = now
      this.used = 0
    }
    if (this.used < SWAPS_PER_FRAME) {
      this.used++
      return true
    }
    if (!this.retry) {
      this.retry = true
      setTimeout(() => {
        this.retry = false
        if (!this.disposed) this.onChange()
      }, 0)
    }
    return false
  }

  /** A chave de teste pelo motor (o harness do app empacotado, sem o atalho de DEV). */
  setPreview(on: boolean): boolean {
    return setAvatarPreview(on)
  }

  /** O modelo que o agente usa agora (null = o boneco): só com a chave ligada e o GLB pronto. Pede a carga se faltar. */
  modelFor(_role: string): AvatarTemplate | null {
    if (!preview) return null
    return this.template(PREVIEW_MODEL)
  }

  /** O modelo `name`, se já está pronto; senão começa a carregar (uma vez) e devolve null. */
  template(name: string): AvatarTemplate | null {
    const t = this.ready.get(name)
    if (t || this.disposed || this.failed.has(name) || this.loading.has(name)) return t ?? null
    this.loading.add(name)
    void this.load(name)
    return null
  }

  private async load(name: string): Promise<void> {
    let at = performance.now()
    const lap = (k: string): void => {
      const now = performance.now()
      this.timings[k] = Math.round(now - at)
      at = now
    }
    this.lap = lap
    try {
      const bytes = await this.fetch(`${name}.glb`)
      lap('ipc')
      if (!bytes) throw new Error('arquivo não encontrado')
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      const gltf = await new GLTFLoader().register(bitmapImages).parseAsync(buffer, '')
      lap('parse')
      await yieldTask()
      if (this.disposed) return
      at = performance.now()
      const t = prepareAvatar(gltf.scene)
      lap('prepare')
      if (typeof t === 'string') throw new Error(t)
      await this.upload(t)
      if (this.disposed) return
      this.ready.set(name, t)
      this.bump()
    } catch (e) {
      this.failed.add(name)
      console.warn(`[escritório] modelo do agente "${name}" não carregou; fica o boneco:`, e instanceof Error ? e.message : e)
    } finally {
      this.loading.delete(name)
    }
  }

  /**
   * Antes do 1º agente usar o modelo, cada coisa pesada no seu passo: o
   * ambiente do PBR, as texturas na GPU e o shader compilado em paralelo
   * (compileAsync), com as luzes da cena. Sem isso o quadro da troca travava.
   */
  private async upload(t: AvatarTemplate): Promise<void> {
    const r = this.renderer
    if (!(r instanceof WebGLRenderer)) return
    const lap = this.lap
    await yieldTask()
    lap('-')
    const env = await this.loadEnv()
    if (env) r.initTexture(env)
    lap('env')
    const body = new AvatarBody(t, new Color(0x808080), env, '')
    this.warm.push(body)
    lap('clone')
    const m = body.material
    for (const [k, tex] of [['map', m.map], ['normal', m.normalMap], ['mr', m.roughnessMap]] as const) {
      if (!tex) continue
      await yieldTask()
      lap('-')
      r.initTexture(tex)
      lap(`tex:${k}`)
    }
    await yieldTask()
    lap('-')
    const done = r.compileAsync(body.root, new PerspectiveCamera(), this.target ?? undefined)
    lap('compileSync')
    await done
    lap('compileWait')
  }

  /** O ambiente do PBR dos agentes (um por cena; null antes de carregar, sem o arquivo ou nos testes). */
  envMap(): Texture | null {
    return this.env
  }

  /** O ambiente assado (ambiente.bin): sem ele o avatar fica só com as luzes da cena (aviso no log). */
  private async loadEnv(): Promise<DataTexture | null> {
    if (this.env) return this.env
    try {
      const gz = await this.fetch(ENV_FILE)
      this.env = gz ? parseEnv(await gunzip(gz)) : null
      if (!this.env) throw new Error(gz ? 'formato inválido' : 'arquivo não encontrado')
    } catch (e) {
      console.warn(`[escritório] ambiente dos agentes (${ENV_FILE}) não carregou; sem reflexo:`, e instanceof Error ? e.message : e)
    }
    return this.env
  }

  dispose(): void {
    this.disposed = true
    this.off()
    for (const b of this.warm.splice(0)) b.dispose()
    this.env?.dispose()
    this.env = null
    for (const t of this.ready.values()) {
      t.root.traverse((o) => {
        const m = o as { geometry?: { dispose(): void }; material?: { dispose(): void } & Record<string, unknown> }
        m.geometry?.dispose()
        if (!m.material) return
        for (const v of Object.values(m.material)) if (v && typeof v === 'object' && (v as Texture).isTexture) (v as Texture).dispose()
        m.material.dispose()
      })
    }
    this.ready.clear()
  }
}
