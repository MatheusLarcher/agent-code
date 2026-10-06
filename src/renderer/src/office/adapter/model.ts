/**
 * deriveOfficeModel: feed do App → modelo do escritório (salas + personagens).
 * Pura: mesma entrada, mesmo modelo. Quem desenha é o Escritório 3D
 * (office3d/layout.ts e a cena).
 *
 * Custo: O(conversas + trilhas + passos recentes). messages é lido só no turno
 * atual (scanTurn), do fim para o começo.
 */
import { isCentralConversation } from '@shared/central'
import { contextLimitFor, type MemoristaProviderDiagnosticMsg } from '@shared/ipc'
import type { AgentTrack } from '../../agentTracks'
import { buildCrew, callSegments, lineText, roleFromSubagentType, type CrewMember, type CrewRole } from '../../crew'
import type { Conversation } from '../../types'
import type { OfficeFeed } from './feed'
import type { Activity, BubbleKind, DestinationRole, SeatKind } from './kinds'
import { activityFor, scanTurn } from './turn'

/** Conversa parada há mais que isto sai do escritório (decisão de 01/10/2026). */
export const RECENT_MS = 12 * 60 * 60 * 1000
/** Quanto tempo o balão "ok" fica depois do fim do turno. */
export const OK_BUBBLE_MS = 2000

export type Placement =
  | { kind: 'seat'; seatKind: SeatKind; slot?: string }
  /** Sem mesa: entra e anda até o destino (PO no kanban, memória no arquivo). */
  | { kind: 'destination'; papel: DestinationRole; seatKind?: SeatKind; slot?: string }
  /** Subagente do motor, ao lado do personagem `parentKey`. */
  | { kind: 'beside'; parentKey: string }

export interface OfficeCharacterModel {
  key: string
  convId: string
  /** Sala (o projeto) do personagem; null = sem projeto (a Central). */
  roomId: string | null
  role: CrewRole
  trackId?: string
  placement: Placement
  /** Seed da aparência: estável por conversa ou trilha. */
  seed: string
  active: boolean
  activity: Activity
  bubble: BubbleKind | null
  label: string
  context?: { tokens: number; max: number }
  /** Fora de cena: o Manager de um plano já enviado para implementação (foi para o PC; continua no escritório só para a TV). */
  offstage?: boolean
  /** Ao nascer, continua do lugar deste personagem: a 1ª implementação de um plano levanta da cabeceira do Manager. */
  handoverFrom?: string
}

/** Quem é um personagem, para achar a ferramenta dele no feed (a tela do monitor). */
export type LookupInfo = Pick<OfficeCharacterModel, 'key' | 'convId' | 'role' | 'trackId'>

export interface OfficeRoomModel {
  id: string
  /** cwd original (primeiro visto). */
  projectKey: string
  name: string
  icon: string | null
  principals: number
}

export interface OfficeModel {
  rooms: OfficeRoomModel[]
  /** Pais antes dos filhos ('beside' sempre depois do parentKey). */
  characters: OfficeCharacterModel[]
}

/** cwd → id da sala: barras unificadas, sem barra final, minúsculo em caminho Windows. */
export function roomIdFor(cwd: string): string {
  let id = cwd.replace(/[\\/]+/g, '/')
  if (id.length > 1) id = id.replace(/\/$/, '')
  const windows = /^[a-zA-Z]:/.test(cwd) || cwd.includes('\\')
  return windows ? id.toLowerCase() : id
}

/** Chave do principal da conversa na cena — também a seed da aparência dele (a camisa). */
export function principalKey(convId: string): string {
  return `conv:${convId}`
}

/** Último segmento do cwd, como basename em App.tsx. */
export function roomName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] || cwd
}

/** Quem entra no escritório: ativa, ocupada, com pendência ou mexida nas últimas 12 h. */
export function isInOffice(c: Conversation, feed: OfficeFeed, now: number): boolean {
  return (
    c.id === feed.activeId ||
    feed.busyIds.has(c.id) ||
    feed.permissions[c.id] !== undefined ||
    feed.vigiaAlerts[c.id] !== undefined ||
    now - c.updatedAt <= RECENT_MS
  )
}

/** Rótulo de uma trilha isolada: o mesmo CrewMember que o cartão da Equipe mostraria. */
function trackLabel(track: AgentTrack, now: number): string {
  const crew = buildCrew({ tracks: { [track.id]: track }, busy: false, busySince: null, vigia: null, po: null, poEnabled: false, vigiaEnabled: false, now })
  const m = crew.find((x) => x.id === `track:${track.id}`) ?? crew.find((x) => x.role === roleFromSubagentType(track.subagentType))
  return m ? lineText(m.line) : ''
}

function trackActivity(track: AgentTrack): Activity {
  if (track.status !== 'running') return null
  return activityFor(track.steps[track.steps.length - 1]?.name)
}

function principalOf(c: Conversation, feed: OfficeFeed, roomId: string, crew: CrewMember[], now: number): OfficeCharacterModel {
  const busy = feed.busyIds.has(c.id)
  const turn = scanTurn(c.messages)
  const tool = busy ? turn.tool : null
  const perm = feed.permissions[c.id]
  let bubble: BubbleKind | null = null
  if (perm && !perm.questions) bubble = 'permissao'
  else if (perm?.questions || feed.vigiaAlerts[c.id]) bubble = 'pergunta'
  else if (turn.error && !busy) bubble = 'erro'
  else if (feed.stalledSince[c.id] !== undefined) bubble = 'ampulheta'
  else if (!busy && turn.okAt !== null && now - turn.okAt < OK_BUBBLE_MS) bubble = 'ok'
  let label: string
  if (tool) {
    const detail = lineText(callSegments(tool.name, tool.input))
    label = detail ? `${tool.name} ${detail}` : tool.name
  } else {
    label = lineText(crew.find((m) => m.role === 'principal')?.line ?? [])
  }
  const key = principalKey(c.id)
  const model: OfficeCharacterModel = {
    key,
    convId: c.id,
    roomId,
    role: 'principal',
    placement: { kind: 'seat', seatKind: 'principal' },
    seed: key,
    active: busy,
    activity: activityFor(tool?.name),
    bubble,
    label
  }
  if (c.tokens?.context > 0) model.context = { tokens: c.tokens.context, max: contextLimitFor(c.autoModel ?? c.model) }
  return model
}

interface RoomAcc {
  room: OfficeRoomModel
  convs: Conversation[]
}

/**
 * Plano × implementação. O "Enviar para implementação" cria uma conversa nova
 * com `handoffPlan` (as antigas, só `handoffSlug`) apontando para o plano. A
 * conversa de planejamento que já existia quando uma implementação nasceu foi
 * ENVIADA: o planejamento dela não está mais aberto — e a sala de reunião é só
 * para planejamento aberto. A primeira implementação depois dela é o mesmo
 * agente (a aparência do Manager vai junto para o PC). Plano reaberto depois
 * (conversa nova do mesmo plano, sem implementação mais nova) volta a ser aberto.
 */
export interface PlanHandoffs {
  /** Conversas de planejamento cujo plano já foi enviado para implementação. */
  sent: Set<string>
  /** Conversa de implementação → a de planejamento cujo Manager ela continua. */
  managerOf: Map<string, string>
}

export function planHandoffs(conversations: readonly Conversation[]): PlanHandoffs {
  const out: PlanHandoffs = { sent: new Set(), managerOf: new Map() }
  const plans = new Map<string, { planners: Conversation[]; impls: Conversation[] }>()
  const entry = (cwd: string, slug: string): { planners: Conversation[]; impls: Conversation[] } => {
    const k = `${roomIdFor(cwd)}\u0000${slug}`
    let e = plans.get(k)
    if (!e) plans.set(k, (e = { planners: [], impls: [] }))
    return e
  }
  for (const c of conversations) {
    if (c.mode === 'planning') {
      if (c.planningSlug && c.cwd) entry(c.cwd, c.planningSlug).planners.push(c)
      continue
    }
    const slug = c.handoffPlan?.slug ?? c.handoffSlug
    const cwd = c.handoffPlan?.projectCwd ?? c.cwd
    if (slug && cwd) entry(cwd, slug).impls.push(c)
  }
  for (const { planners, impls } of plans.values()) {
    impls.sort((a, b) => a.createdAt - b.createdAt)
    // A mais nova primeiro: duas conversas do plano antes do mesmo envio — a implementação continua a que enviou.
    for (const p of [...planners].sort((a, b) => b.createdAt - a.createdAt)) {
      const impl = impls.find((i) => i.createdAt >= p.createdAt)
      if (!impl) continue
      out.sent.add(p.id)
      if (!out.managerOf.has(impl.id)) out.managerOf.set(impl.id, p.id)
    }
  }
  return out
}

const SEATED_SPECIALISTS: CrewRole[] = ['executor', 'critico', 'navegador-de-codigo']

/**
 * `boardRooms`: salas cujo Quadro tem cartões (o Escritório 3D). Com o PO ligado
 * ele aparece nelas sempre — não só depois de rodar uma vez — para levar os
 * papéis ao quadro.
 */
export function deriveOfficeModel(feed: OfficeFeed, now: number, boardRooms?: ReadonlySet<string>): OfficeModel {
  const rooms = new Map<string, RoomAcc>()
  let central: OfficeCharacterModel | null = null
  for (const c of feed.conversations) {
    if (!isInOffice(c, feed, now)) continue
    // A Central não é projeto: um personagem só, no console do centro (sem sala nem mesa).
    if (isCentralConversation(c)) {
      central = centralOf(c, feed, now)
      continue
    }
    // Conversa sem pasta não vira sala de projeto.
    if (!c.cwd) continue
    const id = roomIdFor(c.cwd)
    let acc = rooms.get(id)
    if (!acc) {
      acc = { room: { id, projectKey: c.cwd, name: roomName(c.cwd), icon: feed.projectIcons[c.cwd] ?? null, principals: 0 }, convs: [] }
      rooms.set(id, acc)
    }
    acc.room.principals++
    acc.convs.push(c)
  }

  const characters: OfficeCharacterModel[] = []
  const later: OfficeCharacterModel[] = []
  const handoffs = planHandoffs(feed.conversations)
  for (const { room, convs } of rooms.values()) {
    const byRole = new Map<CrewRole, Array<{ track: AgentTrack; convId: string }>>()
    let po: { convId: string; at: number } | null = null
    for (const c of convs) {
      const tracks = feed.tracks[c.id] ?? {}
      const crew = buildCrew({
        tracks,
        busy: feed.busyIds.has(c.id),
        busySince: feed.busySince[c.id] ?? null,
        vigia: null,
        po: null,
        poEnabled: false,
        vigiaEnabled: false,
        now
      })
      const principal = principalOf(c, feed, room.id, crew, now)
      // O Agent Manager (planejamento) não ocupa mesa de ilha: senta à cabeceira da mesa da sala de reunião.
      if (c.mode === 'planning') principal.placement = { kind: 'destination', papel: 'reuniao-cabeceira' }
      // Plano enviado: o Manager sai da sala de reunião (o corpo dele foi para o PC da implementação).
      if (handoffs.sent.has(c.id)) principal.offstage = true
      // A 1ª implementação do plano é o mesmo agente: a aparência do Manager e, ao nascer, o lugar dele na cabeceira.
      const manager = handoffs.managerOf.get(c.id)
      if (manager) Object.assign(principal, { seed: principalKey(manager), handoverFrom: principalKey(manager) })
      characters.push(principal)
      for (const track of Object.values(tracks)) {
        const role = roleFromSubagentType(track.subagentType)
        if (role === 'subagente') {
          // Genérico: nasce ao lado do principal e sai no fim da trilha.
          if (track.status !== 'running') continue
          later.push(trackChar(track, c.id, room.id, 'subagente', { kind: 'beside', parentKey: principal.key }, now))
          continue
        }
        const list = byRole.get(role) ?? []
        list.push({ track, convId: c.id })
        byRole.set(role, list)
      }
      const vigia = feed.vigiaAlerts[c.id]
      if (vigia) {
        later.push({
          key: `vigia:${c.id}`,
          convId: c.id,
          roomId: room.id,
          role: 'vigia',
          placement: { kind: 'beside', parentKey: principal.key },
          seed: `vigia:${c.id}`,
          active: false,
          activity: null,
          bubble: 'pergunta',
          label: '1 dúvida esperando você'
        })
      }
      const diag = feed.poDiagnostics[c.id]
      if (diag && (!po || diag.at > po.at)) po = { convId: c.id, at: diag.at }
    }

    for (const role of SEATED_SPECIALISTS) {
      const list = byRole.get(role)
      if (!list) continue
      const running = list.filter((x) => x.track.status === 'running').sort((a, b) => b.track.startedAt - a.track.startedAt)
      const pool = running.length > 0 ? running : [...list].sort((a, b) => b.track.startedAt - a.track.startedAt).slice(0, 1)
      const mainKey = `role:${room.id}:${role}`
      pool.forEach((x, i) => {
        if (i === 0) characters.push(trackChar(x.track, x.convId, room.id, role, { kind: 'seat', seatKind: 'especialista', slot: role }, now, mainKey))
        else if (i === 1) characters.push(trackChar(x.track, x.convId, room.id, role, { kind: 'seat', seatKind: 'especialista', slot: 'reforco' }, now, `${mainKey}:reforco`))
        else later.push(trackChar(x.track, x.convId, room.id, role, { kind: 'beside', parentKey: mainKey }, now))
      })
    }
    const mem = byRole.get('memoria')
    if (mem) {
      // A trilha rodando mais recente manda; sem nenhuma rodando, a mais recente.
      const sorted = [...mem].sort((a, b) => b.track.startedAt - a.track.startedAt)
      const pick = sorted.find((y) => y.track.status === 'running') ?? sorted[0]
      characters.push(trackChar(pick.track, pick.convId, room.id, 'memoria', { kind: 'destination', papel: 'arquivo-memorias' }, now, `role:${room.id}:memoria`))
    } else if (feed.observersOn.memorista) {
      // Sem delegação de memória: o memorista (observador do main) acende o
      // mesmo papel, na estante de Memórias.
      const diag = latestMemorista(feed, convs)
      if (diag) characters.push(memoristaChar(diag, room.id, now))
    }
    if (feed.observersOn.po && !po && boardRooms?.has(room.id) && convs.length > 0) po = { convId: convs[0].id, at: 0 }
    if (feed.observersOn.po && po) {
      const diag = feed.poDiagnostics[po.convId]
      const crew = buildCrew({ tracks: {}, busy: false, busySince: null, vigia: null, po: diag ?? null, poEnabled: true, vigiaEnabled: false, now })
      const member = crew.find((m) => m.role === 'po')
      characters.push({
        key: `po:${room.id}`,
        convId: po.convId,
        roomId: room.id,
        role: 'po',
        placement: { kind: 'destination', papel: 'kanban', seatKind: 'reuniao', slot: 'cabeceira' },
        seed: `po:${room.id}`,
        active: member?.state === 'working',
        activity: null,
        bubble: null,
        label: member ? lineText(member.line) : ''
      })
    }
  }
  return { rooms: [...rooms.values()].map((r) => r.room), characters: [...(central ? [central] : []), ...characters, ...later] }
}

/** O personagem da Central: o estado de um principal, sem sala (filtro nenhum o tira) e com destino no console. */
function centralOf(c: Conversation, feed: OfficeFeed, now: number): OfficeCharacterModel {
  const crew = buildCrew({ tracks: {}, busy: feed.busyIds.has(c.id), busySince: feed.busySince[c.id] ?? null, vigia: null, po: null, poEnabled: false, vigiaEnabled: false, now })
  return { ...principalOf(c, feed, '', crew, now), roomId: null, placement: { kind: 'destination', papel: 'central' } }
}

function latestMemorista(feed: OfficeFeed, convs: Conversation[]): MemoristaProviderDiagnosticMsg | null {
  let best: MemoristaProviderDiagnosticMsg | null = null
  for (const c of convs) {
    const d = feed.memoristaDiagnostics[c.id]
    if (d && (!best || d.at > best.at)) best = d
  }
  return best
}

function memoristaChar(diag: MemoristaProviderDiagnosticMsg, roomId: string, now: number): OfficeCharacterModel {
  const crew = buildCrew({ tracks: {}, busy: false, busySince: null, vigia: null, po: null, memorista: diag, memoristaEnabled: true, poEnabled: false, vigiaEnabled: false, now })
  const member = crew.find((m) => m.role === 'memoria')
  return {
    key: `role:${roomId}:memoria`,
    convId: diag.conversationId,
    roomId,
    role: 'memoria',
    placement: { kind: 'destination', papel: 'arquivo-memorias' },
    seed: `memorista:${roomId}`,
    active: member?.state === 'working',
    activity: null,
    bubble: null,
    label: member ? lineText(member.line) : ''
  }
}

function trackChar(
  track: AgentTrack,
  convId: string,
  roomId: string | null,
  role: CrewRole,
  placement: Placement,
  now: number,
  key = `track:${track.id}`
): OfficeCharacterModel {
  return {
    key,
    convId,
    roomId,
    role,
    trackId: track.id,
    placement,
    seed: `track:${track.id}`,
    active: track.status === 'running',
    activity: trackActivity(track),
    bubble: track.status === 'error' ? 'erro' : null,
    label: trackLabel(track, now)
  }
}
