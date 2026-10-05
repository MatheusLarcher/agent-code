import type { AgentModels } from './agentModels'
import type { Particles } from './particles'

/** Contexto do quadro, um só para todos os personagens (a cena preenche antes dos updates). */
export interface FrameCtx {
  /** Relógio (s). */
  t: number
  camX: number
  camY: number
  camZ: number
  particles: Particles | null
  /** Os modelos GLB dos agentes (agentModels.ts); sem eles, todos ficam com o boneco. */
  models?: AgentModels | null
}
