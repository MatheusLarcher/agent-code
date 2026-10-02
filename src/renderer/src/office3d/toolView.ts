/**
 * Ferramenta atual → bloco no formato do cartão de ferramenta do chat
 * (MessageList: cabeçalho "verbo · arquivo · +a −r · status" e corpo com o
 * CodeBlock). O ToolCard/toolInputView do chat não são exportados, então aqui
 * fica só a tradução a partir do ScreenModel compartilhado (screenContent.ts);
 * o desenho do código é o mesmo CodeBlock do chat.
 */
import { extToLang } from '../components/CodeBlock'
import { screenModel, type CurrentTool } from '../components/office/screenContent'
import type { ToolInputDelta } from '../office/liveInput'
import { splitGutter } from './monitorTexture'

export interface ToolView {
  kind: string
  verb: string
  /** Nome do arquivo (ou detalhe curto). */
  detail: string
  /** Caminho completo, quando há arquivo para abrir. */
  path: string
  stats: { added: number; removed: number } | null
  caption: string
  language: string
  code: string
  result: string
  status: 'run' | 'ok' | 'live' | 'none'
}

/** Mesmos limites do cartão do chat (código 6000, resultado 2500). */
export const CODE_MAX = 6000
export const RESULT_MAX = 2500

const baseName = (p: string): string => p.split(/[\\/]/).pop() || p
const lineCount = (s: string): number => (s ? s.split('\n').length : 0)

function diffCode(hunks: Array<{ old: string; new: string }>): string {
  return hunks
    .map((h) => [...(h.old ? h.old.split('\n').map((l) => '- ' + l) : []), ...h.new.split('\n').map((l) => '+ ' + l)].join('\n'))
    .join('\n\n')
}

export const EMPTY_VIEW: ToolView = { kind: 'empty', verb: 'Tela', detail: '', path: '', stats: null, caption: '', language: '', code: '', result: '', status: 'none' }

export function toolView(tool: CurrentTool | null): ToolView {
  if (!tool) return EMPTY_VIEW
  const m = screenModel(tool)
  const status: ToolView['status'] = tool.open ? 'run' : 'ok'
  const base = { verb: tool.name.replace(/^mcp__[^_]+__/, ''), status, result: '' }
  switch (m.kind) {
    case 'diff': {
      const added = m.hunks.reduce((n, h) => n + lineCount(h.new), 0)
      const removed = m.hunks.reduce((n, h) => n + lineCount(h.old), 0)
      return { ...base, kind: 'diff', detail: baseName(m.path), path: m.path, stats: { added, removed }, caption: m.path, language: 'diff', code: diffCode(m.hunks).slice(0, CODE_MAX) }
    }
    case 'write':
      return { ...base, kind: 'write', detail: baseName(m.path), path: m.path, stats: { added: lineCount(m.text), removed: 0 }, caption: m.path, language: extToLang(m.path), code: m.text.slice(0, CODE_MAX) }
    case 'read': {
      // Conteúdo inteiro (rolável), sem a numeração do Read para o realce funcionar.
      const text = (tool.result ?? '')
        .split('\n')
        .map((l) => splitGutter(l).text)
        .join('\n')
      return { ...base, kind: 'read', detail: baseName(m.path), path: m.path, stats: null, caption: m.path, language: extToLang(m.path), code: text.slice(0, CODE_MAX) }
    }
    case 'bash':
      return { ...base, kind: 'bash', detail: m.command.split('\n')[0].slice(0, 64), path: '', stats: null, caption: String(tool.input.description ?? ''), language: 'bash', code: m.command, result: (tool.result ?? '').slice(-RESULT_MAX) }
    case 'grep':
      return { ...base, kind: 'grep', detail: m.pattern, path: '', stats: null, caption: m.path, language: '', code: '', result: (tool.result ?? '').slice(0, RESULT_MAX) }
    default:
      return { ...base, kind: 'other', detail: '', path: '', stats: null, caption: '', language: 'json', code: JSON.stringify(tool.input, null, 2).slice(0, CODE_MAX) }
  }
}

/** Código ao vivo (deltas do principal): diff quando há trecho antigo, senão escrita. */
export function liveView(ev: ToolInputDelta): ToolView {
  const path = ev.filePath ?? ''
  if (ev.oldText !== undefined) {
    const hunks = [{ old: ev.oldText, new: ev.newText }]
    return { kind: 'diff', verb: ev.name, detail: baseName(path), path, stats: { added: lineCount(ev.newText), removed: lineCount(ev.oldText) }, caption: path, language: 'diff', code: diffCode(hunks).slice(-CODE_MAX), result: '', status: 'live' }
  }
  return { kind: 'write', verb: ev.name, detail: baseName(path), path, stats: { added: lineCount(ev.newText), removed: 0 }, caption: path, language: extToLang(path), code: ev.newText.slice(-CODE_MAX), result: '', status: 'live' }
}
