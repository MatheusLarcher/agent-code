/**
 * Texto das falas: preenche os moldes de lines.ts e corta com juízo. Puro (sem
 * DOM, sem relógio, sem aleatório).
 *
 *   fill(template, slots, max = QUIP_MAX)
 *     "{nome}" vira o valor do slot; "[ … ]" é trecho opcional, que só aparece
 *     se TODOS os slots de dentro tiverem valor. Passou de `max`: encolhe o slot
 *     encolhível mais comprido até caber — texto e comando cortam na palavra
 *     (caminhos longos viram o nome do arquivo antes), nome de arquivo corta no
 *     meio e guarda a extensão. Números, horas e durações nunca encolhem.
 *   Cortes: clipEnd, clipText, clipPath, shortenPaths, tidyError.
 *   Dados: duration, clockTime, extLabel, bashFlavor, browserAction, toolLabel,
 *   whoLabel.
 *
 * Tamanho em unidades UTF-16 (`.length`): ≤ 72 aqui vale também contando
 * caracteres ou grafemas. Nenhum corte parte um emoji ao meio.
 */

/** Limite de cada fala. */
export const QUIP_MAX = 72

export type SlotName =
  | 'text' | 'file' | 'diff' | 'ext' | 'pattern' | 'dir' | 'cmd' | 'q' | 'host' | 'action' | 'who' | 'desc'
  | 'tool' | 'what' | 'err' | 'n' | 's' | 'total' | 'more' | 'pct' | 'dur' | 'time' | 'ago'
export type Slots = Partial<Record<SlotName, string | number>>

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const lastSegment = (path: string): string => path.split(/[\\/]+/).filter(Boolean).pop() ?? path

/** Corta em `max` unidades, sem partir emoji, com "…" no fim. */
export function clipEnd(text: string, max: number): string {
  const s = oneLine(text)
  if (s.length <= max) return s
  let out = ''
  for (const ch of s) {
    if (out.length + ch.length > max - 1) break
    out += ch
  }
  return `${out.trimEnd()}…`
}

/** Tokens com 2+ separadores viram o último segmento ("C:\a\b\c.ts" → "c.ts"); URLs ficam. */
export function shortenPaths(text: string): string {
  return text
    .split(' ')
    .map((tok) => {
      if (!/[\\/].*[\\/]/.test(tok) || tok.includes('://')) return tok
      const m = /^(["'`(]*)(.*?)(["'`),;:]*)$/.exec(tok)
      const last = m ? lastSegment(m[2]) : ''
      return m && last ? `${m[1]}${last}${m[3]}` : tok
    })
    .join(' ')
}

/** Texto numa linha; se não couber, encurta caminhos e corta na palavra. */
export function clipText(text: string, max: number): string {
  let s = oneLine(text)
  if (s.length <= max) return s
  s = shortenPaths(s)
  if (s.length <= max) return s
  const hard = clipEnd(s, max)
  const body = hard.slice(0, -1)
  const tidy = (t: string): string => `${t.replace(/[\s,;:.!?—–-]+$/, '')}…`
  if (s.charAt(body.length) === ' ') return tidy(body) // o corte caiu bem no fim de uma palavra
  const space = body.lastIndexOf(' ')
  return space >= max * 0.6 ? tidy(body.slice(0, space)) : hard
}

/** Nome de arquivo: corta no meio e guarda a extensão ("useAuthProvi….test.tsx"). */
export function clipPath(name: string, max: number): string {
  let s = oneLine(name)
  if (s.length <= max) return s
  if (/[\\/]/.test(s)) s = lastSegment(s)
  if (s.length <= max) return s
  const tail = /(?:\.[^.\s]{1,8}){1,2}$/.exec(s)?.[0] ?? ''
  const head = max - tail.length
  return tail && tail.length < s.length && head >= 4 ? `${clipEnd(s.slice(0, s.length - tail.length), head)}${tail}` : clipEnd(s, max)
}

/** Erro numa linha útil: sem "Error:"; "ENOENT: …, open 'C:\x\config.json'" → "ENOENT config.json". */
export function tidyError(message: string): string {
  const s = oneLine(message).replace(/^(?:uncaught\s+)?(?:error|erro|fatal)\s*:\s*/i, '')
  const fs = /^(E[A-Z]{2,})\b[^,]*,\s*\w+\s+'([^']+)'?/.exec(s)
  return fs ? `${fs[1]} ${lastSegment(fs[2])}` : shortenPaths(s)
}

// ── preenchimento ─────────────────────────────────────────────────────────
type Shrink = (value: string, max: number) => string
const SHRINK: Partial<Record<SlotName, Shrink>> = {
  text: clipText, desc: clipText, q: clipText, what: clipText, err: clipText, cmd: clipText,
  file: clipPath, dir: clipPath,
  pattern: clipEnd, host: clipEnd, action: clipEnd, who: clipEnd, tool: clipEnd, ext: clipEnd
}
/** Um slot nunca encolhe abaixo disto: o dado tem de continuar reconhecível. */
const MIN_KEEP = 8
const SLOT = /\{(\w+)\}/g
const OPTIONAL = /\[([^[\]]*)\]/g

/** Preenche o molde e garante ≤ max (ver o topo do arquivo). */
export function fill(template: string, slots: Slots, max = QUIP_MAX): string {
  const vals = new Map<string, string>()
  for (const [k, v] of Object.entries(slots)) if (v !== undefined && v !== null) vals.set(k, oneLine(String(v)))
  const has = (k: string): boolean => (vals.get(k) ?? '') !== ''
  // Resolve os opcionais uma vez: o que sobra é exatamente o que aparece.
  const shape = template.replace(OPTIONAL, (_, inner: string) => ([...inner.matchAll(SLOT)].every((m) => has(m[1])) ? inner : ''))
  const used = [...new Set([...shape.matchAll(SLOT)].map((m) => m[1] as SlotName))]
  const render = (): string => shape.replace(SLOT, (_, k: string) => vals.get(k) ?? '')
  let out = render()
  for (let guard = 0; out.length > max && guard < used.length * 2; guard++) {
    let pick: SlotName | null = null
    for (const k of used) {
      const len = vals.get(k)?.length ?? 0
      if (SHRINK[k] && len > MIN_KEEP && (pick === null || len > (vals.get(pick)?.length ?? 0))) pick = k
    }
    if (pick === null) break
    const v = vals.get(pick) ?? ''
    vals.set(pick, SHRINK[pick]!(v, Math.max(MIN_KEEP, v.length - (out.length - max))))
    out = render()
  }
  return out.length > max ? clipEnd(out, max) : out
}

// ── dados ──────────────────────────────────────────────────────────────────
/** "40 s", "4 min", "1 h 5 min", "3 dias". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
  const d = Math.floor(h / 24)
  return d === 1 ? '1 dia' : `${d} dias`
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Hora local "23:40"; a mais de 20 h de `now`, com a data: "05/10 23:40". */
export function clockTime(at: number, now: number): string {
  const d = new Date(at)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return at - now < 20 * 3_600_000 ? hm : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hm}`
}

/** "card.css" → "CSS"; sem extensão, o próprio nome ("Dockerfile"). */
export function extLabel(file: string): string {
  const dot = file.lastIndexOf('.')
  return dot > 0 && dot < file.length - 1 ? file.slice(dot + 1).toUpperCase() : file
}

export type BashFlavor = 'test' | 'install' | 'build' | 'check' | 'git' | 'serve' | 'run'
const PM = '(?:npm|pnpm|yarn|bun)'
/** Primeira que bater vence: git vem antes porque a mensagem do commit pode citar "test". */
const FLAVORS: ReadonlyArray<readonly [BashFlavor, RegExp]> = [
  ['git', /^(?:git|gh)\b/i],
  ['install', new RegExp(`\\b${PM}\\s+(?:install|i|ci|add)\\b|\\bpip3?\\s+install\\b|\\b(?:poetry|uv)\\s+(?:install|add|sync)\\b|\\bcargo\\s+(?:add|fetch)\\b|\\bgo\\s+(?:get|mod\\s+download)\\b|\\bdotnet\\s+(?:restore|add)\\b|\\bengine:sync\\b`, 'i')],
  ['test', new RegExp(`\\b(?:vitest|jest|pytest|mocha|phpunit|rspec)\\b|\\b${PM}\\s+(?:run\\s+)?test\\b|\\bnpm\\s+t\\b|\\b(?:go|cargo|dotnet|deno|mvn|gradlew?|playwright)\\s+test\\b`, 'i')],
  ['check', /\btsc\b|\btypecheck\b|\b(?:es|ts)?lint\b|\bprettier\b|\bruff\b|\bmypy\b|\bclippy\b/i],
  ['build', new RegExp(`\\b${PM}\\s+run\\s+build\\b|\\b(?:vite|electron-vite|electron-builder|webpack|rollup|esbuild)\\b.*\\bbuild\\b|\\b(?:cargo|go|dotnet)\\s+build\\b|\\bmake\\b|\\bmvn\\s+(?:package|install)\\b|\\bgradlew?\\s+build\\b|build-installer|\\bpackage:win\\b`, 'i')],
  ['serve', new RegExp(`\\b${PM}\\s+(?:run\\s+)?(?:dev|start|serve|preview)\\b`, 'i')]
]

/** Que tipo de comando é (escolhe o grupo de falas do Bash). */
export function bashFlavor(command: string): BashFlavor {
  for (const [flavor, re] of FLAVORS) if (re.test(command)) return flavor
  return 'run'
}

const BROWSER_VERBS: Record<string, string> = {
  navigate: 'abrindo página', click: 'clicando', type: 'digitando', screenshot: 'tirando print',
  snapshot: 'lendo a página', evaluate: 'rodando JS', scroll: 'rolando a página', form_fields: 'preenchendo formulário',
  run_steps: 'executando passos', back: 'voltando uma página', reload: 'recarregando', new_tab: 'abrindo aba',
  open_tab: 'abrindo aba', close_tab: 'fechando aba', select_tab: 'trocando de aba', list_tabs: 'contando abas',
  press_key: 'apertando tecla', select_option: 'escolhendo opção', wait: 'esperando a página', get_text: 'lendo o texto'
}

/** "mcp__browser__browser_click" → "clicando"; verbo desconhecido sai como veio. */
export function browserAction(name: string): string {
  const verb = name.replace(/^mcp__\w+?__/, '').replace(/^(?:browser|chrome)_/, '')
  return BROWSER_VERBS[verb] ?? verb.replace(/_/g, ' ')
}

/** "mcp__tasks__task_claim" → "task_claim"; nome do SDK fica como está. */
export const toolLabel = (name: string): string => (name.startsWith('mcp__') ? name.split('__').pop() || name : name)

const WHO: Record<string, string> = {
  principal: 'principal', executor: 'executor', critico: 'crítico', 'navegador-de-codigo': 'navegador de código',
  memoria: 'memorista', po: 'PO', vigia: 'vigia', subagente: 'subagente',
  'general-purpose': 'faz-tudo', Explore: 'explorador', Plan: 'planejador'
}

/** Papel ou tipo de subagente como se fala: "critico" → "crítico"; desconhecido fica como veio. */
export const whoLabel = (type: string): string => WHO[type] ?? (type || 'subagente')
