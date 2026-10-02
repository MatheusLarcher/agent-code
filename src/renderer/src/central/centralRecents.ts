/**
 * O que a Central sabe dos destinos, puro: os recentes que o decisor vê como
 * candidatos a "continua" (inclusive os turnos adotados — trabalho feito direto
 * numa conversa é assunto recente), as opções de heurística quando o IPC falha,
 * o destino de uma conversa e o rótulo "projeto · conversa" da tela.
 */
import { readableMediaText } from '@shared/inlineMedia'
import {
  CENTRAL_ID,
  type CentralEntry,
  type CentralOption,
  type CentralRecent,
  type CentralRequestEntry,
  type CentralTarget
} from '@shared/central'
import type { Conversation } from '../types'
import { isSandboxCwd } from '../sandbox/sandboxFlow'
import { centralColor } from './centralColor'
import { clip, replyOf } from './centralEntries'

/** Destinos recentes oferecidos ao decisor. */
export const MAX_RECENTS = 5
/** Corte dos textos de um recente (pedido e começo da resposta). */
export const RECENT_TEXT_CHARS = 200
/** Recentes que entram nas opções de heurística. */
const MAX_HEURISTIC_RECENTS = 3
/** Teto do texto do pedido de rota (o do IPC). */
const ROUTE_TEXT_MAX_CHARS = 20_000
/** O nome de projeto das conversas do sandbox (o mesmo do índice no main). */
export const SANDBOX_PROJECT = 'sandbox'

export type ConversationTarget = Extract<CentralTarget, { kind: 'conversation' }>

/** O rótulo de um destino na tela (contrato §E). */
export interface CentralLabel {
  project: string
  title: string
  color: string
  icon: string | null
  sandbox: boolean
}

function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] || cwd
}

/** A conversa como destino: projeto = nome da pasta (no sandbox, "sandbox"). */
export function conversationTarget(conv: Conversation, sandboxRoot: string): ConversationTarget {
  const sandbox = isSandboxCwd(sandboxRoot, conv.cwd)
  return {
    kind: 'conversation',
    convId: conv.id,
    cwd: conv.cwd,
    project: sandbox ? SANDBOX_PROJECT : folderName(conv.cwd),
    title: conv.title,
    sandbox
  }
}

/** O mesmo destino: conversa pelo id, conversa nova pela pasta, sandbox novo pelo tipo. */
export function sameTarget(a: CentralTarget, b: CentralTarget): boolean {
  if (a.kind === 'conversation') return b.kind === 'conversation' && a.convId === b.convId
  if (a.kind === 'new-conversation') return b.kind === 'new-conversation' && a.cwd === b.cwd
  return b.kind === 'new-sandbox'
}

const oneLine = (text: string): string => readableMediaText(text).replace(/\s+/g, ' ').trim()

/**
 * Até 5 destinos distintos, do mais recente para o mais antigo (a lista da
 * Central já está na ordem do tempo). `request` = o último texto que foi para
 * lá; `replyStart` = a resposta dele (ou o último comentário); pasta e título
 * quando a conversa está carregada.
 */
export function recentDestinations(
  entries: readonly CentralEntry[],
  convs: ReadonlyMap<string, Conversation>,
  max = MAX_RECENTS
): CentralRecent[] {
  const out: CentralRecent[] = []
  const seen = new Set<string>()
  for (let i = entries.length - 1; i >= 0 && out.length < max; i--) {
    const e = entries[i]
    if (e.kind !== 'request' || !e.anchor) continue
    const convId = e.anchor.convId
    if (convId === CENTRAL_ID || seen.has(convId)) continue
    seen.add(convId)
    const reply = replyOf(entries, e.id)
    const conv = convs.get(convId)
    out.push({
      convId,
      request: clip(oneLine(e.text), RECENT_TEXT_CHARS),
      replyStart: clip(oneLine(reply?.answer ?? reply?.notes.at(-1) ?? ''), RECENT_TEXT_CHARS),
      ...(conv ? { cwd: conv.cwd, title: conv.title } : {})
    })
  }
  return out
}

/**
 * "Para onde vai?" sem o decisor (IPC fora ou rejeitado): os recentes carregados
 * (até 3), conversa nova no projeto do último destino (fora do sandbox) e um
 * sandbox novo — menos o excluído.
 */
export function heuristicOptions(
  recents: readonly CentralRecent[],
  convs: ReadonlyMap<string, Conversation>,
  sandboxRoot: string,
  exclude?: CentralTarget
): CentralOption[] {
  const loaded = recents.flatMap((r) => {
    const conv = convs.get(r.convId)
    return conv ? [conversationTarget(conv, sandboxRoot)] : []
  })
  const targets: CentralTarget[] = loaded.slice(0, MAX_HEURISTIC_RECENTS)
  const last = loaded[0]
  if (last && !last.sandbox) targets.push({ kind: 'new-conversation', cwd: last.cwd, project: last.project })
  targets.push({ kind: 'new-sandbox' })
  return targets.filter((t) => !exclude || !sameTarget(t, exclude)).map((target) => ({ target }))
}

/** O texto que o decisor lê: legível (marcadores de mídia viram "[mídia N]"); só anexos = os nomes. */
export function routeText(text: string, attachments: readonly string[]): string {
  const readable = readableMediaText(text).trim()
  const fallback = attachments.length ? `[anexos: ${attachments.join(', ')}]` : '[mensagem sem texto]'
  return (readable || fallback).slice(0, ROUTE_TEXT_MAX_CHARS)
}

/** O último destino de conversa gravado na Central para esse id (conversa fora da tela). */
function storedTarget(entries: readonly CentralEntry[], convId: string): ConversationTarget | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const t = (entries[i] as CentralRequestEntry).route?.target
    if (entries[i].kind === 'request' && t?.kind === 'conversation' && t.convId === convId) return t
  }
  return undefined
}

/** Projeto · conversa · cor · ícone (o mesmo da barra lateral; sandbox sem ícone). */
export function labelFor(
  convId: string,
  convs: ReadonlyMap<string, Conversation>,
  entries: readonly CentralEntry[],
  projectIcons: Readonly<Record<string, string | null>>,
  sandboxRoot: string
): CentralLabel {
  const conv = convs.get(convId)
  const t = conv ? conversationTarget(conv, sandboxRoot) : storedTarget(entries, convId)
  const color = centralColor(convId)
  if (!t) return { project: '', title: 'conversa', color, icon: null, sandbox: false }
  return {
    project: t.project,
    title: t.title,
    color,
    icon: t.sandbox ? null : (projectIcons[t.cwd] ?? null),
    sandbox: t.sandbox
  }
}
