/**
 * As instâncias únicas do app: o cliente da ponte, a navegação (abas embaixo,
 * guardada no aparelho para voltar à última tela ao abrir) e os avisos curtos.
 */
import { CENTRAL_CONV_ID, RemoteClient } from '../core/client'
import { loadLastConv } from '../core/config'
import { createStore } from '../core/store'
import type { ConvSummary } from '../core/types'

export type Tab = 'central' | 'conversas' | 'escritorio' | 'quadro'

export interface NavState {
  tab: Tab
  /** Na aba Conversas: uma conversa aberta (true) ou a lista (false). */
  chatOpen: boolean
  settingsOpen: boolean
  statusMenuOpen: boolean
}

const UI_KEY = 'agent-remote-ui'
const TABS: Tab[] = ['central', 'conversas', 'escritorio', 'quadro']

function loadNav(): NavState {
  let saved: Partial<NavState> = {}
  try {
    saved = (JSON.parse(localStorage.getItem(UI_KEY) || '{}') as Partial<NavState>) ?? {}
  } catch {
    /* corrompido: padrão */
  }
  return {
    tab: TABS.includes(saved.tab as Tab) ? (saved.tab as Tab) : 'conversas',
    chatOpen: saved.chatOpen !== false,
    settingsOpen: false,
    statusMenuOpen: false
  }
}

export const nav = createStore<NavState>(loadNav())

nav.subscribe(() => {
  const { tab, chatOpen } = nav.get()
  localStorage.setItem(UI_KEY, JSON.stringify({ tab, chatOpen }))
})

const isCentral = (c: ConvSummary): boolean => c.id === CENTRAL_CONV_ID

/** A conversa (não-Central) para reabrir: a última aberta, senão a primeira do PC. */
export function lastConversation(conversations: ConvSummary[]): string | null {
  const last = loadLastConv()
  if (last && conversations.some((c) => c.id === last && !isCentral(c))) return last
  return conversations.find((c) => !isCentral(c))?.id ?? null
}

/** Ao conectar: volta à última aba/conversa guardada no aparelho. */
function pickInitialConv(conversations: ConvSummary[]): string | null {
  const { tab, chatOpen } = nav.get()
  if (tab === 'central') {
    if (conversations.some(isCentral)) return CENTRAL_CONV_ID
    nav.set({ tab: 'conversas' })
  }
  if (nav.get().tab !== 'conversas' || !chatOpen) return null
  const id = lastConversation(conversations)
  if (!id) nav.set({ chatOpen: false })
  return id
}

export const client = new RemoteClient({ pickInitialConv })

export function openTab(tab: Tab): void {
  nav.set({ tab, statusMenuOpen: false })
  const { conversations, convId } = client.state
  if (tab === 'central') {
    if (conversations.some(isCentral)) client.selectConv(CENTRAL_CONV_ID)
    return
  }
  if (tab === 'conversas' && nav.get().chatOpen) {
    const id = convId && convId !== CENTRAL_CONV_ID ? convId : lastConversation(conversations)
    if (id) client.selectConv(id)
    else nav.set({ chatOpen: false })
  }
}

export function openConversation(convId: string, scrollToMsg: string | null = null): void {
  if (convId === CENTRAL_CONV_ID) return openTab('central')
  nav.set({ tab: 'conversas', chatOpen: true, statusMenuOpen: false })
  client.setScrollTarget(scrollToMsg)
  client.selectConv(convId)
}

export function backToList(): void {
  nav.set({ chatOpen: false })
}

// ---- avisos curtos (no lugar dos alert() do app antigo) ----------------------------

export interface Toast {
  id: number
  text: string
}

export const toasts = createStore<{ list: Toast[] }>({ list: [] })
let toastSeq = 0

export function toast(text: string, ms = 4500): void {
  const id = ++toastSeq
  toasts.set((s) => ({ list: [...s.list, { id, text }].slice(-3) }))
  setTimeout(() => toasts.set((s) => ({ list: s.list.filter((t) => t.id !== id) })), ms)
}
