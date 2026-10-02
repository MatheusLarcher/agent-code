/**
 * Telas dos monitores por nível de detalhe. A cena diz o QUE cada tela mostra
 * (`setScreen`: apagada, protetor ou acesa com a página e o status do dono) e
 * `showScreen` aplica conforme a sala:
 *   fora da tela  nada (nem desenha): a página fica guardada para a volta;
 *   sem energia   preta (apagão na sala): a página fica guardada e volta com a luz;
 *   PERTO         textura na resolução cheia;
 *   MÉDIO         textura em meia resolução (trocar de nível troca a textura);
 *   LONGE         sem textura: um bloco emissivo na cor do status do dono.
 * `MonitorTexture.draw` só redesenha quando a página muda.
 */
import { MeshBasicMaterial } from 'three'
import { currentTool, screenModel } from '../components/office/screenContent'
import type { LookupInfo } from '../office/adapter/director'
import type { OfficeFeed } from '../office/adapter/feed'
import type { OfficeCharacterModel } from '../office/adapter/model'
import { modelPhase, type LifeInput } from './crowd'
import { disposeScreenOn, type ScreenView } from './decor'
import type { AgentPhase } from './events'
import type { Kit, ScreenStatus } from './kit'
import type { Lod } from './lod'
import { createMonitorTexture, screenLines, type ScreenPage } from './monitorTexture'

/** Resolução da textura da tela por nível (o LONGE não tem textura). */
export const SCREEN_SCALE: Readonly<Record<Lod, number>> = { 0: 1, 1: 0.5, 2: 0 }

const STATUS: Record<AgentPhase, ScreenStatus> = {
  working: 'working',
  'waiting-permission': 'permission',
  error: 'error',
  done: 'done',
  idle: 'idle'
}

/** Página da tela para um personagem ativo: a ferramenta atual ou, sem ela, o rótulo. */
export function screenPageFor(feed: OfficeFeed | null, model: OfficeCharacterModel): ScreenPage {
  const info: LookupInfo = { key: model.key, convId: model.convId, role: model.role, trackId: model.trackId }
  const page = screenLines(screenModel(currentTool(feed, info)))
  if (page.lines.length > 0 || page.title) return page
  const title = model.activity === 'read' ? 'lendo' : model.activity === 'type' ? 'escrevendo' : 'trabalhando'
  return { title, subtitle: '', lines: model.label ? [{ kind: 'meta', text: model.label.slice(0, 58) }] : [] }
}

/** Cor do monitor do dono vista de LONGE: a fase do retrato de events.ts (ou, sem ele, a do modelo). */
export function screenStatus(owner: OfficeCharacterModel, life: LifeInput | null): ScreenStatus {
  return STATUS[life?.snapshot.agents.get(owner.key)?.phase ?? modelPhase(owner)]
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
