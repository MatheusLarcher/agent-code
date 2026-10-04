/**
 * O chamado do agente (app_chamar_usuario) tirado das mensagens — PURO (o
 * relógio e as marcas vêm de quem chama).
 *
 * Um chamado é a chamada da ferramenta que deu certo (o handler validou o
 * arquivo). Fica aberto até:
 *   respondido  o usuário mandou mensagem na conversa depois dele;
 *   aberto      o usuário abriu o mockup na TV (marca em CallMarks);
 *   cancelado   a conversa saiu do escritório, o arquivo sumiu (marca) ou o
 *               mesmo agente chamou de novo (vale o último).
 * Quem chama é sempre o principal da conversa (o subagente chama por ele: os
 * personagens de subagente vêm e vão).
 *
 *   openCalls(feed, now, ended)  os chamados abertos, um por conversa
 *   CallQueue                    a ordem de chegada (o 1º fica ao lado da TV)
 */
import { isCentralConversation } from '@shared/central'
import { OFFICE_CALL_TOOL, type OfficeCallEnd } from '@shared/officeCall'
import type { OfficeFeed } from '../office/adapter/feed'
import { isInOffice, principalKey } from '../office/adapter/model'

/** Quantas mensagens do fim olhar (o chamado aberto vem depois da última mensagem do usuário). */
const SCAN_BACK = 400

export interface OfficeCall {
  /** O id da chamada da ferramenta. */
  id: string
  convId: string
  /** O personagem que chama (o principal da conversa). */
  key: string
  cwd: string
  /** Caminho absoluto do HTML. */
  path: string
  mensagem: string | null
}

type CallFeed = Pick<OfficeFeed, 'conversations' | 'tracks' | 'activeId' | 'busyIds' | 'permissions' | 'vigiaAlerts'>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** O caminho do arquivo do chamado, absoluto (relativo resolve no cwd). */
export function callPath(arquivo: string, cwd: string): string {
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(arquivo)) return arquivo
  const sep = cwd.includes('\\') ? '\\' : '/'
  return cwd.replace(/[\\/]+$/, '') + sep + arquivo.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep)
}

function callOf(id: string, input: unknown, convId: string, cwd: string): OfficeCall | null {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const arquivo = str(o.arquivo).trim()
  if (!arquivo) return null
  const mensagem = str(o.mensagem).trim()
  return { id, convId, key: principalKey(convId), cwd, path: callPath(arquivo, cwd), mensagem: mensagem || null }
}

/** Os chamados abertos (um por conversa: o mais recente), na ordem das conversas. */
export function openCalls(feed: CallFeed, now: number, ended: (id: string) => boolean): OfficeCall[] {
  const out: OfficeCall[] = []
  for (const c of feed.conversations) {
    if (!c.cwd || isCentralConversation(c) || !isInOffice(c, feed as OfficeFeed, now)) continue
    const msgs = c.messages
    // Do fim até a última mensagem do usuário: o que veio antes já foi respondido.
    let found: { call: OfficeCall; at: number } | null = null
    const taskAt = new Map<string, number>()
    let i = msgs.length - 1
    for (let n = 0; i >= 0 && n < SCAN_BACK; i--, n++) {
      const m = msgs[i]
      if (m.kind === 'user') break
      if (m.kind !== 'tool-use') continue
      taskAt.set(m.id, i)
      if (!found && m.name === OFFICE_CALL_TOOL && m.parentToolUseId == null && m.result && !m.result.isError) {
        const call = callOf(m.id, m.input, c.id, c.cwd)
        if (call) found = { call, at: i }
      }
    }
    // Subagentes desta leva (o Task depois da última mensagem do usuário).
    for (const t of Object.values(feed.tracks[c.id] ?? {})) {
      const at = taskAt.get(t.id)
      if (at === undefined || (found && at < found.at)) continue
      for (let k = t.steps.length - 1; k >= 0; k--) {
        const s = t.steps[k]
        if (s.name !== OFFICE_CALL_TOOL || s.result === undefined || s.isError) continue
        const call = callOf(s.id, s.input, c.id, c.cwd)
        if (call) found = { call, at }
        break
      }
    }
    if (found && !ended(found.call.id)) out.push(found.call)
  }
  return out
}

/** A ordem de chegada dos chamados: quem chamou primeiro fica ao lado da TV. */
export class CallQueue {
  private readonly since = new Map<string, number>()

  /** Os chamados abertos agora, do mais antigo ao mais novo (a 1ª vez que apareceram). */
  order(calls: readonly OfficeCall[], now: number): OfficeCall[] {
    const ids = new Set(calls.map((c) => c.id))
    for (const id of this.since.keys()) if (!ids.has(id)) this.since.delete(id)
    for (const c of calls) if (!this.since.has(c.id)) this.since.set(c.id, now)
    return [...calls].sort((a, b) => this.since.get(a.id)! - this.since.get(b.id)!)
  }

  sinceOf(id: string): number | null {
    return this.since.get(id) ?? null
  }
}

/** Marcas que só a interface sabe (abriu na TV, o arquivo sumiu); guardadas entre recargas. */
export class CallMarks {
  private readonly ends = new Map<string, OfficeCallEnd>()
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null,
    private readonly key = 'agent-code.office.callMarks'
  ) {
    try {
      const raw = storage?.getItem(key)
      const list = raw ? (JSON.parse(raw) as Array<[string, OfficeCallEnd]>) : []
      for (const [id, end] of list) if (typeof id === 'string' && (end === 'aberto' || end === 'cancelado')) this.ends.set(id, end)
    } catch {
      /* marca corrompida: começa limpa */
    }
  }

  /** Marca o fim do chamado (o mesmo id não volta). */
  end(id: string, motivo: OfficeCallEnd): void {
    if (this.ends.has(id)) return
    this.ends.set(id, motivo)
    // Guarda só as últimas 300.
    const list = [...this.ends].slice(-300)
    try {
      this.storage?.setItem(this.key, JSON.stringify(list))
    } catch {
      /* sem armazenamento: vale até recarregar */
    }
    for (const l of this.listeners) l()
  }

  ended(id: string): boolean {
    return this.ends.has(id)
  }

  /** Por que acabou (aberto / cancelado); null sem marca. */
  reason(id: string): OfficeCallEnd | null {
    return this.ends.get(id) ?? null
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

/** As marcas do app (uma só, compartilhada entre a aba e o escritório). */
export const callMarks = new CallMarks(typeof localStorage === 'undefined' ? null : localStorage)
