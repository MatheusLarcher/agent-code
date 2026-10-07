/**
 * A cor do projeto no escritório (etapa "cor-do-projeto"): vai SÓ na camisa de
 * todo agente com projeto (o avatar GLB e o boneco — agentBody.ts
 * `setShirtColor`). Nada em volta do agente muda de cor por causa do projeto: as
 * placas, a plaquinha da mesa e a tela do monitor ficam num tom neutro fixo
 * (sign.ts `NEUTRAL`, screens.ts `SCREEN_ACCENT`), e os pontos 2D (chat, Memórias,
 * alfinete do quadro) continuam como eram.
 *
 * De onde vem: a detectada e fixa no PC (`feed.projectColors`, por cwd — main/
 * projectColor*.ts); enquanto ela não chega (ou falhou), a reserva do próprio
 * projeto (`reserveProjectColor` pelo id da sala). NUNCA por conversa. O Sandbox
 * é uma cor só. A Central não é projeto: a camisa dela fica como está (`null`).
 */
import { isProjectColor, reserveProjectColor, SANDBOX_PROJECT_COLOR, type ProjectColorMap } from '@shared/projectColor'
import { roomIdFor, SANDBOX_ROOM_ID } from '../office/adapter/model'

/** O que o helper lê do feed (o OfficeFeed inteiro serve; null = sem feed ainda). */
export type ProjectColorFeed = { readonly projectColors?: Readonly<ProjectColorMap> } | null | undefined

/** Por mapa do feed: id da sala → hex (só as cores válidas). */
const byRoom = new WeakMap<object, Map<string, string>>()

function roomColors(colors: Readonly<ProjectColorMap>): Map<string, string> {
  let m = byRoom.get(colors)
  if (m) return m
  m = new Map()
  for (const [cwd, c] of Object.entries(colors)) if (cwd && isProjectColor(c)) m.set(roomIdFor(cwd), c.hex)
  byRoom.set(colors, m)
  return m
}

/**
 * A cor do projeto (`#rrggbb`) pelo id da sala ou pelo cwd (os dois servem: o
 * id é o cwd normalizado): a detectada, senão a reserva do projeto.
 */
export function projectColorHex(feed: ProjectColorFeed, project: string): string {
  const id = roomIdFor(project)
  if (id === SANDBOX_ROOM_ID) return SANDBOX_PROJECT_COLOR.hex
  const colors = feed?.projectColors
  return (colors && roomColors(colors).get(id)) || reserveProjectColor(id)
}

/** A camisa (hex) de um personagem: a cor do projeto dele; null = sem projeto (a Central fica como está). */
export function shirtHex(feed: ProjectColorFeed, projectId: string | null | undefined): string | null {
  return projectId ? projectColorHex(feed, projectId) : null
}
