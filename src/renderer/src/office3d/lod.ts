/**
 * Nível de detalhe (LOD) do Escritório 3D — PURO (sem three). Três níveis pela
 * distância da câmera até a caixa da sala (ou até o personagem do corredor):
 *   0 PERTO  tudo;
 *   1 MÉDIO  sem as malhas userData.lod = 'detail', personagem com lod 1, tela
 *            do monitor em meia resolução e sombra só dos móveis grandes;
 *   2 LONGE  sem props e decoração pequena (userData.lod = 'small'), personagem
 *            com lod 2 (pose a ~10 Hz), tela vira um bloco na cor do status,
 *            sem shadow map, resolução menor e névoa.
 * Histerese: para mudar de nível a distância precisa passar da fronteira por
 * uma folga (LOD_SLACK) — parada perto da fronteira, a câmera não faz piscar.
 */
export type Lod = 0 | 1 | 2

/** Fronteiras (m): PERTO|MÉDIO e MÉDIO|LONGE. */
export const LOD_BOUNDS: readonly [number, number] = [12, 40]
/**
 * Fronteiras dos PERSONAGENS: no escritório único todos dividem a mesma sala,
 * então de perto de uma ilha os das outras ficam à vista — além de ~9 m os
 * detalhes do rosto e dos dedos já não aparecem e saem antes.
 */
export const CHAR_LOD_BOUNDS: readonly [number, number] = [9, 40]
/** Folga da histerese, em fração da fronteira (afasta até b·(1+f), volta só abaixo de b·(1−f)). */
export const LOD_SLACK = 0.1

/** LONGE: pixelRatio × isto (o "embaçado"). */
export const FAR_PIXEL_SCALE = 0.7
/** LONGE: a pose do personagem é refeita a cada FAR_POSE_S (~10 Hz). */
export const FAR_POSE_S = 0.1
/** Só animação de baixa prioridade (personagens LONGE): no máximo ~30 quadros/s. */
export const LOW_RATE_MS = 1000 / 30
/** LONGE: a névoa começa e fecha nestes múltiplos da distância da câmera ao alvo. */
export const FOG_NEAR = 0.75
export const FOG_FAR = 2.4

/**
 * Nível para `distance` (m). `prev` = nível atual (null na 1ª vez: sem
 * histerese). Fica em `prev` enquanto a distância estiver dentro da folga de
 * uma fronteira; fora dela, vai para o nível certo (pode pular dois de uma vez).
 */
export function lodLevel(distance: number, prev: Lod | null = null, bounds: readonly [number, number] = LOD_BOUNDS): Lod {
  if (Number.isNaN(distance)) return prev ?? 0
  let away = 0
  let back = 0
  let plain = 0
  for (let i = 0; i < bounds.length; i++) {
    const b = bounds[i]
    if (distance > b * (1 + LOD_SLACK)) away++
    if (distance >= b * (1 - LOD_SLACK)) back++
    if (distance >= b) plain++
  }
  if (prev === null) return plain as Lod
  return Math.min(Math.max(prev, away), back) as Lod
}
