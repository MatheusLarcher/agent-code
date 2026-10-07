/**
 * A ÚLTIMA AÇÃO do agente para o monitor visto de longe — PURO (sem React, sem DOM).
 *
 *   lastActionPage(msgs)   a ferramenta em curso ou a última concluída, lida do fim
 *                          (no máximo SCAN_MAX mensagens; a trilha de um subagente
 *                          dentro da conversa não conta, como em buildTabs):
 *     Edit/Write/…   → null: a tela fica no código (codePage.ts, como sempre);
 *     Read           → o trecho lido (do resultado), para a aba de leitura;
 *     Bash/PowerShell→ o comando e o fim da saída (terminal);
 *     Grep/Glob      → o padrão e as primeiras ocorrências;
 *     Web/navegador  → o endereço (o host) e o que está fazendo;
 *     Task/Agent     → para quem delegou e o quê.
 *   O resto (TodoWrite, Skill, memória…) não troca a tela: vale a ação de antes.
 *
 * Os grupos e resumos são os do app Código (actionsModel), a saída do terminal a
 * de codeModel, o trecho lido a de readView e os rótulos os do chat (toolDescribe).
 */
import { baseName, describeTool } from '../components/toolDescribe'
import type { UIMessage } from '../types'
import type { ToolUseMessage } from './chatPage'
import { groupOf, summarize } from './codeScreen/actionsModel'
import { cleanOutput, SCAN_MAX } from './codeScreen/codeModel'
import { parseReadResult, readFileView, readRange, readSummary, RESULT_CAP } from './codeScreen/readView'

/** Linhas do trecho lido guardadas (cabem ~14 no editor). */
export const READ_LINES = 16
/** Linhas do fim da saída no terminal. */
export const TERM_LINES = 10
/** Ocorrências da busca guardadas. */
export const HITS_MAX = 12
/** Largura máxima guardada de cada linha (o editor corta antes). */
const LINE_MAX = 120

interface ActionState {
  /** Ainda sem resultado (em curso). */
  pending: boolean
  error: boolean
}

export interface SearchHit {
  /** As duas últimas partes do caminho. */
  file: string
  line: number | null
  text: string
}

export type ActionPage = ActionState &
  (
    | { kind: 'read'; file: string; lines: string[]; firstLine: number; summary: string }
    | { kind: 'terminal'; shell: 'bash' | 'pwsh'; command: string; output: string[]; more: number }
    | { kind: 'search'; tool: string; pattern: string; where: string; hits: SearchHit[]; total: number }
    | { kind: 'web'; tool: string; url: string; host: string; doing: string; what: string }
    | { kind: 'delegate'; who: string; what: string }
  )

const WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const READERS = new Set(['Read', 'NotebookRead'])

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const fit = (line: string): string => {
  const l = line.replace(/\t/g, '  ')
  return l.length > LINE_MAX ? l.slice(0, LINE_MAX) : l
}
const oneLine = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** As duas últimas partes do caminho, com barra normal. */
export function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('/') || p
}

const stateOf = (m: ToolUseMessage): ActionState => ({ pending: !m.result, error: !!m.result?.isError })

function readPage(m: ToolUseMessage): ActionPage {
  const inp = record(m.input)
  const path = str(inp.file_path) || str(inp.notebook_path)
  const offset = num(inp.offset)
  const limit = num(inp.limit)
  const text = m.result && !m.result.isError ? m.result.text : ''
  // O monitor de longe só mostra o começo: o corte do fim do resultado não atrapalha.
  const head = text.split('\n').slice(0, READ_LINES + 4).join('\n').slice(0, RESULT_CAP - 1)
  const parsed = head ? parseReadResult(head) : null
  const summary = !m.result
    ? 'Lendo…'
    : m.result.isError
      ? `Erro ao ler · ${oneLine(m.result.text.split('\n')[0] ?? '', 60)}`
      : readSummary(readFileView({ disk: { kind: 'none', reason: 'outside' }, offset, limit, result: text }))
  return {
    ...stateOf(m),
    kind: 'read',
    file: baseName(path),
    lines: (parsed ?? []).slice(0, READ_LINES).map((l) => fit(l.text)),
    firstLine: parsed?.[0]?.num ?? readRange(offset, limit).from,
    summary
  }
}

function terminalPage(m: ToolUseMessage): ActionPage {
  const lines = m.result ? cleanOutput(m.result.text) : []
  const output = lines.slice(-TERM_LINES).map(fit)
  return {
    ...stateOf(m),
    kind: 'terminal',
    shell: m.name === 'PowerShell' ? 'pwsh' : 'bash',
    command: fit(str(record(m.input).command).trim().split('\n')[0] ?? ''),
    output,
    more: lines.length - output.length
  }
}

const FOUND = /^Found (\d+) (?:files?|lines?|matches?|occurrences?)/i
const NONE = /^No (?:matches|files|results) found/i
const AT_LINE = /^(.*?):(\d+)[:-](.*)$/

function searchPage(m: ToolUseMessage): ActionPage {
  const inp = record(m.input)
  const where = str(inp.path) || str(inp.glob)
  const raw = m.result && !m.result.isError ? m.result.text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim()) : []
  let total: number | null = null
  const found = raw[0] ? FOUND.exec(raw[0]) : null
  if (found) {
    total = Number(found[1])
    raw.shift()
  }
  const lines = raw[0] && NONE.test(raw[0]) ? [] : raw
  const hits = lines.slice(0, HITS_MAX).map((l): SearchHit => {
    const at = AT_LINE.exec(l)
    return at ? { file: shortPath(at[1]), line: Number(at[2]), text: fit(at[3].trim()) } : { file: fit(shortPath(l.trim())), line: null, text: '' }
  })
  return { ...stateOf(m), kind: 'search', tool: m.name, pattern: oneLine(str(inp.pattern), LINE_MAX), where: where ? shortPath(where) : '', hits, total: total ?? lines.length }
}

/** O que a ferramenta de navegador faz, pelo nome (sem o prefixo do servidor). */
const DOING: Record<string, string> = {
  WebFetch: 'Baixando a página',
  WebSearch: 'Pesquisando',
  navigate: 'Abrindo',
  back: 'Voltando',
  reload: 'Recarregando',
  click: 'Clicando',
  type: 'Digitando',
  press_key: 'Teclando',
  scroll: 'Rolando',
  select_option: 'Escolhendo opção',
  form_fields: 'Lendo o formulário',
  get_text: 'Lendo o texto',
  snapshot: 'Lendo a página',
  screenshot: 'Tirando print',
  evaluate: 'Rodando script',
  run_steps: 'Executando passos',
  new_tab: 'Abrindo aba',
  open_tab: 'Abrindo aba',
  select_tab: 'Trocando de aba',
  close_tab: 'Fechando aba',
  list_tabs: 'Vendo as abas',
  wait: 'Esperando',
  status: 'Conferindo'
}

/** mcp__browser__browser_click → click; WebFetch → WebFetch. */
const webVerb = (name: string): string => name.replace(/^mcp__(?:browser__browser|chrome__chrome)_/, '')

const urlOf = (m: UIMessage): string => (m.kind === 'tool-use' && groupOf(m.name) === 'web' ? str(record(m.input).url) : '')

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

function webPage(m: ToolUseMessage, msgs: readonly UIMessage[], at: number, floor: number): ActionPage {
  const verb = webVerb(m.name)
  let url = urlOf(m)
  // Clique, digitação…: o endereço é o da última navegação antes dela.
  for (let i = at - 1; !url && m.name !== 'WebSearch' && i >= floor; i--) url = urlOf(msgs[i])
  const summary = summarize(m.name, m.input)
  return {
    ...stateOf(m),
    kind: 'web',
    tool: m.name,
    url: oneLine(url, LINE_MAX),
    host: m.name === 'WebSearch' ? 'Pesquisa na web' : hostOf(url),
    doing: DOING[verb] ?? describeTool(m.name, m.input).verb,
    what: summary === url ? '' : summary
  }
}

function delegatePage(m: ToolUseMessage): ActionPage {
  const inp = record(m.input)
  return {
    ...stateOf(m),
    kind: 'delegate',
    who: str(inp.subagent_type).trim() || 'subagente',
    what: oneLine(str(inp.description) || str(inp.prompt), LINE_MAX)
  }
}

export function lastActionPage(msgs: readonly UIMessage[]): ActionPage | null {
  const floor = Math.max(0, msgs.length - SCAN_MAX)
  for (let i = msgs.length - 1; i >= floor; i--) {
    const m = msgs[i]
    if (m.kind !== 'tool-use' || m.parentToolUseId != null) continue
    if (WRITERS.has(m.name)) return null
    if (READERS.has(m.name)) return readPage(m)
    switch (groupOf(m.name)) {
      case 'command':
        return terminalPage(m)
      case 'search':
        return searchPage(m)
      case 'web':
        return webPage(m, msgs, i, floor)
      case 'delegate':
        return delegatePage(m)
      default:
        continue
    }
  }
  return null
}
