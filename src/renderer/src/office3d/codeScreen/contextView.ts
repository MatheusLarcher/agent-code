/**
 * O que o app Contexto do monitor desenha em "Recebeu" — PURO (sem React, sem IO).
 *
 *   contextBlocks(input)   os blocos na ordem em que o Agent lê: primeiro o que o
 *                          motor carrega e o app NÃO vê como texto (ferramentas,
 *                          MCP, instruções do motor, CLAUDE.md, skills, histórico —
 *                          só o tamanho medido pelo SDK, `measured`), com as
 *                          instruções do app no meio; depois o que o app enviou
 *                          (carimbo, catálogos, pedido, docs, trechos de memória)
 *                          com o texto exato; por fim os reenvios do meio do turno
 *                          e a continuação automática, com o horário e as linhas
 *                          novas. Num turno antigo, bloco com o mesmo texto do turno
 *                          seguinte vem marcado `same`.
 *   secretSegments(text)   o texto com cada ⟦senha:nome⟧ separado (a tela troca
 *                          por •••• do tamanho real e um olho).
 *   maskedText(text)       o mesmo texto com [senha: nome] (copiar).
 *   countHits(text, q)     ocorrências da busca (sem diferenciar caixa).
 *
 * Tokens: o do SDK quando há medição (o total do resumo é o autoritativo); o dos
 * blocos que o app enviou é estimado pelo tamanho (~4 bytes por token, "~").
 */
import {
  SECRET_PLACEHOLDER_PREFIX,
  SECRET_PLACEHOLDER_SUFFIX,
  type ContextBlock,
  type ContextBlockKind,
  type ContextTurnDetail,
  type ContextUsageSnapshot
} from '@shared/contextSnapshot'
import type { IconName } from './icons'

/** A cor da faixa (raio-X e o traço do bloco). `miss` = o app não vê o texto. */
export type BlockTone = 'miss' | 'link' | 'sys' | 'msg' | 'ask' | 'docs' | 'mem' | 'sub'

export interface DisplayBlock {
  id: string
  tone: BlockTone
  icon: IconName
  title: string
  desc: string
  /** Texto exato que o app enviou (senhas como ⟦senha:nome⟧); ausente = o app não vê. */
  text?: string
  bytes: number
  tokens: number
  /** Tamanho medido pelo SDK (true) ou estimado pelo texto (false). */
  measured: boolean
  /** Itens medidos (nome, tokens), para o que o app não vê. */
  list?: Array<[string, number]>
  note?: string
  /** epoch ms: reenvio do meio do turno e continuação. */
  when?: number
  /** Índices das linhas que não estavam no envio anterior do mesmo tipo (reenvio). */
  added?: number[]
  /** Igual ao do turno seguinte (num turno antigo). */
  same?: boolean
  /** Bloco de trechos de memória: a tela liga às memórias enviadas. */
  memory?: boolean
}

export interface ContextBlocksInput {
  detail: ContextTurnDetail | null
  /** O turno seguinte (mais novo), para marcar "igual". */
  newer?: ContextTurnDetail | null
  /** A medição a usar (a exata, quando o usuário pediu); senão a do turno. */
  usage?: ContextUsageSnapshot | null
  /** Monitor de um subagente: as instruções e o pedido dele, e o motor como não visível. */
  subagent?: boolean
}

/** ~4 bytes por token: a estimativa dos blocos de texto. */
export const estimateTokens = (bytes: number): number => Math.round(bytes / 4)

const LIST_MAX = 9

interface Meta {
  tone: BlockTone
  icon: IconName
  title: string
  desc: string
}

const APP_META: Record<ContextBlockKind, Meta> = {
  'system-append': { tone: 'sys', icon: 'sliders', title: 'Instruções do app', desc: 'Navegador, Android, downloads, memória, tarefas, Windows e Chrome.' },
  stamp: { tone: 'msg', icon: 'stamp', title: 'Carimbo', desc: 'De qual PC, quando e em que fuso a mensagem saiu.' },
  'memory-catalog': { tone: 'msg', icon: 'chip', title: 'Catálogo de memórias', desc: 'Foi junto porque as memórias mudaram desde a última mensagem.' },
  'skills-catalog': { tone: 'msg', icon: 'wand', title: 'Catálogo de skills', desc: 'Foi junto porque as skills mudaram desde a última mensagem.' },
  projects: { tone: 'msg', icon: 'tree', title: 'Projetos deste PC', desc: 'Pastas com conversa no app. Vai só quando a lista muda.' },
  others: { tone: 'msg', icon: 'users', title: 'Outras conversas', desc: 'O que os outros agentes fazem agora. Só informativo.' },
  'cancel-note': { tone: 'msg', icon: 'alert', title: 'Nota de cancelamento', desc: 'O pedido anterior foi cancelado; o Agent foi avisado para ignorá-lo.' },
  loop: { tone: 'msg', icon: 'history', title: 'Modo loop', desc: 'O pedido foi como /loop: o Agent repete até a condição ser atendida.' },
  reminder: { tone: 'msg', icon: 'info', title: 'Lembrete do modo econômico', desc: 'Pede para pular validações em tarefa trivial.' },
  'user-request': { tone: 'ask', icon: 'user', title: 'Seu pedido', desc: 'O texto que você digitou, sem nada a mais.' },
  images: { tone: 'ask', icon: 'file', title: 'Imagens', desc: 'Só a contagem: o conteúdo da imagem não é copiado aqui.' },
  docs: { tone: 'docs', icon: 'book', title: 'Docs do projeto', desc: 'AGENTS.md e CLAUDE.md inteiros; de docs/, as 3 primeiras linhas de cada arquivo.' },
  'memory-excerpts': { tone: 'mem', icon: 'chip', title: 'Trechos de memória', desc: 'As memórias que o app escolheu para este pedido.' },
  'subagent-instructions': { tone: 'sub', icon: 'sliders', title: 'Instruções do especialista', desc: 'O papel que o app deu a este subagente.' },
  'subagent-request': { tone: 'ask', icon: 'user', title: 'Pedido do Agent principal', desc: 'A tarefa que o principal delegou.' }
}

const sum = (xs: ReadonlyArray<{ tokens: number }> | undefined): number => (xs ?? []).reduce((n, x) => n + (x.tokens || 0), 0)

/** Os itens mais pesados e o resto numa linha só. */
function topList(items: Array<[string, number]>, what: string): Array<[string, number]> {
  const sorted = [...items].sort((a, b) => b[1] - a[1])
  if (sorted.length <= LIST_MAX + 1) return sorted
  const rest = sorted.slice(LIST_MAX)
  return [...sorted.slice(0, LIST_MAX), [`… mais ${rest.length} ${what}`, rest.reduce((n, [, t]) => n + t, 0)]]
}

function engineBlocks(usage: ContextUsageSnapshot | null, appTokens: number, ownTokens: number): { before: DisplayBlock[]; after: DisplayBlock[] } {
  const miss = (id: string, icon: IconName, title: string, desc: string, tokens: number, note: string, list?: Array<[string, number]>): DisplayBlock => ({
    id, tone: 'miss', icon, title, desc, bytes: 0, tokens, measured: !!usage, note, ...(list && list.length ? { list } : {})
  })
  const waiting = 'A medição do SDK chega ao fim do turno.'
  const tools = usage?.systemTools ?? []
  const mcpByServer = new Map<string, { n: number; tokens: number }>()
  for (const t of usage?.mcpTools ?? []) {
    const s = mcpByServer.get(t.serverName) ?? { n: 0, tokens: 0 }
    s.n += 1
    s.tokens += t.tokens
    mcpByServer.set(t.serverName, s)
  }
  const sections = usage?.systemPromptSections ?? []
  // O system prompt medido inclui o append do app, que aparece à parte com o texto.
  const engineTokens = Math.max(0, sum(sections) - appTokens)
  const files = usage?.memoryFiles ?? []
  const skills = usage?.skills ?? []
  const messages = usage?.categories.find((c) => c.kind === 'used' && /message/i.test(c.name))?.tokens ?? 0
  return {
    before: [
      miss('tools', 'blocks', 'Ferramentas do motor', 'Read, Edit, Bash, Grep… a descrição de cada uma vai em todo pedido.', sum(tools),
        usage ? 'Cada ferramenta leva a própria descrição e o esquema dos parâmetros. O texto não passa pelo app; o tamanho de cada uma vem da medição do SDK.' : waiting,
        topList(tools.map((t) => [t.name, t.tokens]), 'ferramentas')),
      miss('mcp', 'blocks', 'Ferramentas do app (MCP)', 'Navegador, planejamento, memória, tarefas, Windows e Chrome.', sum(usage?.mcpTools),
        usage ? 'Os servidores MCP que o app liga nesta sessão, medidos pelo SDK por servidor.' : waiting,
        [...mcpByServer].map(([name, s]) => [`${name} · ${s.n} ${s.n === 1 ? 'ferramenta' : 'ferramentas'}`, s.tokens])),
      miss('engine', 'engine', 'Instruções internas do motor', 'A base que o CLI embutido escreve antes de tudo.', engineTokens,
        usage ? 'O motor (o CLI que vem com o app) escreve estas instruções. O texto não passa pelo app; as seções e o tamanho vêm da medição do SDK (sem a parte do app, mostrada à parte).' : waiting,
        sections.map((s) => [s.name, s.tokens]))
    ],
    after: [
      miss('claude-md', 'file', 'CLAUDE.md que o motor lê', 'Suas instruções globais e as do projeto, lidas direto pelo motor.', sum(files),
        usage ? 'O motor lê estes arquivos sozinho. O do projeto também aparece em "Docs do projeto", porque o app o envia.' : waiting,
        files.map((f) => [`${f.path} · ${f.type}`, f.tokens])),
      miss('skills', 'wand', 'Skills que o motor anuncia', 'Nome e descrição de cada skill instalada.', sum(skills),
        usage ? 'O motor anuncia as skills disponíveis em todo pedido. Medido pelo SDK, skill por skill.' : waiting,
        topList(skills.map((s) => [s.name, s.tokens]), 'skills')),
      {
        id: 'history', tone: 'link', icon: 'history', title: 'Histórico desta conversa', desc: 'As mensagens anteriores também vão. Estão no Chat.',
        bytes: 0, tokens: Math.max(0, messages - ownTokens), measured: !!usage,
        note: usage ? 'As mensagens anteriores desta conversa vão junto com cada pedido. Já aparecem no Chat, então não se repetem aqui; o tamanho é o das mensagens medido pelo SDK, menos o que este turno mandou.' : waiting
      }
    ]
  }
}

function appBlock(b: ContextBlock, index: number): DisplayBlock {
  const meta = APP_META[b.kind]
  const resent = b.source === 'hook-mid'
  const cont = b.source === 'continuation'
  const title = resent ? `${meta.title}, de novo` : cont ? (b.kind === 'user-request' ? 'Continuação automática' : `${meta.title} (continuação)`) : meta.title
  const desc = resent
    ? 'Algo mudou no meio do turno; o bloco inteiro foi reenviado.'
    : cont && b.kind === 'user-request'
      ? 'O app retomou o turno (troca de modelo ou de conta, ou erro passageiro) com esta mensagem.'
      : b.label.endsWith('(sessão nova)')
        ? 'A sessão nova (depois da troca) subiu com estas instruções.'
        : meta.desc
  return {
    id: `${b.source}:${b.kind}:${index}`,
    tone: meta.tone,
    icon: cont && b.kind === 'user-request' ? 'history' : meta.icon,
    title,
    desc,
    text: b.text,
    bytes: b.bytes,
    tokens: estimateTokens(b.bytes),
    measured: false,
    ...(resent || cont ? { when: b.at } : {}),
    ...(b.kind === 'memory-excerpts' ? { memory: true } : {})
  }
}

/** Linhas do reenvio que não estavam no envio anterior do mesmo tipo. */
function addedLines(prev: string | undefined, next: string): number[] {
  if (prev === undefined) return []
  const seen = new Set(prev.split('\n'))
  const out: number[] = []
  next.split('\n').forEach((line, i) => {
    if (line.trim() && !seen.has(line)) out.push(i)
  })
  return out
}

export function contextBlocks({ detail, newer = null, usage = detail?.usage ?? null, subagent = false }: ContextBlocksInput): DisplayBlock[] {
  if (!detail) return []
  if (subagent) {
    const own = detail.blocks.map((b, i) => appBlock(b, i))
    return [
      ...own,
      {
        id: 'sub-engine', tone: 'miss', icon: 'engine', title: 'O que o motor carrega para o subagente',
        desc: 'As instruções base e as ferramentas dele, montadas pelo motor.', bytes: 0, tokens: 0, measured: false,
        note: 'O motor monta o resto do contexto do subagente sozinho. O app não vê esse texto nem o tamanho dele.'
      }
    ]
  }
  const system = detail.blocks.findIndex((b) => b.source === 'system')
  const sys = system >= 0 ? appBlock(detail.blocks[system], system) : null
  const ownTokens = detail.blocks.reduce((n, b) => (b.source === 'system' ? n : n + estimateTokens(b.bytes)), 0)
  const engine = engineBlocks(usage, sys?.tokens ?? 0, ownTokens)
  const first: DisplayBlock[] = []
  const later: DisplayBlock[] = []
  const lastText = new Map<ContextBlockKind, string>()
  detail.blocks.forEach((b, i) => {
    if (i === system || b.source === 'subagent') return
    const block = appBlock(b, i)
    if (b.source === 'hook-mid' || b.source === 'continuation' || b.source === 'system') {
      const added = addedLines(lastText.get(b.kind), b.text)
      later.push(added.length ? { ...block, added } : block)
    } else {
      first.push(block)
    }
    lastText.set(b.kind, b.text)
  })
  later.sort((a, b) => (a.when ?? 0) - (b.when ?? 0))
  const all = [...engine.before, ...(sys ? [sys] : []), ...engine.after, ...first, ...later]
  if (!newer) return all
  // Turno antigo: o mesmo texto do turno seguinte vem marcado (foi guardado uma vez só).
  const newerHashes = new Set(newer.blocks.map((b) => b.hash))
  const own = new Map(detail.blocks.map((b, i) => [`${b.source}:${b.kind}:${i}`, b.hash]))
  return all.map((b) => {
    const hash = own.get(b.id)
    return hash && newerHashes.has(hash) ? { ...b, same: true } : b
  })
}

/** O total que a tela mostra: o do SDK (autoritativo) ou, sem medição, a soma estimada. */
export function contextTotals(blocks: readonly DisplayBlock[], usage: ContextUsageSnapshot | null | undefined): { tokens: number; measured: boolean; appBytes: number } {
  const appBytes = blocks.reduce((n, b) => n + (b.text !== undefined ? b.bytes : 0), 0)
  if (usage && usage.totalTokens > 0) return { tokens: usage.totalTokens, measured: true, appBytes }
  return { tokens: blocks.reduce((n, b) => n + b.tokens, 0), measured: false, appBytes }
}

export type SecretSegment = { text: string } | { secret: string }

const SECRET_RE = new RegExp(`${escapeRe(SECRET_PLACEHOLDER_PREFIX)}([^${escapeRe(SECRET_PLACEHOLDER_SUFFIX)}]+)${escapeRe(SECRET_PLACEHOLDER_SUFFIX)}`, 'gu')

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** O texto em pedaços, com cada senha separada pelo nome. */
export function secretSegments(text: string): SecretSegment[] {
  const out: SecretSegment[] = []
  let last = 0
  for (const m of text.matchAll(SECRET_RE)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index) })
    out.push({ secret: m[1] })
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

/** Para copiar: a senha nunca vai, só o nome. */
export function maskedText(text: string): string {
  return text.replace(SECRET_RE, (_m, name: string) => `[senha: ${name}]`)
}

export function countHits(text: string | undefined, q: string): number {
  const query = q.trim().toLowerCase()
  if (!text || !query) return 0
  const hay = text.toLowerCase()
  let n = 0
  for (let at = hay.indexOf(query); at >= 0; at = hay.indexOf(query, at + query.length)) n++
  return n
}

/** "18,6 KB" */
export function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`
}

/** "13,4 mil" / "820" */
export function fmtTokens(tokens: number, exact = false): string {
  if (exact) return tokens.toLocaleString('pt-BR')
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1).replace('.', ',')} mil` : String(tokens)
}

/** Todo o texto que o app enviou no turno, com as senhas trocadas pelo nome. */
export function allContextText(blocks: readonly DisplayBlock[]): string {
  return blocks
    .filter((b) => b.text !== undefined)
    .map((b) => `===== ${b.title} (${kb(b.bytes)}) =====\n${maskedText(b.text!)}`)
    .join('\n\n')
}
