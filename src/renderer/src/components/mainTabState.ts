/**
 * Abas da área principal (Conversa ⇄ Escritório) — o que não é desenho:
 *
 * - as escolhas lembradas entre sessões (localPrefs: síncrono, o app já abre
 *   na aba que o usuário deixou), como em planning/paneSizes: a aba e o chat
 *   do escritório minimizado (à parte do chat do Planejamento);
 * - o selo da aba Escritório, lido do feed do officeStore: quantos agentes
 *   estão trabalhando no escritório inteiro (conversas ocupadas + trilhas de
 *   subagente rodando, em todos os projetos) e o nível da energia (a janela
 *   de 5h da conta, power.ts — puro, sem three), com a mesma histerese da
 *   pílula do HUD: quem chama passa a leitura anterior (`prev`).
 */
import type { OfficeFeed } from '../office/adapter/feed'
import { loadFlag, readPref, saveFlag, writePref } from '../localPrefs'
import { officePower, type OfficePower, type PowerLevel } from '../office3d/power'

export type MainTab = 'chat' | 'office'

const MAIN_TAB_KEY = 'agentcode.mainTab'
const OFFICE_CHAT_MIN_KEY = 'agentcode.office.chatMinimized'

/** Padrão: Conversa. Valor desconhecido também cai nela. */
export function loadMainTab(): MainTab {
  return readPref(MAIN_TAB_KEY) === 'office' ? 'office' : 'chat'
}

export function saveMainTab(tab: MainTab): void {
  writePref(MAIN_TAB_KEY, tab)
}

/** Padrão: maximizado. */
export function loadOfficeChatMinimized(): boolean {
  return loadFlag(OFFICE_CHAT_MIN_KEY)
}

export function saveOfficeChatMinimized(minimized: boolean): void {
  saveFlag(OFFICE_CHAT_MIN_KEY, minimized)
}

export interface OfficeTabStatus {
  /** Agentes trabalhando agora: conversas ocupadas + subagentes rodando. */
  working: number
  /** Nível da energia do escritório; null sem a janela de 5h. */
  level: PowerLevel | null
  pct: number | null
  /** A leitura inteira: passe-a como `prev` na próxima chamada (histerese e consumo). */
  power: OfficePower | null
}

export function officeTabStatus(feed: OfficeFeed | null, now: number, prev: OfficePower | null = null): OfficeTabStatus {
  if (!feed) return { working: 0, level: null, pct: null, power: null }
  let working = 0
  for (const c of feed.conversations) {
    if (feed.busyIds.has(c.id)) working++
    const tracks = feed.tracks[c.id]
    if (tracks) for (const t of Object.values(tracks)) if (t.status === 'running') working++
  }
  const power = officePower(feed, now, prev)
  return { working, level: power?.level ?? null, pct: power?.pct ?? null, power }
}
