/**
 * As instâncias únicas do app: o cliente da ponte, a navegação (abas embaixo,
 * guardada no aparelho para voltar à última tela ao abrir) e os avisos curtos.
 */
import { CENTRAL_CONV_ID, RemoteClient } from '../core/client'
import { loadLastConv } from '../core/pcs'
import { createStore } from '../core/store'
import type { ConvSummary, ToastTipo } from '../core/types'

export type Tab = 'central' | 'conversas' | 'planos' | 'escritorio' | 'quadro'

export interface NavState {
  tab: Tab
  /** Na aba Conversas: uma conversa aberta (true) ou a lista (false). */
  chatOpen: boolean
  settingsOpen: boolean
  statusMenuOpen: boolean
  /** O leitor de QR para abrir uma filial está por cima da tela (não é guardado no aparelho). */
  scanOpen: boolean
}

const UI_KEY = 'agent-remote-ui'
const TABS: Tab[] = ['central', 'conversas', 'planos', 'escritorio', 'quadro']

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
    statusMenuOpen: false,
    scanOpen: false
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
  const last = loadLastConv(client.state.token)
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

export const client = new RemoteClient({ pickInitialConv, notify: (text, tipo) => toast(text, tipo) })

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

/** Abre o leitor de QR para uma nova filial, por cima de qualquer tela (e fecha o menu que o chamou). */
export function openScanner(): void {
  nav.set({ statusMenuOpen: false, scanOpen: true })
}

// ---- avisos curtos (no lugar dos alert() do app antigo) ----------------------------

export interface Toast {
  id: number
  text: string
  /** Sem tipo = o aviso neutro de sempre; as cores por tipo são da tela. */
  tipo?: ToastTipo
  /** Fechando: a tela faz o fade-out e o aviso sai da lista logo depois. */
  leaving?: boolean
}

export const toasts = createStore<{ list: Toast[] }>({ list: [] })
let toastSeq = 0

/** Duração do fade-out (o mesmo valor da animação `toast-out` em base.css). */
const TOAST_LEAVE_MS = 220

/** Fecha um aviso: marca `leaving` (fade-out) e o tira da lista ~220 ms depois. Id que não existe ou já saindo: nada muda. */
export function dismissToast(id: number): void {
  const found = toasts.get().list.find((t) => t.id === id)
  if (!found || found.leaving) return
  toasts.set((s) => ({ list: s.list.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }))
  setTimeout(() => toasts.set((s) => ({ list: s.list.filter((t) => t.id !== id) })), TOAST_LEAVE_MS)
}

export function toast(text: string, tipo?: ToastTipo, ms = 4500): void {
  const id = ++toastSeq
  toasts.set((s) => ({ list: [...s.list, { id, text, tipo }].slice(-3) }))
  setTimeout(() => dismissToast(id), ms)
}
