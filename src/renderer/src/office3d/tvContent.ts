/**
 * O conteúdo da TV além do teste ao vivo (Projectors cuida dos quadros do
 * navegador): o HTML que o agente cria (agentHtml.ts + htmlCaptures.ts), os
 * chamados (officeCalls.ts), o placar e o filtro de projeto.
 *
 *   feed(feed, chars, now)   as escritas de HTML, os chamados abertos (na ordem
 *                            de chegada; só de quem está no escritório) e, por
 *                            conversa, o cwd, o título e o projeto;
 *   tick(now)                a marca de um chamado mudou (abriu na TV, o arquivo
 *                            sumiu): refaz a lista; true se mudou;
 *   agenda(tests, now)       quem manda na TV agora (tvAgenda.ts), com o filtro,
 *                            e pede a captura do HTML que vai para a tela;
 *   pageView(...)            a janela de navegador com o arquivo e a captura
 *                            (ou o esqueleto), a faixa do chamado e o placar.
 */
import type { OfficeFeed } from '../office/adapter/feed'
import { principalKey, type OfficeCharacterModel } from '../office/adapter/model'
import { HtmlTracker, scanHtmlWrites, type HtmlWrite } from './agentHtml'
import { appMockupApi, HtmlCaptures } from './htmlCaptures'
import { callMarks, CallQueue, openCalls, type OfficeCall } from './officeCalls'
import type { PageImage, ProjectorView } from './projectorPaint'
import type { DeviceUse } from './projectorUse'
import { tvAgenda, type TvAgenda } from './tvAgenda'
import type { ScoreData } from './tvPaint'

export type TvChar = Pick<OfficeCharacterModel, 'key' | 'convId' | 'role' | 'trackId'> & { projectId?: string | null }

export const EMPTY_SCORE: ScoreData = { project: null, todo: 0, doing: 0, done: 0, energy: null, working: [] }

const bitmapImage = (bmp: ImageBitmap): PageImage => ({ width: bmp.width, height: bmp.height, draw: (ctx, x, y, w, h) => ctx.drawImage(bmp, x, y, w, h) })

/** O caminho relativo ao cwd (com barras normais) e o nome do arquivo. */
export function fileLabel(path: string, cwd: string): { rel: string; name: string } {
  const inside = !!cwd && path.toLowerCase().startsWith(cwd.toLowerCase())
  const rel = (inside ? path.slice(cwd.length).replace(/^[\\/]+/, '') : path).replace(/\\/g, '/')
  return { rel, name: rel.split('/').pop() ?? rel }
}

export class TvContent {
  private readonly html = new HtmlTracker()
  private readonly captures: HtmlCaptures
  private readonly queue = new CallQueue()
  private calls: OfficeCall[] = []
  private lastFeed: OfficeFeed | null = null
  private present = new Set<string>()
  private readonly convs = new Map<string, { cwd: string; title: string; projectId: string | null }>()
  private dirty = false
  private readonly offMarks: () => void
  /** Filtro de projeto (o id; null = todos): a TV só mostra itens dele. */
  filter: string | null = null
  /** O placar do projeto (ou de todos): o motor liga o Quadro e a energia; quem trabalha vem do feed. */
  scoreboard: (projectId: string | null) => Omit<ScoreData, 'working'> = () => EMPTY_SCORE
  private busy: string[] = []

  constructor(
    /** Captura nova (ou falha): a TV redesenha. */
    onCapture: () => void,
    /** Uma marca de chamado mudou: a cena pede um tique. */
    private readonly onMarks: () => void,
    clock: () => number = () => Date.now()
  ) {
    this.captures = new HtmlCaptures(appMockupApi(), onCapture, clock)
    this.offMarks = callMarks.subscribe(() => {
      this.dirty = true
      this.onMarks()
    })
  }

  feed(feed: OfficeFeed | null, characters: readonly TvChar[], now: number): void {
    this.html.update(feed ? scanHtmlWrites(feed, characters) : [], now)
    this.lastFeed = feed
    this.present = new Set(characters.map((c) => c.key))
    const pid = new Map(characters.map((c) => [c.convId, c.projectId ?? null] as const))
    this.convs.clear()
    for (const c of feed?.conversations ?? []) this.convs.set(c.id, { cwd: c.cwd, title: c.title, projectId: pid.get(c.id) ?? null })
    this.busy = [...(feed?.busyIds ?? [])].filter((id) => this.present.has(principalKey(id)))
    this.refreshCalls(now)
  }

  tick(now: number): boolean {
    if (!this.dirty) return false
    const before = this.calls.map((c) => c.id).join('|')
    this.refreshCalls(now)
    return this.calls.map((c) => c.id).join('|') !== before
  }

  private refreshCalls(now: number): void {
    const open = this.lastFeed ? openCalls(this.lastFeed, now, (id) => callMarks.ended(id)) : []
    this.calls = this.queue.order(open.filter((c) => this.present.has(c.key)), now)
    this.dirty = false
  }

  /** Os chamados abertos de quem está no escritório (o 1º fica ao lado da TV); sem filtro. */
  get openCalls(): readonly OfficeCall[] {
    return this.calls
  }

  readonly keep = (convId: string): boolean => !this.filter || this.convs.get(convId)?.projectId === this.filter

  /** Quem manda na TV agora; pede a captura do HTML que vai para a tela (e solta a de antes). */
  agenda(tests: readonly DeviceUse[], now: number): TvAgenda {
    const a = tvAgenda(this.calls, tests, this.html.current(now), this.keep)
    const m = a.main
    const w = m.kind === 'call' ? this.callWrite(m.call) : m.kind === 'html' ? m.write : null
    const cwd = w ? this.convs.get(w.convId)?.cwd : undefined
    if (w && cwd) this.captures.want(w, cwd)
    else if (!w) this.captures.clear()
    return a
  }

  private callWrite(c: OfficeCall): HtmlWrite {
    return { id: c.id, convId: c.convId, key: c.key, path: c.path, ok: true }
  }

  cwdOf(convId: string): string {
    return this.convs.get(convId)?.cwd ?? ''
  }

  titleOf(convId: string): string {
    return this.convs.get(convId)?.title || 'Agente'
  }

  /** O estado da captura do arquivo (para a assinatura do desenho). */
  captureState(id: string): 'p' | 'f' | 'ok' {
    const img = this.captures.image(id)
    return img === null ? 'p' : img === 'failed' ? 'f' : 'ok'
  }

  /** A janela de navegador com o HTML (a captura; sem ela, `fallback` — a página da demo — ou o esqueleto). `id` = a escrita ou o chamado. */
  pageView(id: string, path: string, convId: string, project: string, fallback: PageImage | null = null): ProjectorView {
    const img = this.captures.image(id)
    const { rel, name } = fileLabel(path, this.cwdOf(convId))
    return { kind: 'web', url: rel, title: name, live: false, project, image: img && img !== 'failed' ? bitmapImage(img) : fallback }
  }

  /** A faixa do chamado: quem chama e a mensagem (ou o arquivo). */
  banner(c: OfficeCall): { title: string; text: string } {
    return { title: `📣 ${this.titleOf(c.convId)} está te chamando`, text: c.mensagem ?? `Quer te mostrar ${fileLabel(c.path, c.cwd).name}` }
  }

  /** O placar do projeto do filtro (ou de todos), com quem trabalha agora. */
  scoreView(project: string): ProjectorView {
    const working = this.busy.filter(this.keep).map((id) => this.titleOf(id)).slice(0, 8)
    return { kind: 'web', url: '', title: '', live: false, project, image: null, score: { ...this.scoreboard(this.filter), working } }
  }

  dispose(): void {
    this.captures.dispose()
    this.offMarks()
  }
}
