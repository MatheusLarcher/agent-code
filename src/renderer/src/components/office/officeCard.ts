/**
 * O que o hover e o cartão lateral mostram de um personagem: o MemberCard do
 * elenco (mesmo buildCrew do Quadro) e o título da conversa.
 */
import { buildCrew, roleName, type CrewMember } from '../../crew'
import type { LookupInfo } from '../../office/adapter/director'
import type { OfficeFeed } from '../../office/adapter/feed'

export interface CharacterInfo {
  name: string
  role: string
  convTitle: string
  member: CrewMember | null
}

export function memberFor(feed: OfficeFeed, info: LookupInfo, now: number): CrewMember | null {
  const tracks = feed.tracks[info.convId] ?? {}
  const crew = buildCrew({
    tracks,
    busy: feed.busyIds.has(info.convId),
    busySince: feed.busySince[info.convId] ?? null,
    vigia: feed.vigiaAlerts[info.convId] ? { at: feed.vigiaAt[info.convId] ?? now } : null,
    po: feed.poDiagnostics[info.convId] ?? null,
    memorista: feed.memoristaDiagnostics[info.convId] ?? null,
    poEnabled: feed.observersOn.po,
    vigiaEnabled: feed.observersOn.vigia,
    memoristaEnabled: feed.observersOn.memorista,
    now
  })
  const byRole = crew.filter((m) => m.role === info.role)
  if (info.trackId) {
    const track = tracks[info.trackId]
    const exact = byRole.find((m) => m.startedAt === track?.startedAt)
    if (exact) return exact
  }
  return byRole[0] ?? null
}

export function characterInfo(feed: OfficeFeed | null, info: LookupInfo | undefined, now: number): CharacterInfo | null {
  if (!feed || !info) return null
  const conv = feed.conversations.find((c) => c.id === info.convId)
  const member = memberFor(feed, info, now)
  return {
    name: member?.name ?? roleName(info.role),
    role: roleName(info.role),
    convTitle: conv?.title ?? '',
    member
  }
}
