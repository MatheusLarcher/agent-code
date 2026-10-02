/**
 * Quem está testando no projetor de cada sala — PURO (sem three, sem relógio
 * próprio: `now` vem de quem chama).
 *
 * Uma sala usa o projetor quando um agente dela chama ferramenta de navegador
 * (mcp__browser__*, mcp__chrome__*) ou de Android que mexe na tela do aparelho
 * (mcp__android__android_*, menos setup, build e as listas — só toolchain, nada
 * para mostrar). `scanDeviceUse` lê o turno atual de cada personagem (principal:
 * mensagens; subagente: a trilha) e diz a chamada mais recente, se ainda está
 * aberta, a última URL navegada (input do *_navigate) e o título (o resultado
 * do navigate: `Navegou para … — "Título" (aba: …)`).
 *
 * `ProjectorTracker` guarda, por sala, quem usou por último e QUANDO (a 1ª vez
 * que o feed mostrou aquela chamada; chamada aberta renova a cada feed): a tela
 * desce no uso e sobe PROJECTOR_IDLE_MS depois do último. No 1º feed (app
 * abrindo) o histórico não desce a tela — só quem está trabalhando agora.
 */
import type { OfficeFeed } from '../office/adapter/feed'
import type { OfficeCharacterModel } from '../office/adapter/model'
import type { UIMessage } from '../types'

export type DeviceKind = 'web' | 'android'

/** A tela sobe depois disto sem chamada nova de navegador/Android na sala. */
export const PROJECTOR_IDLE_MS = 90_000

const ANDROID_TOOLCHAIN = new Set(['android_setup', 'android_build_apk', 'android_list_devices', 'android_list_device_models'])

/** Navegador ('web'), Android com tela ('android') ou nada. */
export function deviceOf(toolName: string): DeviceKind | null {
  if (/^mcp__(browser|chrome)__/.test(toolName)) return 'web'
  const m = /^mcp__android__(android_\w+)$/.exec(toolName)
  return m && !ANDROID_TOOLCHAIN.has(m[1]) ? 'android' : null
}

/** O uso do projetor por UM agente: a chamada mais recente e o que mostrar. */
export interface DeviceUse {
  roomId: string
  convId: string
  /** Personagem (principal ou subagente). */
  key: string
  kind: DeviceKind
  /** Id da chamada mais recente: muda a cada chamada nova. */
  lastId: string
  /** A chamada mais recente ainda não voltou. */
  open: boolean
  /** O agente está trabalhando (ocupado / trilha rodando). */
  busy: boolean
  /** Última URL navegada e o título da página ('' sem navegação no turno). */
  url: string
  title: string
}

interface Call {
  id: string
  name: string
  input: unknown
  result?: string
  open: boolean
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const field = (input: unknown, key: string): string => str(input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined)

/** Título do resultado do navigate ("Navegou para URL — \"Título\" (aba: …)"); '' se não houver. */
export function titleFromResult(text: string | undefined): string {
  if (!text) return ''
  return /—\s*"([^"\n]*)"/.exec(text)?.[1] ?? /"title"\s*:\s*"([^"\n]*)"/i.exec(text)?.[1] ?? ''
}

/** As chamadas do turno, do fim para o começo, até o pedido do usuário. */
function* turnCalls(messages: readonly UIMessage[]): Generator<Call> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind === 'user') return
    if (m.kind === 'tool-use' && m.parentToolUseId == null) yield { id: m.id, name: m.name, input: m.input, result: m.result?.text, open: !m.result }
  }
}

function* stepCalls(feed: OfficeFeed, convId: string, trackId: string): Generator<Call> {
  const steps = feed.tracks[convId]?.[trackId]?.steps ?? []
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]
    yield { id: s.id, name: s.name, input: s.input, result: s.result, open: s.result === undefined && s.endedAt === undefined }
  }
}

/** O uso do agente (a partir das chamadas do fim para o começo); null sem navegador/Android no turno. */
function useOf(calls: Iterable<Call>, base: Pick<DeviceUse, 'roomId' | 'convId' | 'key' | 'busy'>): DeviceUse | null {
  let use: DeviceUse | null = null
  for (const c of calls) {
    const kind = deviceOf(c.name)
    if (!kind) continue
    if (!use) use = { ...base, kind, lastId: c.id, open: c.open, url: '', title: '' }
    if (!use.url && /_navigate$/.test(c.name) && field(c.input, 'url')) {
      use.url = field(c.input, 'url')
      use.title = titleFromResult(c.result)
    }
    if (!use.title && c.name.endsWith('android_install_run')) use.title = field(c.input, 'appName')
    if (use.url || (use.kind === 'android' && use.title)) break
  }
  return use
}

/** O uso de navegador/Android de cada personagem com sala (na ordem do modelo). */
export function scanDeviceUse(feed: OfficeFeed, characters: ReadonlyArray<Pick<OfficeCharacterModel, 'key' | 'convId' | 'roomId' | 'role' | 'trackId'>>): DeviceUse[] {
  const out: DeviceUse[] = []
  for (const ch of characters) {
    if (!ch.roomId) continue
    let use: DeviceUse | null = null
    if (ch.trackId) {
      const track = feed.tracks[ch.convId]?.[ch.trackId]
      use = useOf(stepCalls(feed, ch.convId, ch.trackId), { roomId: ch.roomId, convId: ch.convId, key: ch.key, busy: track?.status === 'running' })
    } else if (ch.role === 'principal') {
      const conv = feed.conversations.find((c) => c.id === ch.convId)
      if (conv) use = useOf(turnCalls(conv.messages), { roomId: ch.roomId, convId: ch.convId, key: ch.key, busy: feed.busyIds.has(ch.convId) })
    }
    if (use) out.push(use)
  }
  return out
}

export class ProjectorTracker {
  /** lastId → quando foi visto pela 1ª vez (ms; -Infinity = histórico do 1º feed). */
  private readonly seen = new Map<string, number>()
  private readonly rooms = new Map<string, { use: DeviceUse; at: number }>()
  private primed = false

  /** Feed novo: o uso mais recente de cada sala. */
  update(uses: readonly DeviceUse[], now: number): void {
    const ids = new Set<string>()
    for (const u of uses) {
      ids.add(u.lastId)
      let at = this.seen.get(u.lastId)
      if (at === undefined) at = this.primed || u.open || u.busy ? now : -Infinity
      if (u.open) at = now
      this.seen.set(u.lastId, at)
      // O mais recente manda; no empate (o mesmo uso, ou a mesma hora), o dado mais novo.
      const cur = this.rooms.get(u.roomId)
      if (!cur || at >= cur.at) this.rooms.set(u.roomId, { use: u, at })
    }
    for (const id of this.seen.keys()) if (!ids.has(id)) this.seen.delete(id)
    this.primed = true
  }

  /** A sala quer a tela abaixada agora. */
  down(roomId: string, now: number): boolean {
    const r = this.rooms.get(roomId)
    return !!r && now - r.at < PROJECTOR_IDLE_MS
  }

  /** Quem a sala mostra (o último que usou); null se ninguém usou. */
  use(roomId: string): DeviceUse | null {
    return this.rooms.get(roomId)?.use ?? null
  }

  /** Sala que saiu do escritório. */
  forget(roomId: string): void {
    this.rooms.delete(roomId)
  }
}
