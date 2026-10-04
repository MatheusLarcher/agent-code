/**
 * O turno do agente no formato do chat — PURO (sem React, sem DOM). É a fonte
 * das três telas do Escritório 3D: o monitor (textura), a prévia do hover e a
 * tela focada do clique.
 *
 *   turnMessages(feed, info)   as UIMessage do turno atual, como o chat as guarda:
 *                              principal = do último pedido do usuário até o fim
 *                              (só o que o chat desenha); subagente = a trilha
 *                              (TrackStep) virando mensagens do mesmo tipo — o
 *                              pedido é a tarefa que ele recebeu e cada passo um
 *                              tool-use com o resultado; observador = nenhuma.
 *   liveToolMessage(delta)     o código ao vivo (liveInput) como o tool-use que vai chegar.
 *   chatPageFor(feed, model)   o resumo que o monitor desenha: o título e as
 *                              últimas linhas — pedido, narração, resposta e cada
 *                              ferramenta com os MESMOS rótulos do cartão do chat
 *                              (describeTool, toolBadge, toolErrored).
 *
 * Custo: O(mensagens do turno), lido do fim para o começo; nada do histórico.
 */
import { parseDownloads } from '@shared/ipc'
import { readableMediaText } from '@shared/inlineMedia'
import type { AgentTrack } from '../agentTracks'
import { describeTool, toolBadge, toolErrored, type ToolBadge } from '../components/toolDescribe'
import type { OfficeFeed } from '../office/adapter/feed'
import { roomName, type LookupInfo, type OfficeCharacterModel } from '../office/adapter/model'
import type { ToolInputDelta } from '../office/liveInput'
import type { UIMessage } from '../types'
import { whoLabel } from './quips/format'

export type ToolUseMessage = Extract<UIMessage, { kind: 'tool-use' }>

/** Uma linha do chat encolhido (a textura do monitor). */
export type ChatLine =
  | { kind: 'user' | 'narration' | 'answer' | 'thinking'; text: string }
  | { kind: 'note'; text: string; err: boolean }
  | { kind: 'tool'; verb: string; detail: string; added: number; removed: number; badge: ToolBadge; err: boolean; skill: boolean }

export interface ChatPage {
  /** Título da conversa (ou a tarefa do subagente). */
  title: string
  /** Do mais antigo ao mais novo — o mais novo embaixo, como no chat. */
  lines: ChatLine[]
  /** Trabalhando agora: o "digitando" do chat no fim. */
  busy: boolean
}

/** Linhas que o monitor guarda (cabem ~6 na tela; as de cima saem cortadas, como num chat rolado). */
export const PAGE_LINES = 8
/** Texto de cada linha: o monitor mostra 2–3 linhas, isto sobra. */
const TEXT_MAX = 220
/** Turno sem pedido do usuário à vista: lê no máximo isto do fim. */
const SCAN_MAX = 400

/** O que o chat desenha (o resto — result, eventos internos — o ChatRow devolve null). */
const SHOWN = new Set<UIMessage['kind']>(['user', 'assistant-text', 'thinking', 'tool-use', 'system', 'provider-switch', 'account-switch', 'status', 'error'])

export function lookupOf(model: Pick<OfficeCharacterModel, 'key' | 'convId' | 'role' | 'trackId'>): LookupInfo {
  return { key: model.key, convId: model.convId, role: model.role, trackId: model.trackId }
}

export function trackOf(feed: OfficeFeed | null, info: LookupInfo | undefined): AgentTrack | undefined {
  return feed && info?.trackId ? feed.tracks[info.convId]?.[info.trackId] : undefined
}

/**
 * A trilha do subagente no formato do chat: a tarefa como pedido e cada passo
 * como tool-use. É o chat DELE — ali ele é o agente principal (parentToolUseId null).
 */
export function trackMessages(track: AgentTrack): UIMessage[] {
  const out: UIMessage[] = [{ kind: 'user', id: `${track.id}:tarefa`, text: track.label }]
  for (const s of track.steps) {
    const done = s.result !== undefined || s.endedAt !== undefined
    out.push({
      kind: 'tool-use', id: s.id, name: s.name, input: s.input, parentToolUseId: null,
      ...(s.model ? { model: s.model } : {}),
      ...(done ? { result: { isError: !!s.isError, text: s.result ?? '' } } : {})
    })
  }
  if (track.status !== 'running') out.push({ kind: 'status', id: `${track.id}:fim`, text: track.status === 'error' ? 'Terminou com erro.' : 'Tarefa concluída.' })
  return out
}

const shown = (m: UIMessage): boolean => SHOWN.has(m.kind) && !(m.kind === 'tool-use' && m.parentToolUseId != null)

/** As mensagens de onde o turno sai e onde ele começa (a última do usuário; no máximo SCAN_MAX para trás). */
function turnSource(feed: OfficeFeed | null, info: LookupInfo | undefined): { msgs: readonly UIMessage[]; start: number } {
  const none = { msgs: [], start: 0 }
  if (!feed || !info) return none
  if (info.trackId) {
    const track = trackOf(feed, info)
    return track ? { msgs: trackMessages(track), start: 0 } : none
  }
  const conv = info.role === 'principal' ? feed.conversations.find((c) => c.id === info.convId) : undefined
  if (!conv) return none
  const msgs = conv.messages
  const floor = Math.max(0, msgs.length - SCAN_MAX)
  let start = msgs.length - 1
  while (start > floor && msgs[start].kind !== 'user') start--
  return { msgs, start: Math.max(floor, start) }
}

/** As mensagens do turno atual do personagem (ver o topo). */
export function turnMessages(feed: OfficeFeed | null, info: LookupInfo | undefined): UIMessage[] {
  const { msgs, start } = turnSource(feed, info)
  return msgs.slice(start).filter(shown)
}

/**
 * Código ao vivo do principal como o cartão que ainda vai chegar, com o nome REAL da ferramenta
 * (d.name) e o formato de input dela. O trecho antigo só entra quando já chegou no stream.
 */
export function liveToolMessage(d: ToolInputDelta): ToolUseMessage {
  const file_path = d.filePath ?? ''
  const pair = { ...(d.oldText !== undefined ? { old_string: d.oldText } : {}), new_string: d.newText }
  const input =
    d.name === 'Write' ? { file_path, content: d.newText }
    : d.name === 'MultiEdit' ? { file_path, edits: [pair] }
    : d.name === 'NotebookEdit' ? { notebook_path: file_path, new_source: d.newText }
    : { file_path, ...pair }
  return { kind: 'tool-use', id: d.toolUseId, name: d.name, input, parentToolUseId: null }
}

/** Markdown → texto corrido (o monitor não tem como mostrar a formatação). */
export function plainText(md: string): string {
  return md
    .replace(/```[^\n]*\n([\s\S]*?)(```|$)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const short = (text: string): string => (text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text)

/** A linha que a mensagem vira no monitor (null: o chat não a desenha). */
export function lineOf(m: UIMessage): ChatLine | null {
  switch (m.kind) {
    case 'user':
      return { kind: 'user', text: short(readableMediaText(m.text).replace(/\s+/g, ' ').trim()) }
    case 'assistant-text': {
      const text = short(plainText(parseDownloads(m.text).clean))
      return text ? { kind: m.answer ? 'answer' : 'narration', text } : null
    }
    case 'thinking':
      return { kind: 'thinking', text: short(m.text.replace(/\s+/g, ' ').trim()) }
    case 'tool-use': {
      const info = describeTool(m.name, m.input)
      return {
        kind: 'tool',
        verb: info.verb,
        detail: info.detail,
        added: info.stats?.added ?? 0,
        removed: info.stats?.removed ?? 0,
        badge: toolBadge(m.name, m.result),
        err: toolErrored(m.name, m.result),
        skill: info.isSkill
      }
    }
    case 'error':
      return { kind: 'note', text: short(m.text.split('\n')[0]), err: true }
    case 'system':
      return { kind: 'note', text: `Session ready · ${m.model}`, err: false }
    case 'provider-switch':
    case 'account-switch':
    case 'status':
      return { kind: 'note', text: short(m.text), err: false }
    default:
      return null
  }
}

/** Cabeçalho das telas do agente: título da conversa (ou a tarefa), quem é e se está trabalhando agora. */
export interface TurnHead {
  title: string
  /** Principal: o projeto; os outros: o papel ("executor", "explorador"…). */
  who: string
  busy: boolean
}

export function turnHead(feed: OfficeFeed | null, model: OfficeCharacterModel): TurnHead {
  const track = trackOf(feed, lookupOf(model))
  if (track) return { title: track.label, who: whoLabel(track.subagentType ?? model.role), busy: track.status === 'running' }
  const conv = feed?.conversations.find((c) => c.id === model.convId)
  const principal = model.role === 'principal'
  return {
    title: (principal ? conv?.title : model.label) || conv?.title || model.label,
    who: principal && conv ? roomName(conv.cwd) : whoLabel(model.role),
    busy: principal ? !!feed?.busyIds.has(model.convId) : model.active
  }
}

/** O chat encolhido do personagem: as últimas `max` linhas do turno, lidas do fim (sem nada, o rótulo dele). */
export function chatPageFor(feed: OfficeFeed | null, model: OfficeCharacterModel, max = PAGE_LINES): ChatPage {
  const info = lookupOf(model)
  const track = trackOf(feed, info)
  const conv = track ? undefined : feed?.conversations.find((c) => c.id === model.convId)
  const { msgs, start } = turnSource(feed, info)
  const lines: ChatLine[] = []
  for (let i = msgs.length - 1; i >= start && lines.length < max; i--) {
    const line = shown(msgs[i]) ? lineOf(msgs[i]) : null
    if (line) lines.push(line)
  }
  lines.reverse()
  if (lines.length === 0 && model.label) lines.push({ kind: 'note', text: short(model.label), err: false })
  return { title: track ? track.label : (conv?.title ?? ''), lines, busy: model.active }
}
