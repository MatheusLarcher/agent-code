/**
 * Lista de PCs salvos neste celular — no app, cada PC é uma "filial".
 *
 * Vive no localStorage, na chave `agent-remote-pcs`. As chaves do app antigo não mudam
 * de significado (ver config.ts): `agent-remote-config` continua sendo gravado com o PC
 * ATIVO (quem voltar a um APK antigo continua pareado) e `agent-remote-device` não é
 * tocado (o mesmo celular é o pareado dos dois PCs).
 *
 * O token é a identidade de um PC (único por PC): é por ele que se acha, se atualiza e se
 * grava a última conversa. Isso importa na troca de PC: o novo ativo é gravado e a página
 * recarrega; uma resposta ainda em voo do PC anterior, nesse intervalo, não pode escrever
 * no PC novo — por isso essas gravações levam o token da conexão, não "o ativo".
 *
 * O localStorage é fronteira do sistema: o que vier dele é validado e normalizado, e um
 * JSON corrompido ou com formato errado nunca derruba o app.
 */
import { LAST_CONV_KEY, clearConfig, loadConfig, saveConfig, type PairConfig } from './config'
import { createStore } from './store'
import type { ToastTipo } from './types'

export const PCS_KEY = 'agent-remote-pcs'

/** Tamanho máximo do apelido de um PC (o campo de nome das Configurações usa o mesmo limite). */
export const MAX_NAME = 60

export interface SavedPc {
  id: string
  /** Apelido; null = ainda sem nome (a tela mostra "PC N"). */
  nome: string | null
  base: string
  token: string
  lan: string
  /** Última conversa aberta neste PC (os ids de um PC não existem no outro). */
  lastConv: string | null
  addedAt: number
  lastUsedAt: number
}

export interface PcList {
  pcs: SavedPc[]
  /** O PC em uso; null = nenhum. */
  activeId: string | null
}

/** Espelho reativo da lista salva — as telas leem com useStore(pcsStore, …). */
export const pcsStore = createStore<PcList>({ pcs: [], activeId: null })

// ---- leitura da lista ------------------------------------------------------------------

export function activePc(list: PcList): SavedPc | null {
  return list.pcs.find((p) => p.id === list.activeId) ?? null
}

/** O pareamento de um PC no formato do app antigo (`agent-remote-config`). */
export function pcConfig(pc: SavedPc): PairConfig {
  return { base: pc.base, token: pc.token, lan: pc.lan }
}

/** O nome do PC, ou "PC N" (N = posição na lista) enquanto ele não tem apelido. */
export function pcLabel(pc: SavedPc, list: PcList): string {
  return pc.nome ?? `PC ${list.pcs.findIndex((p) => p.id === pc.id) + 1}`
}

/** Todos menos o ativo, do usado mais recentemente ao mais antigo. */
export function otherPcs(list: PcList): SavedPc[] {
  return list.pcs.filter((p) => p.id !== list.activeId).sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

// ---- gravação e espelho no store ---------------------------------------------------------

const emptyList = (): PcList => ({ pcs: [], activeId: null })
const serialize = (list: PcList): string => JSON.stringify({ pcs: list.pcs, activeId: list.activeId })

/** A última lista copiada para o `pcsStore`: as telas só são avisadas quando o conteúdo muda. */
let synced = serialize(emptyList())

function syncStore(list: PcList): void {
  const json = serialize(list)
  if (json === synced) return
  synced = json
  pcsStore.set({ pcs: list.pcs, activeId: list.activeId })
}

/**
 * Toda escrita passa por aqui: grava a lista, espelha o PC ativo em `agent-remote-config`
 * (sem ativo, apaga — o app antigo fica sem pareamento, como com a lista vazia) e só então
 * avisa as telas, que já encontram o localStorage em dia.
 */
function persist(list: PcList): void {
  localStorage.setItem(PCS_KEY, serialize(list))
  const active = activePc(list)
  if (active) saveConfig(pcConfig(active))
  else clearConfig()
  syncStore(list)
}

// ---- leitura do localStorage (entrada não confiável) ---------------------------------------

const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Id no mesmo estilo do `deviceId` (config.ts). */
const newId = (): string => 'pc-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

/** Apelido aparado e limitado; vazio (ou não texto) = sem apelido. */
const cleanName = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, MAX_NAME) : '')

/** Uma entrada salva → `SavedPc`; null quando não dá para aproveitá-la. */
function normalizePc(value: unknown): SavedPc | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  if (typeof r.base !== 'string') return null
  if (typeof r.token !== 'string' || !r.token) return null
  const nome = typeof r.nome === 'string' ? r.nome.trim() : ''
  return {
    id: r.id,
    nome: nome || null,
    base: r.base,
    token: r.token,
    lan: typeof r.lan === 'string' ? r.lan : '',
    lastConv: typeof r.lastConv === 'string' ? r.lastConv : null,
    addedAt: finite(r.addedAt),
    lastUsedAt: finite(r.lastUsedAt)
  }
}

/** O de maior `lastUsedAt` (no empate, o primeiro da lista). */
function mostRecent(pcs: SavedPc[]): SavedPc | null {
  let best: SavedPc | null = null
  for (const pc of pcs) if (!best || pc.lastUsedAt > best.lastUsedAt) best = pc
  return best
}

/**
 * A lista como está em `agent-remote-pcs`, validada. null quando a chave falta, o JSON está
 * corrompido, o formato é outro ou não sobrou nenhuma entrada aproveitável.
 */
function readStored(): PcList | null {
  let stored: unknown
  try {
    stored = JSON.parse(localStorage.getItem(PCS_KEY) || 'null')
  } catch {
    return null
  }
  if (!stored || typeof stored !== 'object') return null
  const { pcs: items, activeId } = stored as { pcs?: unknown; activeId?: unknown }
  if (!Array.isArray(items)) return null
  const ids = new Set<string>()
  const tokens = new Set<string>()
  const pcs: SavedPc[] = []
  for (const item of items) {
    const pc = normalizePc(item)
    if (!pc || ids.has(pc.id) || tokens.has(pc.token)) continue // inválida ou repetida: fica a primeira
    ids.add(pc.id)
    tokens.add(pc.token)
    pcs.push(pc)
  }
  const active = pcs.find((p) => p.id === activeId) ?? mostRecent(pcs)
  return active ? { pcs, activeId: active.id } : null
}

/**
 * Abre a lista e a deixa espelhada no `pcsStore`. Só a migração grava: sem lista
 * aproveitável, o pareamento único do app antigo (`agent-remote-config` + última conversa)
 * vira o primeiro PC, ativo. Sem nada para migrar, devolve a lista vazia e não grava nada.
 */
export function loadPcs(): PcList {
  const stored = readStored()
  if (stored) {
    syncStore(stored)
    return stored
  }
  const cfg = loadConfig()
  if (cfg && cfg.base && cfg.token) {
    const now = Date.now()
    const pc: SavedPc = {
      id: newId(),
      nome: null,
      base: cfg.base,
      token: cfg.token,
      lan: cfg.lan,
      lastConv: localStorage.getItem(LAST_CONV_KEY),
      addedAt: now,
      lastUsedAt: now
    }
    const migrated: PcList = { pcs: [pc], activeId: pc.id }
    persist(migrated)
    return migrated
  }
  const empty = emptyList()
  syncStore(empty)
  return empty
}

// ---- alterações (parte sempre de `loadPcs`: a lista antiga nunca se perde) ---------------------

/** A lista com o PC `next` no lugar do que tem o mesmo id (a ordem é mantida). */
const withPc = (list: PcList, next: SavedPc): PcList => ({
  ...list,
  pcs: list.pcs.map((p) => (p.id === next.id ? next : p))
})

/**
 * Guarda o pareamento de um QR. O token já salvo só atualiza o endereço (`base`/`lan`); um
 * token novo entra no fim, sem nome. NÃO muda o PC ativo — quem ativa é o `setActivePc`.
 */
export function upsertPc(cfg: PairConfig, now = Date.now()): { pc: SavedPc; existed: boolean } {
  const list = loadPcs()
  const found = list.pcs.find((p) => p.token === cfg.token)
  if (found) {
    const pc: SavedPc = { ...found, base: cfg.base, lan: cfg.lan }
    persist(withPc(list, pc))
    return { pc, existed: true }
  }
  const pc: SavedPc = { id: newId(), nome: null, base: cfg.base, token: cfg.token, lan: cfg.lan, lastConv: null, addedAt: now, lastUsedAt: now }
  persist({ ...list, pcs: [...list.pcs, pc] })
  return { pc, existed: false }
}

/** Passa a usar este PC (e o espelha em `agent-remote-config`). Id inexistente: null, nada muda. */
export function setActivePc(id: string, now = Date.now()): SavedPc | null {
  const list = loadPcs()
  const found = list.pcs.find((p) => p.id === id)
  if (!found) return null
  const pc: SavedPc = { ...found, lastUsedAt: now }
  persist({ ...withPc(list, pc), activeId: id })
  return pc
}

/**
 * Esquece um PC. Se era o ativo, o restante usado mais recentemente assume (`next`); sem
 * restante, fica sem ativo e o `persist` apaga `agent-remote-config`. Se não era, `next` é o
 * ativo de antes. Id inexistente: nada removido, nada gravado.
 */
export function removePc(id: string, now = Date.now()): { removed: SavedPc | null; wasActive: boolean; next: SavedPc | null } {
  const list = loadPcs()
  const removed = list.pcs.find((p) => p.id === id) ?? null
  if (!removed) return { removed: null, wasActive: false, next: activePc(list) }
  const rest: PcList = { pcs: list.pcs.filter((p) => p.id !== id), activeId: list.activeId }
  if (list.activeId !== id) {
    persist(rest)
    return { removed, wasActive: false, next: activePc(rest) }
  }
  const heir = mostRecent(rest.pcs)
  const next: SavedPc | null = heir ? { ...heir, lastUsedAt: now } : null
  persist(next ? { ...withPc(rest, next), activeId: next.id } : emptyList())
  return { removed, wasActive: true, next }
}

/** Dá o apelido (aparado, até 60 caracteres). Vazio ou id inexistente: false, nada muda. */
export function renamePc(id: string, nome: string): boolean {
  const name = cleanName(nome)
  if (!name) return false
  const list = loadPcs()
  const found = list.pcs.find((p) => p.id === id)
  if (!found) return false
  persist(withPc(list, { ...found, nome: name }))
  return true
}

/**
 * Nome padrão vindo do hostname do PC: só entra se o PC (achado pelo token) ainda não tem
 * nome — NUNCA sobrescreve um nome já dado, nem o que o usuário editou.
 */
export function namePcIfUnnamed(token: string, pcName: string | null | undefined): boolean {
  const name = cleanName(pcName)
  if (!name) return false
  const list = loadPcs()
  const found = list.pcs.find((p) => p.token === token)
  if (!found || found.nome !== null) return false
  persist(withPc(list, { ...found, nome: name }))
  return true
}

// ---- última conversa por PC -------------------------------------------------------------------

/**
 * A última conversa do PC deste token (pode ser null). Sem PC salvo com o token — navegador
 * aberto por `/app/?token=`, ou ainda sem lista — vale a chave antiga.
 */
export function loadLastConv(token: string): string | null {
  const pc = readStored()?.pcs.find((p) => p.token === token)
  return pc ? pc.lastConv : localStorage.getItem(LAST_CONV_KEY)
}

/**
 * Grava a chave antiga SEMPRE (voltar a um APK antigo continua funcionando) e, havendo PC
 * salvo com este token, a conversa dele. Não migra nem cria a lista só por abrir uma conversa.
 */
export function saveLastConv(token: string, convId: string): void {
  localStorage.setItem(LAST_CONV_KEY, convId)
  const list = readStored()
  const pc = list?.pcs.find((p) => p.token === token)
  if (list && pc) persist(withPc(list, { ...pc, lastConv: convId }))
}

// ---- sinal de uso único para a próxima carga da página ------------------------------------------

/**
 * Trocar ou adicionar um PC termina em reload, e o reload perde o que só existia na memória:
 * que o QR foi lido AGORA (só ele faz `POST /api/pair`) e os avisos a mostrar. Esta chave leva
 * os dois para a carga seguinte, que a lê UMA vez e a apaga.
 */
export const PENDING_KEY = 'agent-remote-pending'

/** Aviso curto para mostrar depois do reload, na 1ª conexão bem-sucedida. */
export interface PendingNotice {
  tipo: ToastTipo
  text: string
}

/** O que trocar/adicionar uma filial deixa para a próxima carga da página — lido UMA vez. */
export interface PendingSwitch {
  /** Só vale se esta filial for a ativa na próxima carga. */
  pcId: string
  /** QR lido agora: a próxima carga faz POST /api/pair (toma o lugar de outro celular). */
  explicit: boolean
  notices: PendingNotice[]
}

export function setPendingSwitch(p: PendingSwitch): void {
  localStorage.setItem(PENDING_KEY, JSON.stringify(p))
}

/** Um aviso salvo → `PendingNotice`; null quando não dá para aproveitá-lo. */
function normalizeNotice(value: unknown): PendingNotice | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  if (r.tipo !== 'sucesso' && r.tipo !== 'erro' && r.tipo !== 'aviso') return null
  if (typeof r.text !== 'string' || !r.text) return null
  return { tipo: r.tipo, text: r.text }
}

/** Lê e APAGA o sinal (uso único). Ausente, corrompido ou com formato errado → null (e apagado). */
export function takePendingSwitch(): PendingSwitch | null {
  const raw = localStorage.getItem(PENDING_KEY)
  localStorage.removeItem(PENDING_KEY)
  let stored: unknown
  try {
    stored = JSON.parse(raw || 'null')
  } catch {
    return null
  }
  if (!stored || typeof stored !== 'object') return null
  const r = stored as Record<string, unknown>
  if (typeof r.pcId !== 'string' || !r.pcId) return null
  const notices = Array.isArray(r.notices) ? r.notices.map(normalizeNotice).filter((n): n is PendingNotice => n !== null) : []
  return { pcId: r.pcId, explicit: r.explicit === true, notices }
}
