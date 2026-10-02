/**
 * Telas dos monitores por nível de detalhe. A cena diz o QUE cada tela mostra
 * (`setScreen`: apagada, protetor ou acesa com a página e o status do dono) e
 * `showScreen` aplica conforme a sala:
 *   fora da tela  nada (nem desenha): a página fica guardada para a volta;
 *   PERTO         textura na resolução cheia;
 *   MÉDIO         textura em meia resolução (trocar de nível troca a textura);
 *   LONGE         sem textura: um bloco emissivo na cor do status do dono.
 * `MonitorTexture.draw` só redesenha quando a página muda.
 */
import { MeshBasicMaterial } from 'three'
import type { OfficeCharacterModel } from '../office/adapter/model'
import { modelPhase, type LifeInput } from './crowd'
import { disposeScreenOn, type ScreenView } from './decor'
import type { AgentPhase } from './events'
import type { Kit, ScreenStatus } from './kit'
import type { Lod } from './lod'
import { createMonitorTexture, type ScreenPage } from './monitorTexture'

/** Resolução da textura da tela por nível (o LONGE não tem textura). */
export const SCREEN_SCALE: Readonly<Record<Lod, number>> = { 0: 1, 1: 0.5, 2: 0 }

const STATUS: Record<AgentPhase, ScreenStatus> = {
  working: 'working',
  'waiting-permission': 'permission',
  error: 'error',
  done: 'done',
  idle: 'idle'
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

/** Aplica a tela no nível da sala; com a sala fora da tela não faz nada (a próxima chamada visível aplica). */
export function showScreen(s: ScreenView, kit: Kit, level: Lod, visible: boolean): void {
  if (!visible) return
  if (s.state === 'off' || s.state === 'saver' || level === 2) {
    disposeScreenOn(s)
    s.mesh.material = s.state === 'off' ? kit.mat.screenOff : level === 2 ? kit.mat.status[s.state === 'saver' ? 'idle' : s.status] : kit.mat.screensaver
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
