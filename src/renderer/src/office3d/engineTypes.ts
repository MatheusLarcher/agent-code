/**
 * Contratos do motor do Escritório 3D (engine.ts): o renderer (o real e o
 * falso dos testes), a fonte do feed, as opções injetáveis, os callbacks e o
 * `listener` dos eventos de DOM (cada um já com a remoção guardada para o dispose).
 */
import { PCFShadowMap, WebGLRenderer, type Camera, type Scene } from 'three'
import type { BoardItemStatus } from '@shared/ipc'
import type { OfficeFeed } from '../office/adapter/feed'
import type { BoardApi } from './board/boardSync'
import type { BrowserFeedApi } from './browserFrames'
import type { ProjectLayout } from './layout'
import type { OfficePower } from './power'

export interface RendererLike {
  setPixelRatio(ratio: number): void
  setSize(width: number, height: number, updateStyle?: boolean): void
  render(scene: Scene, camera: Camera): void
  dispose(): void
  /** WebGLRenderer real: anisotropia máxima para placas e telas nítidas. */
  capabilities?: { getMaxAnisotropy(): number }
  /** WebGLRenderer real: shadow map refeito só quando o motor pede (autoUpdate desligado). */
  shadowMap?: { autoUpdate: boolean; needsUpdate: boolean }
  /** WebGLRenderer real: contadores do último quadro (HUD de desempenho). */
  info?: { render: { calls: number; triangles: number } }
}

/** Renderer padrão: antialias e sombras suaves (só a luz principal projeta), refeitas sob demanda. */
export function createDefaultRenderer(canvas: HTMLCanvasElement): RendererLike {
  const r = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
  r.shadowMap.enabled = true
  r.shadowMap.type = PCFShadowMap
  r.shadowMap.autoUpdate = false
  r.shadowMap.needsUpdate = true
  return r
}

/** Chave de pick da tela do projetor de uma sala: `${PROJECTOR_KEY}${roomId}`. */
export const PROJECTOR_KEY = 'projector:'
/** Chave de pick da estante de Memórias: o clique abre o painel de Memórias (o foco nela). */
export const MEMORY_SHELF_KEY = 'memory-shelf'

export interface FeedSource {
  getSnapshot(): OfficeFeed | null
  subscribe(cb: (feed: OfficeFeed) => void): () => void
}

export interface EngineOptions {
  createRenderer?: (canvas: HTMLCanvasElement) => RendererLike
  raf?: (cb: FrameRequestCallback) => number
  caf?: (id: number) => void
  now?: () => number
  source?: FeedSource
  /** Quadros e estado do navegador embutido (padrão: o window.api do app; null = sem quadros). */
  browser?: BrowserFeedApi | null
  /** O Quadro real (padrão: o window.api do app; null = sem quadro nas salas). */
  board?: BoardApi | null
}

/** O que abrir no clique no kanban: o cartão grande ou a lista da coluna (x/y = ponto do clique na janela, se houve). */
export type BoardOpen =
  | { kind: 'card'; id: string; x: number | null; y: number | null }
  | { kind: 'pile'; roomId: string; status: BoardItemStatus; x: number | null; y: number | null }

export interface EngineCallbacks {
  /**
   * Personagem enquadrado (tela aberta) ou null ao fechar. `byUser`: foi o
   * usuário — clique no agente ou no balão, clique no vazio, Esc, × da tela,
   * girar/arrastar/zoom/WASD; false quando o motor fecha sozinho (flyToAgent,
   * follow, o focado que saiu do escritório).
   */
  onFocus(key: string | null, byUser: boolean): void
  /** Duplo clique no personagem. */
  onOpen(convId: string): void
  /** Clique no balão de um pedido (permissão, pergunta): leva ao pedido da conversa. Sem ele, o balão foca o agente. */
  onFocusRequest?(convId: string): void
  /** A energia do escritório mudou (%, nível ou hora do reset); null sem a janela de 5h. */
  onPower?(power: OfficePower | null): void
  /** O que está sob o mouse mudou (personagem, 'projector:<sala>' ou null): a prévia do agente. */
  onHover?(key: string | null): void
  /** Clique num papel ou na pilha do kanban de uma sala (ou `engine.board.open`). */
  onBoardOpen?(open: BoardOpen): void
  /** Os dados do Quadro real mudaram (a janela do cartão acompanha). */
  onBoardChange?(): void
  /** Os projetos no escritório (o filtro do HUD) ou o filtro em vigor mudaram (null = Todos). */
  onProjects?(projects: readonly ProjectLayout[], filter: string | null): void
}

/** addEventListener tipado por alvo (janela, elemento, documento). */
export interface Listen {
  <K extends keyof WindowEventMap>(target: Window, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions): void
  <K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions): void
  <K extends keyof DocumentEventMap>(target: Document, type: K, fn: (e: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions): void
}

/** Liga ouvintes guardando cada remoção em `cleanups` (o dispose do motor chama todas). */
export function listener(cleanups: Array<() => void>): Listen {
  return ((target: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions): void => {
    target.addEventListener(type, fn, opts)
    cleanups.push(() => target.removeEventListener(type, fn, opts))
  }) as Listen
}
