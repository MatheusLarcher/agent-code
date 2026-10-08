/**
 * A cor do projeto no escritório (etapa "cor-do-projeto"): a camisa de todo
 * agente com projeto (o avatar GLB e o boneco — agentBody.ts `setShirtColor`) e
 * a placa do chão da ilha do projeto (sign.ts), o filtro e as abas do quadro, o
 * alfinete do papel e os pontos 2D do agente (`agentCss`: chat, prévia, monitor,
 * Memórias). Fora do escritório, a Central e a lateral usam a mesma cor
 * (central/centralRecents.ts `labelFor`). A plaquinha da mesa e a tela do
 * monitor ficam num tom neutro fixo (sign.ts `NEUTRAL`, screens.ts `SCREEN_ACCENT`):
 * nada colado no agente brilha com a cor.
 *
 * De onde vem: a detectada e fixa no PC (`feed.projectColors`, por cwd — main/
 * projectColor*.ts); enquanto ela não chega (ou falhou), a reserva do próprio
 * projeto (`reserveProjectColor` pelo id da sala). NUNCA por conversa. O Sandbox
 * é uma cor só. A Central não é projeto: a camisa dela fica como está (`null`).
 * O helper mora em office/adapter/model.ts (o modelo já leva a cor de cada sala).
 */
import { projectColorHex, type ProjectColorFeed } from '../office/adapter/model'
import { seedCss } from './appearance'

export { projectColorHex, type ProjectColorFeed }

/** A camisa (hex) de um personagem: a cor do projeto dele; null = sem projeto (a Central fica como está). */
export function shirtHex(feed: ProjectColorFeed, projectId: string | null | undefined): string | null {
  return projectId ? projectColorHex(feed, projectId) : null
}

/**
 * A cor (CSS) do agente nos pontos 2D do escritório (o ponto do chat, o
 * cabeçalho da prévia e do monitor, Memórias): a da camisa — a do projeto
 * (sala ou cwd); sem projeto, a da seed, como a camisa da Central.
 */
export function agentCss(feed: ProjectColorFeed, project: string | null | undefined, seed: string): string {
  return shirtHex(feed, project) ?? seedCss(seed)
}
