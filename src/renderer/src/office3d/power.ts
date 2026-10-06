/**
 * Energia do Escritório 3D — PURO (sem three, sem relógio próprio). A fonte de
 * energia do escritório inteiro são os tokens da sessão de 5h da conta: a MESMA
 * janela `five_hour` de usageLimits e a mesma conta da bateria de sessão
 * (battery.ts/sessionBattery) — aqui só entram o nível, a histerese, o consumo e
 * os eventos de mudança.
 *
 *   officePower(feed, now, prev?)  → { pct, level, resetsAt, drainPerMin, … }
 *     `prev` = o retorno da chamada anterior (histerese e amostras do consumo);
 *     null sem a janela de 5h (o HUD some e o prédio fica com luz cheia).
 *   powerEvents(prev, next)        → 'economia' | 'alerta' | 'apagao' | 'luz-voltou' | null
 *
 * Níveis: ≥ 50% cheia; 20–50 economia; 1–20 alerta; 0% ou status 'rejected' →
 * apagão. Histerese de POWER_HYSTERESIS pontos: piorar vale na fronteira
 * nominal; melhorar só quando a carga passa a fronteira com a folga (49 → 50 →
 * 52 continua em economia; 53 volta a cheia). O reset que já passou (now ≥
 * resetsAt, sem leitura nova) é janela nova: 100%.
 *
 * Consumo (drainPerMin, pontos percentuais por minuto): média móvel das
 * amostras dos últimos DRAIN_WINDOW_MS — a inclinação entre a mais antiga e a
 * mais nova da janela. A amostra usa o horário da leitura (updatedAt), uma a
 * cada SAMPLE_MIN_MS no máximo; uma subida brusca (reset) recomeça a conta.
 */
import type { RateLimitStatus } from '@shared/ipc'
import { accountBank, accountLimits, connectedAccounts, featuredAccount, type AccountFeed, type BankAccount } from './accountBank'
import { BATTERY_COLORS, sessionBattery } from './battery'
import { clockTime } from './quips/format'

export type PowerLevel = 'cheia' | 'economia' | 'alerta' | 'apagao'
export type PowerEvent = 'economia' | 'alerta' | 'apagao' | 'luz-voltou'

export const POWER_LEVELS: readonly PowerLevel[] = ['cheia', 'economia', 'alerta', 'apagao']
/** Piso (%) de cada nível; abaixo de 1% é apagão. */
export const LEVEL_FLOOR: Readonly<Record<Exclude<PowerLevel, 'apagao'>, number>> = { cheia: 50, economia: 20, alerta: 1 }
export const POWER_HYSTERESIS = 3
export const DRAIN_WINDOW_MS = 10 * 60_000
export const SAMPLE_MIN_MS = 5_000
export const MAX_SAMPLES = 24
/** Subida (pontos) entre duas leituras que conta como janela nova: o consumo recomeça. */
export const RESET_JUMP = 5

export const POWER_LABEL: Readonly<Record<PowerLevel, string>> = {
  cheia: 'Energia cheia',
  economia: 'Modo economia',
  alerta: 'Bateria fraca',
  apagao: 'Apagão'
}

/** Cor de cada nível: as da bateria do HUD (verde, amarela, vermelha). */
export const LEVEL_COLORS: Readonly<Record<PowerLevel, string>> = {
  cheia: BATTERY_COLORS.high,
  economia: BATTERY_COLORS.mid,
  alerta: BATTERY_COLORS.low,
  apagao: '#ff6b6b'
}

export interface PowerSample {
  /** Epoch ms da leitura. */
  at: number
  pct: number
}

export interface OfficePower {
  /** Energia restante, 0..100 inteiro (a mesma % da bateria da sessão 5h). */
  pct: number
  /** A conta em destaque (accountBank.ts) de onde vem a energia; null sem lista de contas (o usageLimits global). */
  accountId: string | null
  /** As contas conectadas (a doca da pílula e do quadro); vazio sem lista de contas. */
  bank: readonly BankAccount[]
  /** A conta em destaque ainda sem leitura: luz cheia, a pílula mostra "—". */
  unread?: boolean
  level: PowerLevel
  /** Epoch ms do reset da janela; null sem horário (ou janela nova sem leitura). */
  resetsAt: number | null
  /** Consumo estimado em pontos percentuais por minuto (0 parado ou sem amostras). */
  drainPerMin: number
  rejected: boolean
  /** Amostras do consumo, da mais antiga para a mais nova (passe o retorno como `prev`). */
  samples: readonly PowerSample[]
}

const RANK: Readonly<Record<PowerLevel, number>> = { cheia: 0, economia: 1, alerta: 2, apagao: 3 }

/** O nível pela carga, sem histerese. */
export function plainLevel(pct: number, rejected: boolean): PowerLevel {
  if (rejected || !(pct >= LEVEL_FLOOR.alerta)) return 'apagao'
  if (pct < LEVEL_FLOOR.economia) return 'alerta'
  if (pct < LEVEL_FLOOR.cheia) return 'economia'
  return 'cheia'
}

/** Nível com histerese: piora na fronteira; melhora só POWER_HYSTERESIS pontos acima dela. */
export function powerLevel(pct: number, rejected: boolean, prev: PowerLevel | null = null): PowerLevel {
  const plain = plainLevel(pct, rejected)
  if (prev === null || RANK[plain] >= RANK[prev]) return plain
  const up = plainLevel(pct - POWER_HYSTERESIS, rejected)
  return RANK[up] < RANK[prev] ? up : prev
}

/** Pontos por minuto entre a amostra mais antiga e a mais nova (0 com menos de duas ou subindo). */
export function drainOf(samples: readonly PowerSample[]): number {
  if (samples.length < 2) return 0
  const a = samples[0]
  const b = samples[samples.length - 1]
  const min = (b.at - a.at) / 60_000
  if (!(min > 0)) return 0
  return Math.max(0, Math.round(((a.pct - b.pct) / min) * 100) / 100)
}

/** A janela de amostras depois da leitura (`at`, `pct`), sem passar de DRAIN_WINDOW_MS até `now`. */
export function nextSamples(prev: readonly PowerSample[], at: number, pct: number, now: number): readonly PowerSample[] {
  const last = prev[prev.length - 1]
  if (last && (pct > last.pct + RESET_JUMP || at < last.at)) return [{ at, pct }]
  const out = prev.filter((s) => now - s.at <= DRAIN_WINDOW_MS)
  if (!last || at - last.at >= SAMPLE_MIN_MS) out.push({ at, pct })
  // Leitura repetida (ou cedo demais): a última fica como base, mesmo velha.
  else if (out.length === 0) out.push(last)
  return out.length > MAX_SAMPLES ? out.slice(out.length - MAX_SAMPLES) : out
}

type Limits = Readonly<Record<string, RateLimitStatus>> | undefined

/** O que a energia lê do feed: a lista de contas (e as conversas, para a conta em destaque) ou, sem ela, usageLimits. */
export type PowerFeed = AccountFeed & { usageLimits?: Limits }

/**
 * Energia do escritório agora; null sem a janela de 5h. Com contas conectadas, a janela é a da conta
 * em destaque (accountBank.ts) — trocou a conta, é outra bateria: as amostras e a histerese recomeçam.
 */
export function officePower(feed: PowerFeed | null | undefined, now: number, prev: OfficePower | null = null): OfficePower | null {
  const accountId = featuredAccount(feed)
  const bank = accountId === null ? [] : accountBank(feed, now)
  const account = accountId === null ? undefined : connectedAccounts(feed).find((a) => a.id === accountId)
  const limits: Limits = account ? accountLimits(account, now) : feed?.usageLimits
  if (prev && prev.accountId !== accountId) prev = null
  const battery = sessionBattery(limits, now)
  const l = limits?.five_hour
  if (accountId !== null && (!battery || !l)) {
    // A conta em destaque sem leitura (ou janela de 5 h ainda sem uso): luz cheia.
    const unread = !account?.usage
    return { pct: 100, accountId, bank, unread, level: 'cheia', resetsAt: null, drainPerMin: 0, rejected: false, samples: [] }
  }
  if (!battery || !l) return null
  let pct = battery.percent
  let rejected = battery.rejected
  let resetsAt = typeof l.resetsAt === 'number' && Number.isFinite(l.resetsAt) ? l.resetsAt : null
  // O reset já passou e ainda não chegou leitura da janela nova: energia cheia.
  if (resetsAt !== null && now >= resetsAt) {
    pct = 100
    rejected = false
    resetsAt = null
  }
  const at = typeof l.updatedAt === 'number' && Number.isFinite(l.updatedAt) ? Math.min(l.updatedAt, now) : now
  const samples = nextSamples(prev?.samples ?? [], at, pct, now)
  return { pct, accountId, bank, level: powerLevel(pct, rejected, prev?.level ?? null), resetsAt, drainPerMin: drainOf(samples), rejected, samples }
}

/** O que mudou de `prev` para `next`: piorou → o nível novo; saiu do apagão → 'luz-voltou'; o resto, null. */
export function powerEvents(prev: Pick<OfficePower, 'level'> | null, next: Pick<OfficePower, 'level'> | null): PowerEvent | null {
  if (!prev || !next || prev.level === next.level) return null
  if (prev.level === 'apagao') return 'luz-voltou'
  if (RANK[next.level] > RANK[prev.level]) return next.level as Exclude<PowerLevel, 'cheia'>
  return null
}

/** Hora do reset como se fala ("23:40"; a mais de 20 h, com a data); '' sem horário. */
export function resetClock(resetsAt: number | null, now: number): string {
  return resetsAt === null ? '' : clockTime(resetsAt, now)
}

/** Linha do painel da usina: "⚡ 72% · recarrega às 23:40" (no apagão também: é quando a luz volta). */
export function powerPanelText(p: Pick<OfficePower, 'pct' | 'level' | 'resetsAt'>, now: number): string {
  const time = resetClock(p.resetsAt, now)
  return time ? `⚡ ${p.pct}% · recarrega às ${time}` : `⚡ ${p.pct}%`
}
