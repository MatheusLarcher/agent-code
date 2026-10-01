/**
 * Liga os gatilhos (animTriggers) à fila de animações (behavior/animQueue) e
 * ao motor. Roda DEPOIS do diretor aplicar o modelo: os personagens da trilha
 * nova já estão no mapa e com assento quando a animação é montada.
 *
 * - A pasta leva a cor do projeto (projectColor da sala da conversa).
 * - 'memoria' não tem mesa: a pasta vai ao arquivo do corredor.
 * - Reforço: a delegação procura o personagem PELA TRILHA, então a pasta vai
 *   à mesa que o reforço ocupou quando o especialista principal está ocupado.
 * - Principal preso na reunião não anda: a animação vira só a legenda.
 */
import { PALETTE, projectColor } from '../art'
import { AnimQueue, type Anim, type AnimStage, type AnimStep, type AnimTarget } from '../behavior/animQueue'
import type { OfficeState } from '../engine/officeState'
import { CharacterState } from '../engine/types'
import type { AnimTrigger } from './animTriggers'
import { detectTriggers } from './animTriggers'
import type { OfficeDirector } from './director'
import type { OfficeFeed } from './feed'
import { roomIdFor } from './model'
import { detectExtraTriggers, type ExtraTrigger } from './moreTriggers'
import type { OfficeOverlays } from './overlays'

type DirectorApi = Pick<OfficeDirector, 'idOf' | 'keyOfTrack' | 'modelOf' | 'reviewFailed' | 'isHeld'> &
  Partial<Pick<OfficeDirector, 'moodSignal'>>

export interface AnimDriverOptions {
  /** Post-it do PO (F4·4-5); sem ele, o quadro não muda. */
  overlays?: Pick<OfficeOverlays, 'moveKanban'>
  now?: () => number
}

/** Quanto o crítico, o PO e o memorista esperam o fim no destino, no máximo. */
const REVIEW_WAIT_SEC = 300
const OBSERVER_WAIT_SEC = 180
/** A mão do vigia fica levantada até a dúvida ser respondida. */
const FOREVER_SEC = 1e9
/** Café sem hora de volta conhecida: no máximo isto na copa. */
const COFFEE_DEFAULT_SEC = 600
/** A legenda da hora de volta fica este tempo (depois só a xícara diz). */
const COFFEE_CAPTION_SEC = 30
/** O crachá brilha por 2 s (card). */
export const BADGE_SEC = 2

/** "volta 14:05" (hora local) ou "volta logo" sem resetsAt. */
export function backAt(resetsAt: number | null): string {
  if (resetsAt === null) return 'volta logo'
  const d = new Date(resetsAt)
  return `volta ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** O AnimStage sobre o motor real. */
export function createStage(state: OfficeState, director: Pick<DirectorApi, 'modelOf' | 'isHeld'>): AnimStage {
  const ch = (id: number) => {
    const c = state.getCharacter(id)
    return c && !c.leaving ? c : undefined
  }
  return {
    exists: (id) => ch(id) !== undefined,
    waiting: (id) => {
      const b = ch(id)?.bubble
      return b === 'permissao' || b === 'pergunta'
    },
    walk(id, to) {
      if (director.isHeld(id)) return false
      if (to.kind === 'destination') return state.walkToDestination(id, to.papel)
      const seat = state.seats.get(to.seatId)
      if (!seat) return false
      // O assento é do dono: fica ao lado da cadeira (atrás, esquerda, direita, frente).
      const around = [
        [seat.col, seat.row + 1],
        [seat.col - 1, seat.row],
        [seat.col + 1, seat.row],
        [seat.col, seat.row - 1]
      ]
      return around.some(([c, r]) => state.walkToTile(id, c, r))
    },
    walking: (id) => ch(id)?.state === CharacterState.WALK,
    home(id) {
      const c = ch(id)
      if (!c || director.isHeld(id)) return false
      if (c.seatId) {
        state.sendToSeat(id)
        return true
      }
      const p = director.modelOf(id)?.placement
      return p?.kind === 'destination' ? state.walkToDestination(id, p.papel) : false
    },
    setProp: (id, prop, tint) => state.setProp(id, prop, tint ?? null),
    caption: (id, text, sec) => state.showCaption(id, text, sec),
    pin: (id, on) => state.setPinned(id, on)
  }
}

export class AnimDriver {
  readonly queue: AnimQueue
  private prev: OfficeFeed | null = null

  private readonly now: () => number

  constructor(
    private readonly state: OfficeState,
    private readonly director: DirectorApi,
    stage: AnimStage = createStage(state, director),
    private readonly opts: AnimDriverOptions = {}
  ) {
    this.queue = new AnimQueue(stage)
    this.now = opts.now ?? Date.now
  }

  /** Feed novo (depois do director.apply): dispara as animações do que aconteceu. */
  update(feed: OfficeFeed): void {
    const triggers = detectTriggers(this.prev, feed)
    const extras = detectExtraTriggers(this.prev, feed)
    this.prev = feed
    const rooms = new Map(feed.conversations.map((c) => [c.id, roomIdFor(c.cwd)]))
    for (const t of triggers) this.handle(t, rooms.get(t.convId) ?? '')
    const coffee = new Set<number>()
    for (const t of extras) this.handleExtra(t, coffee)
  }

  tick(dt: number): void {
    this.queue.tick(dt)
  }

  /** Pedido vence enfeite: o chamado à reunião corta a animação do principal. */
  cancel(id: number): void {
    this.queue.cancel(id)
  }

  /** Animações 6 (café) e 8 (crachá). */
  private handleExtra(t: ExtraTrigger, coffee: Set<number>): void {
    switch (t.type) {
      case 'cafe': {
        const sec = t.resetsAt !== null ? Math.max(1, (t.resetsAt - this.now()) / 1000) : COFFEE_DEFAULT_SEC
        for (const cid of t.convIds) {
          const id = this.id(`conv:${cid}`)
          // Já na copa (a janela da conta e o erro chegam juntos): não repete.
          if (id === null || coffee.has(id) || this.queue.current(id) === 'cafe') continue
          coffee.add(id)
          // Limite de uso mexe no humor (pendência da F3), sem reação visível.
          this.director.moodSignal?.(`conv:${cid}`, 'limite')
          this.play(id, {
            name: 'cafe',
            steps: [
              { do: 'prop', prop: 'xicara' },
              { do: 'walk', to: { kind: 'destination', papel: 'copa' } },
              { do: 'caption', text: backAt(t.resetsAt), sec: Math.min(sec, COFFEE_CAPTION_SEC) },
              { do: 'until', signal: `cafe:${cid}`, timeoutSec: sec },
              { do: 'call', fn: () => this.state.showCaption(id, null, 0) },
              { do: 'prop', prop: null },
              { do: 'home' }
            ]
          })
        }
        return
      }
      case 'cafe-fim': {
        // Turno novo: quem estava na copa volta (só sinaliza se está lá).
        const id = this.id(`conv:${t.convId}`)
        if (id !== null && this.queue.current(id) === 'cafe') this.queue.signal(id, `cafe:${t.convId}`)
        return
      }
      case 'cracha':
        this.play(this.id(`conv:${t.convId}`), {
          name: 'cracha',
          steps: [{ do: 'prop', prop: 'cracha' }, { do: 'caption', text: t.name, sec: BADGE_SEC }, { do: 'wait', sec: BADGE_SEC }, { do: 'prop', prop: null }]
        })
        return
    }
  }

  private id(key: string | null): number | null {
    return key ? this.director.idOf(key) : null
  }

  private seatOf(id: number | null): AnimTarget | null {
    const seatId = id !== null ? this.state.getCharacter(id)?.seatId : null
    return seatId ? { kind: 'seat', seatId } : null
  }

  private play(id: number | null, anim: Anim): void {
    if (id !== null) this.queue.enqueue(id, anim)
  }

  private handle(t: AnimTrigger, roomId: string): void {
    const principal = this.id(`conv:${t.convId}`)
    const tint = projectColor(roomId, PALETTE)
    switch (t.type) {
      case 'delegacao': {
        const spec = this.id(this.director.keyOfTrack(t.trackId))
        const to: AnimTarget | null = t.role === 'memoria' ? { kind: 'destination', papel: 'arquivo-memorias' } : this.seatOf(spec)
        this.play(principal, {
          name: 'delegacao',
          steps: [{ do: 'prop', prop: 'pasta', tint }, { do: 'walk', to }, { do: 'caption', text: `pasta → ${t.role}`, sec: 1.5 }, { do: 'wait', sec: 0.6 }, { do: 'prop', prop: null }, { do: 'home' }]
        })
        return
      }
      case 'devolucao': {
        const mark = t.error ? '✗' : '✓'
        const spec = this.id(this.director.keyOfTrack(t.trackId))
        if (spec === null) {
          // O reforço já saiu pela porta: só o balão no principal.
          this.play(principal, { name: 'devolucao', steps: [{ do: 'caption', text: `${mark} ${t.role}`, sec: 2 }] })
          return
        }
        this.play(spec, {
          name: 'devolucao',
          steps: [
            { do: 'prop', prop: t.error ? 'pasta-erro' : 'pasta-ok', tint },
            { do: 'walk', to: this.seatOf(principal) },
            { do: 'caption', text: mark, sec: 1.5 },
            { do: 'wait', sec: 0.6 },
            { do: 'prop', prop: null },
            { do: 'home' }
          ]
        })
        return
      }
      case 'revisao': {
        const critic = this.id(this.director.keyOfTrack(t.trackId))
        this.play(critic, {
          name: 'revisao',
          steps: [{ do: 'prop', prop: 'prancheta' }, { do: 'walk', to: this.reviewTarget(t.reviewedTrackId, roomId, principal) }, { do: 'until', signal: `revisao:${t.trackId}`, timeoutSec: REVIEW_WAIT_SEC }]
        })
        return
      }
      case 'veredito': {
        const critic = this.id(this.director.keyOfTrack(t.trackId))
        const reviewed = (t.reviewedTrackId ? this.director.keyOfTrack(t.reviewedTrackId) : null) ?? `role:${roomId}:executor`
        const frustrate = (): void => this.director.reviewFailed(reviewed)
        if (critic === null) {
          if (t.error) frustrate()
          return
        }
        this.queue.signal(critic, `revisao:${t.trackId}`)
        const steps: AnimStep[] = [{ do: 'prop', prop: t.error ? 'prancheta-erro' : 'prancheta-ok' }, { do: 'caption', text: t.error ? '✗' : '✓', sec: 2 }]
        // O ✗ frustra o EXECUTOR revisado, na hora do veredito.
        if (t.error) steps.push({ do: 'call', fn: frustrate })
        steps.push({ do: 'wait', sec: 1.5 }, { do: 'prop', prop: null })
        this.play(critic, { name: 'veredito', steps })
        return
      }
      case 'po':
        this.play(this.id(`po:${roomId}`), {
          name: 'po-quadro',
          steps: [
            { do: 'walk', to: { kind: 'destination', papel: 'kanban' } },
            { do: 'caption', text: t.round === 'open' ? 'cola post-it' : 'confere o quadro', sec: 2 },
            // Abertura: o post-it muda de coluna no quadro da sala (não é mais em ciclo).
            ...(t.round === 'open' ? [{ do: 'call' as const, fn: () => this.opts.overlays?.moveKanban(roomId) }] : []),
            { do: 'until', signal: `po:${t.convId}`, timeoutSec: OBSERVER_WAIT_SEC }
          ]
        })
        return
      case 'po-fim': {
        const po = this.id(`po:${roomId}`)
        if (po === null) return
        this.queue.signal(po, `po:${t.convId}`)
        const steps: AnimStep[] = t.cards === null ? [] : [{ do: 'caption', text: plural(t.cards, 'cartão', 'cartões'), sec: 3 }, { do: 'wait', sec: 1.5 }]
        this.play(po, { name: 'po-fim', steps: [...steps, { do: 'home' }] })
        return
      }
      case 'vigia':
        this.play(this.id(`vigia:${t.convId}`), {
          name: 'vigia-mao',
          keepOnWaiting: true,
          steps: [{ do: 'prop', prop: 'mao' }, { do: 'walk', to: { kind: 'destination', papel: 'reuniao' } }, { do: 'until', signal: `vigia:${t.convId}`, timeoutSec: FOREVER_SEC }]
        })
        return
      case 'vigia-fim': {
        const v = this.id(`vigia:${t.convId}`)
        if (v !== null) this.queue.signal(v, `vigia:${t.convId}`)
        return
      }
      case 'memorista':
        this.play(this.id(`role:${roomId}:memoria`), {
          name: 'memorista',
          steps: [{ do: 'walk', to: { kind: 'destination', papel: 'arquivo-memorias' } }, { do: 'until', signal: `memorista:${t.convId}`, timeoutSec: OBSERVER_WAIT_SEC }]
        })
        return
      case 'memorista-fim': {
        const mem = this.id(`role:${roomId}:memoria`)
        if (mem === null) return
        this.queue.signal(mem, `memorista:${t.convId}`)
        const n = t.saved ?? 0
        // Com 0 (o normal) volta sem ficha.
        const steps: AnimStep[] =
          n > 0
            ? [
                { do: 'walk', to: { kind: 'destination', papel: 'arquivo-memorias' } },
                { do: 'prop', prop: 'ficha' },
                { do: 'wait', sec: 1.2 },
                { do: 'caption', text: `+${plural(n, 'memória', 'memórias')}`, sec: 3 },
                { do: 'prop', prop: null }
              ]
            : []
        this.play(mem, { name: 'memorista-fim', steps: [...steps, { do: 'home' }] })
        return
      }
    }
  }

  /** Mesa do executor que trabalhou por último; sem executor, a do principal. */
  private reviewTarget(reviewedTrackId: string | null, roomId: string, principal: number | null): AnimTarget | null {
    if (!reviewedTrackId) return this.seatOf(principal)
    const exec = this.seatOf(this.id(this.director.keyOfTrack(reviewedTrackId)))
    return exec ?? { kind: 'seat', seatId: `${roomId}:esp:executor` }
  }
}
