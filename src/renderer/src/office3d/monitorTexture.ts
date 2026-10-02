/**
 * Tela do monitor vista à distância: o CHAT ENCOLHIDO do turno atual do dono —
 * o pedido em balão, a narração em itálico, a resposta e cada ferramenta como a
 * linha recolhida do cartão do chat (chatPaint.ts) —, numa CanvasTexture.
 *
 * O conteúdo vem de chatPageFor (chatPage.ts), com os rótulos do próprio chat
 * (toolDescribe). `draw` só redesenha quando a página (ou a cor da sala) muda:
 * não há custo por quadro. `scale` < 1 é a mesma tela num canvas menor (LOD médio).
 */
import { CanvasTexture, SRGBColorSpace } from 'three'
import type { ChatPage } from './chatPage'
import { paintChat } from './chatPaint'
import { canvas2d } from './textures'

/** O que a tela acesa mostra (decor.ts guarda; screens.ts decide). */
export type ScreenPage = ChatPage

export const MON_W = 512
export const MON_H = 288

export interface MonitorTexture {
  texture: CanvasTexture
  /** Fração de MON_W×MON_H do canvas (1 perto; 0,5 no LOD médio). */
  scale: number
  /** Redesenha só quando a página muda; true se redesenhou. */
  draw(page: ScreenPage, accent: string): boolean
}

/** Assinatura da página: igual → a textura já mostra isto. */
export function pageSig(page: ScreenPage, accent: string): string {
  return `${accent}|${JSON.stringify(page)}`
}

/** `scale` < 1: canvas menor (o desenho é o mesmo, em escala) — a tela vista de média distância. */
export function createMonitorTexture(anisotropy = 1, scale = 1): MonitorTexture {
  const { canvas, ctx } = canvas2d(Math.round(MON_W * scale), Math.round(MON_H * scale))
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = anisotropy
  let last = ''
  return {
    texture,
    scale,
    draw(page, accent) {
      const sig = pageSig(page, accent)
      if (sig === last) return false
      last = sig
      if (!ctx) return true
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      paintChat(ctx, page, accent, MON_W, MON_H)
      texture.needsUpdate = true
      return true
    }
  }
}
