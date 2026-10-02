/**
 * Falas da energia do escritório — PURO (sem DOM, sem relógio próprio, sorteio
 * injetado). Decide QUEM fala da energia a cada passo; se a fala entra no ar
 * (prioridade, TTL) quem decide é o generator.ts.
 *
 *   evento (powerEvents)  economia e alerta: 1 agente anuncia; apagão e luz
 *                         voltou: 2. Sempre com o dado: % e/ou a hora em que recarrega.
 *   lembrete              no alerta a cada ALERT_REMIND_MS e na economia a cada
 *                         ECO_REMIND_MS, um agente repete a % atual.
 *   festa (apagão)        frases rotativas: no máximo PARTY_TALKERS falando ao
 *                         mesmo tempo (quem anunciou o apagão conta), uma nova a
 *                         cada PARTY_GAP_MS–2×PARTY_GAP_MS, passando a vez pelo
 *                         escritório. Quem tem papel na festa (lanterna, pizza,
 *                         trenzinho) às vezes fala do papel.
 * Quem está com permissão ou erro pendente não é escolhido: aquelas falas ganham.
 */
import type { AgentStatus } from '../events'
import type { PartyRole } from '../partyPlan'
import type { PowerEvent, PowerLevel } from '../power'
import { clockTime, type Slots } from './format'
import type { Situation } from './lines'

export interface PowerQuipInput {
  level: PowerLevel
  pct: number
  resetsAt: number | null
  /** Mudança detectada neste passo (powerEvents); null sem mudança. */
  event: PowerEvent | null
  /** Papel de cada agente na festa do apagão. */
  roles?: ReadonlyMap<string, PartyRole>
}

export interface PowerCand {
  sit: Situation
  slots: Slots
}

export const PARTY_TALKERS = 2
export const PARTY_GAP_MS = 1_600
export const ALERT_REMIND_MS = 25_000
export const ECO_REMIND_MS = 70_000
/** Quanto um anúncio de energia "ocupa" a vez de falar na festa (o TTL dele). */
export const ANNOUNCE_MS = 6_500
export const PARTY_LINE_MS = 4_000
/** Chance de quem tem papel especial falar do papel (e não uma frase geral). */
const ROLE_CHANCE = 0.65

const ANNOUNCERS: Readonly<Record<PowerEvent, number>> = { economia: 1, alerta: 1, apagao: 2, 'luz-voltou': 2 }
const EVENT_SIT: Readonly<Record<PowerEvent, Situation>> = {
  economia: 'power-eco',
  alerta: 'power-alert',
  apagao: 'power-out',
  'luz-voltou': 'power-back'
}
const ROLE_SIT: Readonly<Record<PartyRole, Situation>> = { dance: 'party', conga: 'party-conga', flashlight: 'party-flashlight', pizza: 'party-pizza' }

export interface PowerVoice {
  step(statuses: ReadonlyMap<string, AgentStatus>, power: PowerQuipInput | null, now: number): Map<string, PowerCand>
}

/** Pode falar da energia: sem permissão nem erro pendente (essas falas ganham de qualquer jeito). */
const free = (s: AgentStatus): boolean => s.permission === null && s.error === null

export function createPowerVoice(roll: () => number): PowerVoice {
  /** Quem está falando na festa (ou anunciou) → até quando. */
  const talking = new Map<string, number>()
  let nextPartyAt = 0
  let nextRemindAt = 0
  let lastKey = ''

  /** `n` agentes livres, principais primeiro, sorteados. */
  function pick(statuses: ReadonlyMap<string, AgentStatus>, n: number): string[] {
    const pool = [...statuses.values()].filter(free)
    const main = pool.filter((s) => s.role === 'principal')
    const order = main.length >= n ? main : pool
    const keys = order.map((s) => s.key)
    const out: string[] = []
    while (out.length < n && keys.length > 0) out.push(keys.splice(Math.floor(roll() * keys.length) % keys.length, 1)[0])
    return out
  }

  /** O próximo da roda depois de quem falou por último (pulando 0–2 para não ficar previsível). */
  function nextTalker(statuses: ReadonlyMap<string, AgentStatus>, skip: ReadonlyMap<string, PowerCand>): string | null {
    const keys = [...statuses.values()].filter((s) => free(s) && !talking.has(s.key) && !skip.has(s.key)).map((s) => s.key)
    if (keys.length === 0) return null
    const all = [...statuses.keys()]
    const after = all.indexOf(lastKey)
    let first = keys.findIndex((k) => all.indexOf(k) > after)
    if (first < 0) first = 0
    return keys[(first + Math.floor(roll() * 3)) % keys.length]
  }

  return {
    step(statuses, power, now) {
      const out = new Map<string, PowerCand>()
      if (!power) {
        talking.clear()
        return out
      }
      for (const [k, until] of talking) if (until <= now || !statuses.has(k)) talking.delete(k)
      const time = power.resetsAt === null ? '' : clockTime(power.resetsAt, now)
      const slots: Slots = { pct: power.pct, time }
      if (power.event) {
        for (const key of pick(statuses, ANNOUNCERS[power.event])) {
          out.set(key, { sit: EVENT_SIT[power.event], slots })
          talking.set(key, now + ANNOUNCE_MS)
        }
        nextRemindAt = now + (power.event === 'alerta' ? ALERT_REMIND_MS : ECO_REMIND_MS)
      } else if ((power.level === 'alerta' || power.level === 'economia') && now >= nextRemindAt) {
        const alert = power.level === 'alerta'
        for (const key of pick(statuses, 1)) out.set(key, { sit: alert ? 'power-alert' : 'power-eco', slots })
        nextRemindAt = now + (alert ? ALERT_REMIND_MS : ECO_REMIND_MS)
      }
      if (power.level !== 'apagao') {
        talking.clear()
        return out
      }
      if (talking.size >= PARTY_TALKERS || now < nextPartyAt) return out
      const key = nextTalker(statuses, out)
      if (!key) return out
      const role = power.roles?.get(key) ?? 'dance'
      const sit = role !== 'dance' && roll() < ROLE_CHANCE ? ROLE_SIT[role] : 'party'
      out.set(key, { sit, slots: { time } })
      talking.set(key, now + PARTY_LINE_MS)
      lastKey = key
      nextPartyAt = now + PARTY_GAP_MS * (1 + roll())
      return out
    }
  }
}
