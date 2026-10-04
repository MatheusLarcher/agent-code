/**
 * O que o monitor vista de longe mostra no jeito do VS Code — PURO (sem React,
 * sem DOM). As abas vêm do mesmo buildTabs do app Código (codeModel.ts): os
 * arquivos que o agente escreveu, do mais recente ao mais antigo. O editor
 * mostra o texto da última edição da aba ativa (o trecho novo do Edit, o
 * conteúdo do Write), só as primeiras CODE_LINES linhas.
 */
import type { OfficeFeed } from '../office/adapter/feed'
import type { OfficeCharacterModel } from '../office/adapter/model'
import type { UIMessage } from '../types'
import { lookupOf, trackMessages, trackOf } from './chatPage'
import { buildTabs, type CodeTab } from './codeScreen/codeModel'

/** Linhas de código guardadas (cabem ~14 no editor). */
export const CODE_LINES = 16
/** Arquivos no explorador (cabem ~9). */
export const CODE_FILES = 9
/** Largura máxima guardada de cada linha (o editor corta antes). */
const LINE_MAX = 120

export interface CodeFile {
  name: string
  status: 'U' | 'M'
}

export interface CodePage {
  /** Os arquivos tocados (o primeiro é a aba ativa). */
  files: CodeFile[]
  /** O texto da última edição da aba ativa, por linha. */
  code: string[]
  /** Linha (1-based) onde o trecho começa no editor — só decorativo. */
  firstLine: number
  /** A edição ainda sem resultado: o cursor pisca no fim. */
  pending: boolean
}

function editText(tab: CodeTab): string {
  const e = tab.edits[tab.edits.length - 1]
  if (!e) return ''
  return e.kind === 'write' ? e.content : e.kind === 'edit' ? e.new : e.source
}

/** Onde o trecho novo começa no arquivo, quando o conteúdo de antes é conhecido. */
function startLine(tab: CodeTab): number {
  const e = tab.edits[tab.edits.length - 1]
  if (!e || e.kind !== 'edit' || !tab.base || !e.old) return 1
  const at = tab.base.indexOf(e.old)
  return at < 0 ? 1 : tab.base.slice(0, at).split('\n').length
}

function sourceOf(feed: OfficeFeed | null, model: OfficeCharacterModel): readonly UIMessage[] {
  const info = lookupOf(model)
  const track = trackOf(feed, info)
  if (track) return trackMessages(track)
  if (model.role !== 'principal') return []
  return feed?.conversations.find((c) => c.id === model.convId)?.messages ?? []
}

export function codePageFrom(msgs: readonly UIMessage[]): CodePage {
  const tabs = buildTabs(msgs)
  const active = tabs[0]
  const code = active
    ? editText(active).replace(/\t/g, '  ').split('\n').slice(0, CODE_LINES).map((l) => (l.length > LINE_MAX ? l.slice(0, LINE_MAX) : l))
    : []
  return {
    files: tabs.slice(0, CODE_FILES).map((t) => ({ name: t.name, status: t.status })),
    code,
    firstLine: active ? startLine(active) : 1,
    pending: !!active?.pending
  }
}

/** A janela VS Code do personagem (subagente: a trilha dele; observador: vazia). */
export function codePageFor(feed: OfficeFeed | null, model: OfficeCharacterModel): CodePage {
  return codePageFrom(sourceOf(feed, model))
}
