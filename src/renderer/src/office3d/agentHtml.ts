/**
 * O HTML que o agente cria — PURO (sem relógio próprio: `now` vem de quem chama).
 *
 * Conta o .html/.htm que o agente escreveu com Write ou editou com Edit/MultiEdit
 * (sug-html-pelo-write), lido das ferramentas da conversa (principal: as
 * mensagens; subagente: os passos da trilha) — sem vigiar pasta nenhuma: o
 * `dist/index.html` de cada build, os relatórios de cobertura e o HTML gerado
 * por Bash ficam de fora, e já se sabe QUEM criou. Pastas geradas também
 * ficam de fora mesmo com Write: node_modules, dist, build, out, coverage e
 * `*-report`.
 *
 * `HtmlTracker` guarda quando cada escrita apareceu no feed (a 1ª vez; no 1º
 * feed, o histórico não conta como novo) e diz o HTML mais recente que deu
 * certo — a TV o mostra por HTML_SHOW_MS (prioridade 4, amb-tv-prioridade).
 * A mesma escrita não volta a ser "nova"; editar o arquivo de novo é escrita
 * nova (recaptura).
 *
 * `freshHtmlWrite` diz o HTML que um personagem acabou de criar: o clique nele
 * abre o monitor no Código com a Prévia desse arquivo.
 */
import type { OfficeFeed } from '../office/adapter/feed'
import type { OfficeCharacterModel } from '../office/adapter/model'
import type { UIMessage } from '../types'

/** Por quanto tempo o último HTML criado fica na TV. */
export const HTML_SHOW_MS = 5 * 60_000
/** Quantas mensagens do fim da conversa olhar (o último HTML é recente). */
const SCAN_BACK = 300

const WRITERS = new Set(['Write', 'Edit', 'MultiEdit'])
const GENERATED = new Set(['node_modules', 'dist', 'build', 'out', 'coverage'])

/** Uma escrita de HTML pelo agente. */
export interface HtmlWrite {
  /** Id da chamada (muda a cada escrita: editar de novo recaptura). */
  id: string
  convId: string
  /** O personagem que escreveu (principal ou subagente). */
  key: string
  /** Caminho como o agente passou (absoluto). */
  path: string
  /** Terminou sem erro (o arquivo existe). */
  ok: boolean
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** O caminho é de um HTML que conta (extensão e fora das pastas geradas). */
export function isAgentHtml(path: string): boolean {
  if (!/\.html?$/i.test(path)) return false
  const parts = path.split(/[\\/]+/).map((p) => p.toLowerCase())
  return !parts.slice(0, -1).some((p) => GENERATED.has(p) || p.endsWith('-report'))
}

/** O caminho escrito pela chamada, se é HTML que conta. */
function htmlOf(name: string, input: unknown): string | null {
  if (!WRITERS.has(name) || !input || typeof input !== 'object') return null
  const path = str((input as Record<string, unknown>).file_path)
  return path && isAgentHtml(path) ? path : null
}

function* principalWrites(messages: readonly UIMessage[]): Generator<{ id: string; name: string; input: unknown; done: boolean; ok: boolean }> {
  for (let i = messages.length - 1, n = 0; i >= 0 && n < SCAN_BACK; i--, n++) {
    const m = messages[i]
    if (m.kind === 'tool-use' && m.parentToolUseId == null) yield { id: m.id, name: m.name, input: m.input, done: !!m.result, ok: !!m.result && !m.result.isError }
  }
}

/** As escritas de HTML de cada personagem (a mais recente primeiro, por personagem). */
export function scanHtmlWrites(feed: OfficeFeed, characters: ReadonlyArray<Pick<OfficeCharacterModel, 'key' | 'convId' | 'role' | 'trackId'>>): HtmlWrite[] {
  const out: HtmlWrite[] = []
  for (const ch of characters) {
    if (ch.trackId) {
      const steps = feed.tracks[ch.convId]?.[ch.trackId]?.steps ?? []
      for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i]
        const path = htmlOf(s.name, s.input)
        if (path) out.push({ id: s.id, convId: ch.convId, key: ch.key, path, ok: s.result !== undefined && !s.isError })
      }
    } else if (ch.role === 'principal') {
      const conv = feed.conversations.find((c) => c.id === ch.convId)
      if (!conv) continue
      for (const c of principalWrites(conv.messages)) {
        const path = htmlOf(c.name, c.input)
        if (path) out.push({ id: c.id, convId: ch.convId, key: ch.key, path, ok: c.ok })
      }
    }
  }
  return out
}

/**
 * O HTML que o personagem ACABOU de criar (o clique nele abre o monitor na
 * Prévia): a última escrita dele que deu certo, se é do turno em andamento ou
 * terminou há menos de HTML_SHOW_MS, pelo relógio que o feed tem — o fim do
 * passo (subagente) ou o `ts` da resposta que fechou o turno (principal). Sem
 * relógio, vale o turno atual.
 */
export function freshHtmlWrite(feed: OfficeFeed, ch: Pick<OfficeCharacterModel, 'key' | 'convId' | 'role' | 'trackId'>, now: number): HtmlWrite | null {
  const w = scanHtmlWrites(feed, [ch]).find((x) => x.ok)
  if (!w) return null
  if (ch.trackId) {
    const t = feed.tracks[ch.convId]?.[ch.trackId]
    if (t?.status === 'running') return w
    const end = t?.steps.find((s) => s.id === w.id)?.endedAt
    return end !== undefined && now - end < HTML_SHOW_MS ? w : null
  }
  const msgs = feed.conversations.find((c) => c.id === ch.convId)?.messages ?? []
  let current = true
  let ts: number | null = null
  for (let i = msgs.findIndex((m) => m.kind === 'tool-use' && m.id === w.id) + 1; i > 0 && i < msgs.length; i++) {
    const m = msgs[i]
    // O ajuste do botão "agora" (injected) entra no turno em andamento: não abre outro.
    if (m.kind === 'user' && !m.injected) {
      current = false
      break
    }
    if (typeof m.ts === 'number') ts = m.ts
  }
  if (current && feed.busyIds.has(ch.convId)) return w
  if (ts !== null) return now - ts < HTML_SHOW_MS ? w : null
  return current ? w : null
}

export class HtmlTracker {
  /** id da escrita → quando apareceu (ms; -Infinity = histórico do 1º feed). */
  private readonly seen = new Map<string, number>()
  private primed = false
  private latest: { write: HtmlWrite; at: number } | null = null

  /** Feed novo: as escritas de agora. */
  update(writes: readonly HtmlWrite[], now: number): void {
    const ids = new Set<string>()
    for (const w of writes) {
      ids.add(w.id)
      let at = this.seen.get(w.id)
      if (at === undefined) at = this.primed ? now : -Infinity
      this.seen.set(w.id, at)
      if (w.ok && at > -Infinity && (!this.latest || at > this.latest.at || (at === this.latest.at && w.id !== this.latest.write.id && w.convId === this.latest.write.convId))) this.latest = { write: w, at }
    }
    for (const id of this.seen.keys()) if (!ids.has(id)) this.seen.delete(id)
    // A conversa saiu (ou o histórico encolheu): o último some junto.
    if (this.latest && !ids.has(this.latest.write.id)) this.latest = null
    this.primed = true
  }

  /** O HTML mais recente que deu certo, se ainda dentro de HTML_SHOW_MS (`project` filtra pelo projeto). */
  current(now: number, keep: (w: HtmlWrite) => boolean = () => true): HtmlWrite | null {
    const l = this.latest
    return l && now - l.at < HTML_SHOW_MS && keep(l.write) ? l.write : null
  }
}
