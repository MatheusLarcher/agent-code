/**
 * A linha-resumo da atividade de um turno, na Central: UMA linha em português do
 * que o agente fez — `Procurou "cnpj" · editou filtros.js +6 −2 · rodou os testes ✓`
 * — montada sem LLM a partir dos tool-use da trilha principal. Módulo puro.
 *
 *   ação pronta      no passado ("leu auth.ts"); seguidas do mesmo tipo se juntam
 *                    ("leu 3 arquivos", "rodou 2 comandos", edições somam o +a −r)
 *   ação em curso    `now` ("lendo auth.ts…"): a última sem resultado, só com o
 *                    turno rodando — ela não entra no resumo
 *   linha comprida   leituras e buscas viram contagem no fim; ainda comprida, os
 *                    pedaços são cortados com "…" (o `text` guarda a linha inteira)
 *
 * Nome do arquivo e +a −r vêm do describeTool e o erro do toolErrored — a mesma
 * fonte do cartão do chat. Padrão, termo, host e comando são lidos da entrada: o
 * callSegments põe o `path` do Grep na frente do padrão e achata o comando numa
 * linha, e aqui o comando vira só "programa + subcomando".
 */
import type { CentralActivity, CentralActivitySegment } from '@shared/central'
import { describeTool, toolErrored } from '../components/toolDescribe'

/** Uma chamada de ferramenta como o chat guarda — um `tool-use` de UIMessage serve (o resultado já vem colado nele). */
export type ToolCallLike = { name: string; input: unknown; result?: { isError: boolean; text: string } | null }

/** Tamanho padrão da linha na tela. */
const MAX_CHARS = 110
/** Comando, padrão e termo de busca nunca passam disto. */
const TARGET_MAX = 24

/**
 * Bastidor, não ação: plano, pergunta ao usuário, busca de ferramenta e o registro de tarefas do
 * próprio app (`mcp__tasks__*`, chamado o tempo todo pelos agentes daqui). Nem aparecem, nem contam,
 * nem viram "agora", nem separam grupos.
 */
const IGNORED = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'AskUserQuestion', 'ToolSearch'])
const IGNORED_PREFIX = 'mcp__tasks__'
const isIgnored = (name: string): boolean => IGNORED.has(name) || name.startsWith(IGNORED_PREFIX)

type Seg = CentralActivitySegment
type Kind = 'read' | 'edit' | 'write' | 'search' | 'test' | 'build' | 'bash' | 'web' | 'browser' | 'agent' | 'other'

/** O arquivo de uma edição/criação: `key` (o caminho inteiro) soma as edições do mesmo arquivo. */
interface FileTouch {
  key: string
  name: string
  added: number
  removed: number
}

interface Action {
  kind: Kind
  /** A ação sozinha, no passado, já em pedaços ("leu " + **auth.ts**). */
  alone: Seg[]
  /** A forma "agora", sem o "…" ("lendo auth.ts"). */
  now: string
  file?: FileTouch
  finished: boolean
  errored: boolean
}

const seg = (text: string, tone?: Seg['tone']): Seg => (tone ? { text, tone } : { text })
const record = (input: unknown): Record<string, unknown> =>
  (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
const length = (segs: Seg[]): number => segs.reduce((n, s) => n + s.text.length, 0)

/** Corta em `max` caracteres com "…", sem partir ao meio um caractere de dois códigos. */
function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')}…`
}

/** Padrão ou termo de busca: uma linha só, sem aspas duplas dentro (vai entre aspas), até 24 caracteres. */
function term(value: unknown): string {
  return typeof value === 'string' ? cut(value.replace(/"/g, "'").replace(/\s+/g, ' ').trim(), TARGET_MAX) : ''
}

function hostOf(url: unknown): string {
  if (typeof url !== 'string') return ''
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------- comando

/** Uma palavra do comando; `plain` = sem aspas, `$` nem crase (pode ir para a tela). */
interface Word {
  text: string
  plain: boolean
}

/**
 * Corpos de heredoc (`cat <<'EOF' … EOF`) saem antes da leitura: são texto, não
 * comando — a mensagem de um `git commit` montada assim pode citar "npm test".
 */
function dropHeredocs(command: string): string {
  const lines = command.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i])
    const end = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(lines[i])?.[2]
    if (!end) continue
    while (i + 1 < lines.length && lines[i + 1].trim() !== end) i++
    i++ // a linha do delimitador sai junto
  }
  return out.join('\n')
}

/**
 * Os comandos simples de uma linha de shell (Bash ou PowerShell), cada um com as
 * suas palavras: corta em `&&`, `||`, `;`, `|`, `&` e quebra de linha fora de
 * aspas, pula comentários e junta `$( … )` numa palavra só. Leitura rasa de
 * propósito: o resumo só precisa do programa e do subcomando.
 */
function shellCommands(command: string): Word[][] {
  const src = dropHeredocs(command)
  const commands: Word[][] = []
  let words: Word[] = []
  let text = ''
  let plain = true
  let quote = ''
  let depth = 0
  const endWord = (): void => {
    if (text) words.push({ text, plain })
    text = ''
    plain = true
  }
  const endCommand = (): void => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    const next = src[i + 1] ?? ''
    if (quote) {
      // Entre aspas tudo é palavra; nas duplas, \" e \\ não fecham.
      text += ch
      if (quote === '"' && ch === '\\') text += src[++i] ?? ''
      else if (ch === quote) quote = ''
    } else if (depth > 0) {
      text += ch
      if (ch === '(') depth++
      else if (ch === ')') depth--
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      plain = false
      text += ch
    } else if (ch === '$' && next === '(') {
      depth = 1
      plain = false
      text += '$('
      i++
    } else if (ch === '\\' && next === '\n') {
      i++ // continuação de linha
    } else if (ch === '#' && !text) {
      while (i + 1 < src.length && src[i + 1] !== '\n') i++ // comentário até o fim da linha
    } else if (ch === '\n' || ch === ';' || ch === '|' || (ch === '&' && next !== '>' && src[i - 1] !== '>')) {
      endCommand() // `2>&1` e `&>` são redirecionamento, não separador
    } else if (/\s/.test(ch)) {
      endWord()
    } else {
      if (ch === '$') plain = false
      text += ch
    }
  }
  endCommand()
  return commands
}

/** Atribuição de ambiente na frente do comando (`FOO=1 npm test`). */
const ASSIGNMENT = /^[A-Za-z_]\w*=/

/** O programa: sem caminho e sem .exe/.cmd/.bat (`C:\Tools\rg.exe` → `rg`); '' quando não dá para mostrar. */
function programName(word: Word | undefined): string {
  if (!word?.plain) return ''
  const name = (word.text.split(/[\\/]/).pop() ?? '').replace(/\.(exe|cmd|bat|com)$/i, '')
  return /^\w[\w.+-]*$/.test(name) ? name : ''
}

/** Só preparam o terreno: o resumo mostra o comando que vem depois deles. */
const SETUP = new Set(['cd', 'pushd', 'popd', 'set', 'export', 'source'])

/** "programa subcomando" do primeiro comando que importa (`git status`, `npm install`, `ls`); nunca flag, caminho, aspas nem o resto. */
function commandLabel(commands: Word[][]): string {
  const list = commands
    .map((words) => {
      let i = 0
      while (i < words.length && ASSIGNMENT.test(words[i].text)) i++
      return words.slice(i)
    })
    .filter((words) => words.length > 0)
  const words = list.find((w) => !SETUP.has(programName(w[0]).toLowerCase())) ?? list[0]
  const program = programName(words?.[0])
  if (!words || !program) return ''
  const sub = words[1]
  return cut(sub?.plain && /^[a-z][a-z-]*$/.test(sub.text) ? `${program} ${sub.text}` : program, TARGET_MAX)
}

/** Prefixos que não mudam o que roda (`npx vitest`, `sudo …`, `time …`). */
const WRAPPERS = new Set(['npx', 'pnpx', 'bunx', 'sudo', 'time', 'env', 'nohup'])
const ALIASES = new Map([
  ['gradlew', 'gradle'],
  ['mvnw', 'mvn']
])
/** Programas cujo subcomando diz se é teste ou build. */
const BY_SUBCOMMAND = new Map<string, { test?: string; build?: string }>([
  ['go', { test: 'test', build: 'build' }],
  ['cargo', { test: 'test', build: 'build' }],
  ['dotnet', { test: 'test', build: 'build' }],
  ['mvn', { test: 'test', build: 'package' }],
  ['gradle', { test: 'test', build: 'build' }],
  ['vite', { build: 'build' }],
  ['electron-vite', { build: 'build' }]
])

/** Um comando simples roda os testes, o build (ou typecheck), ou nenhum dos dois? */
function commandKindOf(words: Word[]): 'test' | 'build' | null {
  let i = 0
  for (;;) {
    if (i < words.length && ASSIGNMENT.test(words[i].text)) i++
    else if (WRAPPERS.has(programName(words[i]).toLowerCase())) {
      i++
      while (words[i]?.text.startsWith('-')) i++
    } else break
  }
  let program = programName(words[i]).toLowerCase()
  program = ALIASES.get(program) ?? program
  let args = words.slice(i + 1).map((w) => w.text)
  if (/^(python[\d.]*|py)$/.test(program) && args[0] === '-m') {
    program = (args[1] ?? '').toLowerCase()
    args = args.slice(2)
  }
  if (program === 'vitest' || program === 'jest' || program === 'pytest') return 'test'
  if (program === 'tsc') return 'build'
  const at = args.findIndex((a) => !a.startsWith('-'))
  const sub = at < 0 ? '' : args[at]
  if (program === 'npm' || program === 'pnpm' || program === 'yarn') {
    const script = sub === 'run' || sub === 'run-script' ? (args.slice(at + 1).find((a) => !a.startsWith('-')) ?? '') : sub
    if (/^test(:|$)/.test(script)) return 'test'
    return /^(build|typecheck)(:|$)/.test(script) ? 'build' : null
  }
  const rule = BY_SUBCOMMAND.get(program)
  if (rule?.test === sub && sub) return 'test'
  if (rule?.build === sub && sub) return 'build'
  return null
}

/** Basta um comando de teste na linha para ela ser "rodou os testes" (`npm run typecheck && npm test`). */
function commandKind(commands: Word[][]): 'test' | 'build' | null {
  const kinds = commands.map(commandKindOf)
  return kinds.includes('test') ? 'test' : kinds.includes('build') ? 'build' : null
}

// ---------------------------------------------------------------- ações

function classify(call: ToolCallLike): Action {
  const state = { finished: call.result != null, errored: toolErrored(call.name, call.result) }
  const input = record(call.input)
  const simple = (kind: Kind, alone: string, now: string): Action => ({ kind, alone: [seg(alone)], now, ...state })
  switch (call.name) {
    case 'Read': {
      const name = describeTool(call.name, call.input).detail
      const alone = name ? [seg('leu '), seg(name, 'strong')] : [seg('leu um arquivo')]
      return { kind: 'read', alone, now: `lendo ${name || 'um arquivo'}`, ...state }
    }
    case 'WebFetch': {
      const host = hostOf(input.url)
      return simple('read', host ? `leu ${host}` : 'leu uma página', `lendo ${host || 'uma página'}`)
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'Write': {
      const info = describeTool(call.name, call.input)
      const path = [input.file_path, input.notebook_path].find((p): p is string => typeof p === 'string' && p !== '')
      const file = { key: path ?? info.detail, name: info.detail, added: info.stats?.added ?? 0, removed: info.stats?.removed ?? 0 }
      const write = call.name === 'Write'
      return { kind: write ? 'write' : 'edit', alone: [], now: `${write ? 'criando' : 'editando'} ${info.detail || 'um arquivo'}`, file, ...state }
    }
    case 'Grep':
    case 'Glob': {
      const pattern = term(input.pattern)
      return simple('search', pattern ? `procurou "${pattern}"` : 'fez uma busca', pattern ? `procurando "${pattern}"` : 'procurando')
    }
    case 'Bash':
    case 'PowerShell': {
      const commands = shellCommands(typeof input.command === 'string' ? input.command : '')
      const kind = commandKind(commands)
      if (kind === 'test') return simple('test', 'rodou os testes', 'rodando os testes')
      if (kind === 'build') return simple('build', 'rodou o build', 'rodando o build')
      const label = commandLabel(commands)
      return simple('bash', label ? `rodou ${label}` : 'rodou um comando', `rodando ${label || 'um comando'}`)
    }
    case 'WebSearch': {
      const query = term(input.query)
      return simple('web', query ? `pesquisou "${query}" na web` : 'pesquisou na web', 'pesquisando')
    }
    case 'Task':
    case 'Agent':
      return simple('agent', 'chamou um subagente', 'subagente trabalhando')
  }
  if (call.name.startsWith('mcp__browser__')) return simple('browser', 'testou no navegador', 'testando no navegador')
  const verb = describeTool(call.name, call.input).verb
  return simple('other', `usou ${verb}`, `usando ${verb}`)
}

// ---------------------------------------------------------------- linha

/** Ações seguidas do mesmo tipo viram um grupo, na ordem em que aconteceram. */
function groupRuns(actions: Action[]): Action[][] {
  const runs: Action[][] = []
  for (const action of actions) {
    const last = runs[runs.length - 1]
    if (last && last[0].kind === action.kind) last.push(action)
    else runs.push([action])
  }
  return runs
}

/** Os arquivos de um grupo de edições/criações: até 2 nomes (cada um com a soma do seu +a −r), depois "e mais N". */
function fileList(group: Action[], deltas: boolean): Seg[] {
  const files: FileTouch[] = []
  for (const { file } of group) {
    if (!file) continue
    const same = files.find((f) => f.key === file.key)
    if (same) {
      same.added += file.added
      same.removed += file.removed
    } else files.push({ ...file })
  }
  const out: Seg[] = []
  files.slice(0, 2).forEach((f, i) => {
    if (i > 0) out.push(seg(files.length > 2 ? ', ' : ' e '))
    out.push(f.name ? seg(f.name, 'strong') : seg('um arquivo'))
    if (deltas && f.added > 0) out.push(seg(' '), seg(`+${f.added}`, 'add'))
    if (deltas && f.removed > 0) out.push(seg(' '), seg(`−${f.removed}`, 'rem'))
  })
  if (files.length > 2) out.push(seg(` e mais ${files.length - 2}`))
  return out
}

/** ✓ quando todas as rodadas do grupo voltaram sem erro; ✗ se alguma falhou; sem resultado, sem marca. */
function mark(group: Action[]): Seg[] {
  if (group.some((a) => a.errored)) return [seg(' '), seg('✗', 'bad')]
  return group.every((a) => a.finished) ? [seg(' '), seg('✓', 'ok')] : []
}

/** N ações seguidas que não listam arquivo nem marcam ✓/✗. */
function many(kind: Kind, n: number): string {
  switch (kind) {
    case 'read':
      return `leu ${n} arquivos`
    case 'search':
      return `fez ${n} buscas`
    case 'bash':
      return `rodou ${n} comandos`
    case 'web':
      return `fez ${n} pesquisas na web`
    case 'agent':
      return `chamou ${n} subagentes`
    default:
      return `usou ${n} ferramentas`
  }
}

function renderGroup(group: Action[]): Seg[] {
  const [first] = group
  switch (first.kind) {
    case 'edit':
      return [seg('editou '), ...fileList(group, true)]
    case 'write':
      return [seg('criou '), ...fileList(group, false)]
    case 'test':
    case 'build':
      return [...first.alone, ...mark(group)]
    case 'browser':
      return first.alone
  }
  return group.length === 1 ? first.alone : [seg(many(first.kind, group.length))]
}

/** As partes ligadas por " · ", com a primeira letra da linha em maiúscula. */
function joinParts(parts: Seg[][]): Seg[] {
  const out = parts.flatMap((part, i) => (i === 0 ? part : [seg(' · '), ...part]))
  if (out.length > 0) out[0] = { ...out[0], text: out[0].text.charAt(0).toUpperCase() + out[0].text.slice(1) }
  return out
}

/** A linha encurtada: leituras e buscas saem do meio e viram contagem no fim (leituras primeiro). */
function collapsedParts(actions: Action[]): Seg[][] {
  const reads = actions.filter((a) => a.kind === 'read').length
  const searches = actions.filter((a) => a.kind === 'search').length
  const parts = groupRuns(actions.filter((a) => a.kind !== 'read' && a.kind !== 'search')).map(renderGroup)
  if (reads > 0) parts.push([seg(`leu ${reads} ${reads === 1 ? 'arquivo' : 'arquivos'}`)])
  if (searches > 0) parts.push([seg(`fez ${searches} ${searches === 1 ? 'busca' : 'buscas'}`)])
  return parts
}

/** Corta os pedaços em `max` caracteres, o "…" incluído, sem separador pendurado antes dele. */
function cutSegments(segs: Seg[], max: number): Seg[] {
  const out: Seg[] = []
  let room = max - 1
  for (const s of segs) {
    if (room <= 0) break
    if (s.text.length <= room) {
      out.push(s)
      room -= s.text.length
      continue
    }
    out.push({ ...s, text: s.text.slice(0, room).replace(/[\uD800-\uDBFF]$/, '') })
    break
  }
  while (out.length > 0) {
    const last = out[out.length - 1]
    const text = last.text.replace(/[\s·]+$/, '')
    if (text) {
      out[out.length - 1] = { ...last, text }
      break
    }
    out.pop()
  }
  return [...out, seg('…')]
}

/** Pedaços vizinhos com o mesmo tom viram um só; os vazios saem. */
function compact(segs: Seg[]): Seg[] {
  const out: Seg[] = []
  for (const s of segs) {
    if (!s.text) continue
    const last = out[out.length - 1]
    if (last && last.tone === s.tone) out[out.length - 1] = { ...last, text: last.text + s.text }
    else out.push(s)
  }
  return out
}

/**
 * A linha-resumo das chamadas de um turno (já filtradas para a trilha principal).
 * `running`: o turno ainda roda — a última ação sem resultado vira o `now`.
 * `maxChars`: tamanho da linha na tela (padrão 110); o `text` vem sempre inteiro.
 */
export function summarizeActivity(tools: ToolCallLike[], opts: { running: boolean; maxChars?: number }): CentralActivity {
  const max = typeof opts.maxChars === 'number' && opts.maxChars >= 1 ? Math.floor(opts.maxChars) : MAX_CHARS
  const actions = tools.filter((t) => !isIgnored(t.name)).map(classify)
  const errors = actions.filter((a) => a.errored).length
  let current = -1
  if (opts.running) {
    for (let i = actions.length - 1; i >= 0 && current < 0; i--) if (!actions[i].finished) current = i
  }
  const past = actions.filter((_, i) => i !== current)
  const tail = errors > 0 ? [seg(' '), seg(`· ${errors} ${errors === 1 ? 'erro' : 'erros'}`, 'bad')] : []
  const full = [...joinParts(groupRuns(past).map(renderGroup)), ...tail]
  const text = full.map((s) => s.text).join('')
  let shown = full
  if (text.length > max) {
    // O erro fica sempre visível: o corte é só no corpo.
    const body = joinParts(collapsedParts(past))
    const room = max - length(tail)
    shown = [...(length(body) <= room ? body : cutSegments(body, Math.max(1, room))), ...tail]
  }
  // Um alvo já cortado ("rodando docker-compose-super-lo…") não ganha um segundo "…".
  const now = current < 0 ? undefined : actions[current].now.replace(/…?$/, '…')
  return { segments: compact(shown), text, count: actions.length, errors, ...(now ? { now } : {}) }
}
