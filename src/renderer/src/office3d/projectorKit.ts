/**
 * Medidas da imagem da TV da sala de reunião (o antigo projetor): a página
 * 16:9 (projectorPaint.ts) fica centrada na tela ~2:1 da TV, com faixas
 * pretas nos lados. Recursos COMPARTILHADOS: nenhum por enquanto (cada TV tem a
 * própria textura); o kit continua existindo para quem já o cria e libera.
 */
import { MEETING } from './officePlan'

/** A imagem (16:9) dentro da tela da TV. */
export const IMG_H = MEETING.tv.h - 0.02
export const IMG_W = (IMG_H * 16) / 9
export const IMG_Y = MEETING.tv.y

export function createProjectorKit() {
  return {
    dispose(): void {}
  }
}

export type ProjectorKit = ReturnType<typeof createProjectorKit>
