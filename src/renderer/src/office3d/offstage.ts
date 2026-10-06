/**
 * Fora de cena — a sala de reunião é só para planejamento aberto. Com o plano
 * enviado para implementação, o Agent Manager sai da cabeceira da mesa de
 * reunião: o corpo dele vai para o PC, no agente da 1ª conversa de
 * implementação (que já nasce com a aparência dele — office/adapter/model.ts,
 * planHandoffs). O Manager continua no escritório para a TV (o plano dele segue
 * nas abas dela), só que lá fora e invisível, como quem o filtro de projeto põe
 * para fora. PURO (sem three).
 *
 * A troca é na mesma passagem do feed: o Manager some sem andar até a porta e o
 * herdeiro nasce sentado no lugar dele, levanta e vai para a própria mesa —
 * para quem olha, é o mesmo agente saindo da sala de reunião para trabalhar.
 */
import type { Brain } from './brainBody'

/** Fora de cena desde quando (relógio do crowd); -Infinity = já nasceu fora (não deixou corpo). */
const leftAt = new WeakMap<Brain, number>()

export function isOffstage(b: Brain): boolean {
  return leftAt.has(b)
}

/**
 * Acerta `outside` e a marca de fora de cena. Quem estava à vista some na hora;
 * `from` (só ao nascer): o personagem cujo corpo este herda, se ele estava em
 * cena até esta passagem.
 */
export function onStage(b: Brain, outside: boolean, offstage: boolean, t: number, from?: Brain): void {
  b.outside = outside
  if (!offstage) leftAt.delete(b)
  else if (!leftAt.has(b)) {
    leftAt.set(b, b.visible ? t : -Infinity)
    b.visible = false
  }
  if (from) takeBody(b, from, t)
}

/** O herdeiro continua de onde o outro estava (sentado continua sentado: o passo o levanta). */
function takeBody(b: Brain, from: Brain, t: number): void {
  if (!(from.visible && !from.outside) && leftAt.get(from) !== t) return
  Object.assign(b, {
    x: from.x,
    z: from.z,
    yaw: from.yaw,
    sit: from.sit,
    seat: from.seat,
    seatX: from.seatX,
    seatZ: from.seatZ,
    standX: from.standX,
    standZ: from.standZ,
    speed: 0,
    pathLen: 0,
    planned: -1,
    atSpot: false,
    arrived: false
  })
  // Vindo da sala de reunião: o próximo modo (trabalho ou livre) o manda para a própria mesa.
  b.mode = 'meeting'
}
