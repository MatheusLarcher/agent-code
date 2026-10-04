/**
 * Materiais COMPARTILHADOS dos kanbans (todas as salas): a malha do MÉDIO/LONGE
 * (só a cor de cada papel, por vértice), os realces do hover/arrasto e as peças
 * em volta (fundo, bloquinho, cesto). A textura de cada sala é da sala
 * (boardView.ts). Criados uma vez pela cena e liberados juntos.
 */
import { AdditiveBlending, MeshBasicMaterial, MeshLambertMaterial } from 'three'

export function createBoardKit() {
  const mat = {
    mid: new MeshLambertMaterial({ color: 0xffffff, vertexColors: true }),
    glow: new MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.55, depthWrite: false, blending: AdditiveBlending }),
    shadow: new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }),
    column: new MeshBasicMaterial({ color: 0xfff1b8, transparent: true, opacity: 0.35, depthWrite: false }),
    backing: new MeshLambertMaterial({ color: 0xd8c9a8 }),
    padTop: new MeshLambertMaterial({ color: 0xfff27a }),
    bin: new MeshLambertMaterial({ color: 0x6d7f95 })
  }
  return {
    mat,
    dispose(): void {
      for (const m of Object.values(mat)) m.dispose()
    }
  }
}

export type BoardKit = ReturnType<typeof createBoardKit>
