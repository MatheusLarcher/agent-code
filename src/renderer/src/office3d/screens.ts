/**
 * Telas dos monitores por nível de detalhe. A cena diz o QUE cada tela mostra
 * (`setScreen`: apagada, protetor ou acesa com o VS Code do dono e o
 * status dele) e `showScreen` aplica conforme a sala:
 *   fora da tela  nada (nem desenha): a página fica guardada para a volta;
 *   sem energia   preta (apagão na sala): a página fica guardada e volta com a luz;
 *   PERTO         textura na resolução cheia;
 *   MÉDIO         textura em meia resolução (trocar de nível troca a textura);
 *   LONGE         sem textura: um bloco emissivo na cor do status do dono.
 * `MonitorTexture.draw` só redesenha quando a página muda, e a página acesa
 * troca no máximo a cada 5 s com a última sempre aparecendo (monitorThrottle.ts).
 */
import { MeshBasicMaterial } from 'three'
import type { OfficeFeed } from '../office/adapter/feed'
import type { OfficeCharacterModel } from '../office/adapter/model'
import { chatPageFor } from './chatPage'
import { codePageFor } from './codePage'
import { modelPhase, type LifeInput } from './crowd'
import { disposeScreenOn, type RoomView, type ScreenView } from './decor'
import type { AgentPhase } from './events'
import type { Kit, ScreenStatus } from './kit'
import type { Office3DLayout, RoomLayout } from './layout'
import type { ZoneId } from './officePlan'
import type { Lod } from './lod'
import { paperStep } from './paperPile'
import { createMonitorTexture, type ScreenPage } from './monitorTexture'
import { createSwapThrottle, type SwapThrottle } from './monitorThrottle'
import { accentHue } from './sign'

/** O destaque das telas das mesas: um tom neutro fixo, igual para todo projeto (nada em volta do agente pega a cor do projeto). */
export const SCREEN_ACCENT = 'hsl(210 12% 64%)'

/** Resolução da textura da tela por nível (o LONGE não tem textura). */
export const SCREEN_SCALE: Readonly<Record<Lod, number>> = { 0: 1, 1: 0.5, 2: 0 }

const noop = (): void => {}

const STATUS: Record<AgentPhase, ScreenStatus> = {
  working: 'working',
  'waiting-permission': 'permission',
  error: 'error',
  done: 'done',
  idle: 'idle'
}

/** Página da tela para um personagem ativo: a janela do VS Code com o que ele escreveu (e o chat encolhido do turno, para a prévia). */
export function screenPageFor(feed: OfficeFeed | null, model: OfficeCharacterModel): ScreenPage {
  return { ...chatPageFor(feed, model), code: codePageFor(feed, model) }
}

/** Cor do monitor do dono vista de LONGE: a fase do retrato de events.ts (ou, sem ele, a do modelo). */
export function screenStatus(owner: OfficeCharacterModel, life: LifeInput | null): ScreenStatus {
  return STATUS[life?.snapshot.agents.get(owner.key)?.phase ?? modelPhase(owner)]
}

/**
 * As telas do escritório no feed: a de cada mesa com o dono dela (acesa, protetor
 * ou apagada; a cor de destaque é neutra, SCREEN_ACCENT), a do console com a Central e a
 * pilha de papéis de cada mesa (o contexto usado do dono). Zona fora da tela só
 * guarda a página (`viewOn` e o culling dela); zona sem energia (`darkOf`), tela preta. Quem tem a
 * tela acesa com luz entra em `lit` (o rosto brilha). `onDirty` pede um quadro
 * quando a troca atrasada pela cadência de 5 s redesenha uma tela.
 */
export function syncRoomScreens(view: RoomView, r: RoomLayout, layout: Office3DLayout, kit: Kit, feed: OfficeFeed | null, life: LifeInput | null, darkOf: (zone: ZoneId) => boolean, viewOn: boolean, lit: Set<string>, onDirty: () => void = noop): void {
  const shown = (s: ScreenView): boolean => !s.lod.culled && (s.lod.placed || !viewOn)
  const byKey = new Map(layout.characters.map((c) => [c.key, c.model]))
  r.desks.forEach((desk, i) => {
    const s = view.screens[i]
    const owner = desk.ownerKey ? byKey.get(desk.ownerKey) : undefined
    if (fillScreen(s, kit, owner, desk.projectId ?? r.id, feed, life, darkOf(s.zone), shown(s), false, onDirty) && owner) lit.add(owner.key)
    view.piles.set(i, paperStep(owner?.context))
  })
  // O console é o monitor da Central (o personagem dela, se está no escritório).
  const central = layout.characters.find((c) => c.spot === 'central')?.model
  if (fillScreen(view.consoleScreen, kit, central, 'central', feed, life, darkOf('plaza'), shown(view.consoleScreen), true, onDirty) && central) lit.add(central.key)
}

/**
 * O que uma tela mostra: acesa com a página do dono ativo, protetor com dono
 * parado, apagada sem dono — e aplica já se `shown`. `accentId`: o projeto
 * ('central' = o console, com o destaque de sempre; as mesas, o neutro); `awake`: com dono, sempre acesa (o console da Central
 * espelha o chat dela mesmo parada). Devolve se o rosto do dono brilha.
 */
export function fillScreen(s: ScreenView, kit: Kit, owner: OfficeCharacterModel | undefined, accentId: string, feed: OfficeFeed | null, life: LifeInput | null, dark: boolean, shown: boolean, awake = false, onDirty: () => void = noop): boolean {
  s.mesh.userData.charKey = owner?.key ?? null
  // Tom neutro fixo nas mesas (a cor do projeto fica só na camisa do agente); o console da Central fica como está.
  const accent = accentId === 'central' ? `hsl(${accentHue(accentId)} 70% 60%)` : SCREEN_ACCENT
  const on = !!owner && (owner.active || awake)
  if (owner && on) setScreen(s, 'on', pacedPage(s, owner.key, screenPageFor(feed, owner), onDirty), accent, screenStatus(owner, life))
  else {
    paced.get(s)?.throttle.reset()
    setScreen(s, owner ? 'saver' : 'off', null, accent, 'idle')
  }
  showScreen(s, kit, s.lod.level, shown, dark)
  return on && !dark
}

/** A cadência de cada tela (por dono): trocar de dono recomeça. */
const paced = new WeakMap<ScreenView, { owner: string; throttle: SwapThrottle<ScreenPage> }>()

/**
 * A página que a tela mostra agora: a nova no máximo a cada MONITOR_SWAP_MS; a
 * que chegou no meio do intervalo entra quando ele vence — redesenhada aí se a
 * tela está à vista e acesa (e pede um quadro com `onDirty`); senão fica em
 * `s.page` para o próximo showScreen.
 */
function pacedPage(s: ScreenView, owner: string, page: ScreenPage, onDirty: () => void): ScreenPage {
  let cur = paced.get(s)
  if (!cur || cur.owner !== owner) {
    cur?.throttle.reset()
    const throttle = createSwapThrottle<ScreenPage>((late) => {
      if (s.state !== 'on' || s.mesh.userData.charKey !== owner) return
      s.page = late
      if (s.on && !s.lod.culled && s.mesh.material === s.on.mat && s.on.mon.draw(late, s.accent)) onDirty()
    })
    cur = { owner, throttle }
    paced.set(s, cur)
  }
  return cur.throttle.offer(page, JSON.stringify(page))
}

export function setScreen(s: ScreenView, state: ScreenView['state'], page: ScreenPage | null, accent: string, status: ScreenStatus): void {
  s.state = state
  s.page = state === 'on' ? page : null
  s.accent = accent
  s.status = status
  s.mesh.userData.screen = state
}

/**
 * Aplica a tela no nível da sala; com a sala fora da tela não faz nada (a
 * próxima chamada visível aplica). `dark`: a sala está sem energia — tela preta.
 */
export function showScreen(s: ScreenView, kit: Kit, level: Lod, visible: boolean, dark = false): void {
  if (!visible) return
  if (dark || s.state === 'off' || s.state === 'saver' || level === 2) {
    disposeScreenOn(s)
    s.mesh.material = dark || s.state === 'off' ? kit.mat.screenOff : level === 2 ? kit.mat.status[s.state === 'saver' ? 'idle' : s.status] : kit.mat.screensaver
    return
  }
  const scale = SCREEN_SCALE[level]
  if (s.on && s.on.mon.scale !== scale) disposeScreenOn(s)
  if (!s.on) {
    const mon = createMonitorTexture(kit.anisotropy, scale)
    s.on = { mon, mat: new MeshBasicMaterial({ map: mon.texture }) }
  }
  s.mesh.material = s.on.mat
  if (s.page) s.on.mon.draw(s.page, s.accent)
}
