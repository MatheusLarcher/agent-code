/**
 * Singletons do escritório, fora do React: OfficeState + diretor + lazer +
 * arte + renderer. Vivem no módulo para o estado sobreviver à troca de aba —
 * desmontar o OfficePanel só para o laço de quadros; o diretor continua
 * recebendo o feed (sem tique) e, quando a aba volta, o motor já está em dia.
 */
import { composerPresence } from '../../composerPresence'
import { AnimDriver } from '../../office/adapter/animDriver'
import { OfficeDirector } from '../../office/adapter/director'
import { ReactionDriver } from '../../office/adapter/reactionDriver'
import { MeetingDriver } from '../../office/adapter/meetingDriver'
import type { OfficeFeed } from '../../office/adapter/feed'
import { deriveOfficeModel, type OfficeModel } from '../../office/adapter/model'
import { OfficeOverlays } from '../../office/adapter/overlays'
import { createOfficeArt, PALETTE, type OfficePalette } from '../../office/art'
import { FurnitureSprites, variantFor } from '../../office/art/furniture'
import { installLeisure, type Leisure } from '../../office/behavior/leisure'
import { OfficeRenderer, OfficeState, type OfficeArt } from '../../office/engine'
import { buildBuilding } from '../../office/layout'
import { officeStore } from '../../office/officeStore'

export interface OfficeRuntime {
  state: OfficeState
  director: OfficeDirector
  leisure: Leisure
  /** Reunião (F3·2): ida/volta do principal conforme o composer e o feed. */
  meeting: MeetingDriver
  /** Fila de animações por personagem (F4·1-3). */
  anims: AnimDriver
  /** Impressora, pilha de papéis, ondas de som e post-it do PO (F4·4-5). */
  overlays: OfficeOverlays
  renderer: OfficeRenderer
  /** Último modelo aplicado (salas com nome e ícone, para os rótulos). */
  model: OfficeModel
  feed: OfficeFeed | null
  /** Sobe a cada feed aplicado: o painel refaz rótulos só quando muda. */
  version: number
}

/**
 * O motor só passa `active` e `t` para a arte; o monitor tem o modo 'read'.
 * Este embrulho descobre a atividade do DONO da mesa (assento com deskUid =
 * mesa) e, lendo, pede a variante 'read'. O conjunto de mesas "lendo" é
 * refeito uma vez por quadro (chave: state.time), não por móvel.
 */
export function withOwnerActivity(base: OfficeArt, state: OfficeState, palette: OfficePalette = PALETTE, overlays?: Pick<OfficeOverlays, 'variantOf'>): OfficeArt {
  const sprites = new FurnitureSprites(palette)
  let at = -1
  let reading = new Set<string>()
  const readingDesks = (): Set<string> => {
    if (state.time === at) return reading
    at = state.time
    reading = new Set()
    for (const ch of state.characters.values()) {
      if (!ch.isActive || ch.leaving || ch.activity !== 'read' || !ch.seatId) continue
      const desk = state.seats.get(ch.seatId)?.deskUid
      if (desk) reading.add(desk)
    }
    return reading
  }
  return {
    ...base,
    furnitureSprite(f, ctx) {
      const reading = f.kind === 'mesa' && ctx.active && readingDesks().has(f.uid)
      // Sobreposições (F4·4-5): impressora com contador, pilha, post-it do PO.
      const relevant = overlays && (f.kind === 'mesa' || f.kind === 'impressora' || f.kind === 'quadro-kanban')
      if (!reading && !relevant) return base.furnitureSprite(f, ctx)
      const v = variantFor(f, ctx, reading ? 'read' : 'type')
      const ov = relevant ? overlays.variantOf(f, v, ctx.t) : null
      if (!reading && !ov) return base.furnitureSprite(f, ctx)
      return sprites.of(f, ov ?? v)
    }
  }
}

let runtime: OfficeRuntime | null = null
let unsubscribe: (() => void) | null = null

function applyFeed(rt: OfficeRuntime, feed: OfficeFeed): void {
  const prevBusy = rt.feed?.busyIds
  rt.feed = feed
  rt.model = deriveOfficeModel(feed, Date.now())
  rt.director.apply(rt.model)
  rt.meeting.update(feed)
  // Animações do catálogo (F4·1-3): depois do apply, com os personagens no mapa.
  rt.anims.update(feed)
  rt.overlays.update(feed)
  // Turno novo acorda o principal do lazer.
  for (const id of feed.busyIds) if (!prevBusy?.has(id)) rt.director.onEvent(id)
  rt.version++
}

export function getOfficeRuntime(): OfficeRuntime {
  if (runtime) return runtime
  const state = new OfficeState(buildBuilding({ rooms: [] }))
  const leisure = installLeisure(state)
  // Reações dos momentos-chave (humor em memória, reinicia com o app).
  // O chamado à reunião corta a animação em curso do principal (F4·4-5).
  let anims: AnimDriver | null = null
  const director = new OfficeDirector(state, { leisure, reactions: new ReactionDriver(state), onHold: (id) => anims?.cancel(id) })
  // Preso na reunião: fica parado lá; o lazer não age sobre ele.
  state.idleBehavior = (ch, dt, api) => director.isHeld(ch.id) || leisure.idleBehavior(ch, dt, api)
  const meeting = new MeetingDriver(director, {
    presence: (id) => composerPresence.get(id),
    scheduler: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }
  })
  const overlays = new OfficeOverlays(state, director)
  const driver = new AnimDriver(state, director, undefined, { overlays })
  anims = driver
  state.afterUpdate = (dt) => driver.tick(dt)
  const art = withOwnerActivity(createOfficeArt(), state, PALETTE, overlays)
  const rt: OfficeRuntime = {
    state,
    director,
    leisure,
    meeting,
    anims: driver,
    overlays,
    renderer: new OfficeRenderer(art),
    model: { rooms: [], characters: [] },
    feed: null,
    version: 0
  }
  runtime = rt
  const snap = officeStore.getSnapshot()
  if (snap) applyFeed(rt, snap)
  const offFeed = officeStore.subscribe((f) => applyFeed(rt, f))
  // O sinal do composer entra direto aqui, sem passar pelo App.tsx.
  const offPresence = composerPresence.subscribe(() => meeting.update())
  unsubscribe = () => {
    offFeed()
    offPresence()
  }
  return rt
}

/** Só para testes: descarta os singletons. */
export function resetOfficeRuntime(): void {
  unsubscribe?.()
  unsubscribe = null
  runtime?.director.dispose()
  runtime?.meeting.dispose()
  runtime = null
}
