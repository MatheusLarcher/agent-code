/**
 * Tela do monitor vista à distância: o CÓDIGO real da ferramenta atual,
 * desenhado numa CanvasTexture em fonte mono com realce simples.
 *
 * O conteúdo vem de screenModel(currentTool(...)) (components/office/
 * screenContent.ts) — o mesmo modelo da tela 2D. `screenLines` e `tokenize`
 * são puros; `createMonitorTexture().draw` só redesenha quando a assinatura das
 * linhas muda, então não há custo por quadro.
 */
import { CanvasTexture, SRGBColorSpace } from 'three'
import type { ScreenModel } from '../components/office/screenContent'
import { canvas2d } from './textures'

export type LineKind = 'add' | 'del' | 'code' | 'cmd' | 'out' | 'meta'

export interface ScreenLine {
  kind: LineKind
  text: string
  /** Número de linha (leitura com numeração do Read), mostrado na margem. */
  gutter?: string
}

export interface ScreenPage {
  title: string
  subtitle: string
  lines: ScreenLine[]
}

export const MON_W = 512
export const MON_H = 288
export const MON_COLS = 58
export const MON_ROWS = 14

const baseName = (p: string): string => p.split(/[\\/]/).pop() || p

function clip(text: string, cols: number): string {
  const t = text.replace(/\t/g, '  ').replace(/\r/g, '')
  return t.length > cols ? t.slice(0, cols - 1) + '…' : t
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n')
}

/** Linha do Read ("   12→código" ou "12\tcódigo") → número + código. */
export function splitGutter(line: string): { gutter?: string; text: string } {
  const m = /^\s*(\d+)(?:→|\t)(.*)$/.exec(line)
  return m ? { gutter: m[1], text: m[2] } : { text: line }
}

/** O que cabe na tela para cada tipo de ferramenta. */
export function screenLines(model: ScreenModel, cols = MON_COLS, rows = MON_ROWS): ScreenPage {
  const c = (kind: LineKind, text: string, gutter?: string): ScreenLine => (gutter ? { kind, text: clip(text, cols - 5), gutter } : { kind, text: clip(text, cols) })
  switch (model.kind) {
    case 'empty':
      return { title: '', subtitle: '', lines: [] }
    case 'diff': {
      // O trecho novo manda; o antigo leva no máximo um terço da tela.
      const out: ScreenLine[] = []
      for (const h of model.hunks) {
        const olds = h.old ? splitLines(h.old) : []
        const news = splitLines(h.new)
        const budget = Math.max(1, rows - out.length)
        const oldMax = Math.min(olds.length, Math.max(1, Math.floor(budget / 3)))
        for (const l of olds.slice(0, oldMax)) out.push(c('del', `- ${l}`))
        for (const l of news) out.push(c('add', `+ ${l}`))
        if (out.length >= rows) break
      }
      return { title: model.tool, subtitle: baseName(model.path), lines: out.slice(0, rows) }
    }
    case 'write':
      return { title: model.tool, subtitle: baseName(model.path), lines: splitLines(model.text).slice(0, rows).map((l) => c('code', l)) }
    case 'read': {
      const lines = splitLines(model.text)
        .slice(0, rows)
        .map((l) => {
          const g = splitGutter(l)
          return c('code', g.text, g.gutter)
        })
      return { title: model.tool, subtitle: baseName(model.path), lines }
    }
    case 'bash': {
      const cmd = splitLines(model.command).map((l, i) => c('cmd', `${i === 0 ? '$' : '>'} ${l}`))
      const out = model.output ? splitLines(model.output).filter((l, i, a) => l || i < a.length - 1) : []
      const room = Math.max(0, rows - cmd.length)
      return { title: model.tool, subtitle: 'terminal', lines: [...cmd.slice(0, rows), ...out.slice(-room).map((l) => c('out', l))].slice(0, rows) }
    }
    case 'grep':
      return { title: model.tool, subtitle: model.pattern, lines: model.lines.slice(0, rows).map((l) => c('out', l)) }
    default:
      return { title: model.tool, subtitle: '', lines: splitLines(model.text).slice(0, rows).map((l) => c('meta', l)) }
  }
}

export type TokenKind = 'kw' | 'str' | 'com' | 'num' | 'plain'

const KEYWORDS = new Set(
  (
    'const let var function return if else for while do switch case break continue new class extends import export from default ' +
    'async await try catch finally throw typeof instanceof interface type enum public private protected readonly static ' +
    'def elif in not and or is None True False lambda yield with as pass self null undefined true false void this'
  ).split(' ')
)

/** Realce simples: comentário, string, número, palavra-chave. Concatenar os tokens devolve a linha. */
export function tokenize(line: string): Array<{ text: string; kind: TokenKind }> {
  const out: Array<{ text: string; kind: TokenKind }> = []
  const push = (text: string, kind: TokenKind): void => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && last.kind === kind) last.text += text
    else out.push({ text, kind })
  }
  const re = /(\/\/.*$|#.*$|\/\*.*?(?:\*\/|$))|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g
  let i = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) {
    if (m.index > i) push(line.slice(i, m.index), 'plain')
    if (m[1]) push(m[1], 'com')
    else if (m[2]) push(m[2], 'str')
    else if (m[3]) push(m[3], 'num')
    else push(m[4], KEYWORDS.has(m[4]) ? 'kw' : 'plain')
    i = m.index + m[0].length
  }
  if (i < line.length) push(line.slice(i), 'plain')
  return out
}

const TOKEN_COLORS: Record<TokenKind, string> = { kw: '#c586c0', str: '#ce9178', com: '#6a9955', num: '#b5cea8', plain: '#d4d4d4' }
const LINE_BG: Partial<Record<LineKind, string>> = { add: 'rgba(60,180,90,0.22)', del: 'rgba(230,70,70,0.22)' }
const LINE_FG: Partial<Record<LineKind, string>> = { add: '#9ff0b4', del: '#ffb0a8', cmd: '#7dff9b', out: '#b9c4d0', meta: '#c8d0dc' }

export interface MonitorTexture {
  texture: CanvasTexture
  /** Fração de MON_W×MON_H do canvas (1 perto; 0,5 no LOD médio). */
  scale: number
  /** Redesenha só quando a página muda; true se redesenhou. */
  draw(page: ScreenPage, accent: string): boolean
}

/** `scale` < 1: canvas menor (o desenho é o mesmo, em escala) — a tela vista de média distância. */
export function createMonitorTexture(anisotropy = 1, scale = 1): MonitorTexture {
  const { canvas, ctx } = canvas2d(Math.round(MON_W * scale), Math.round(MON_H * scale))
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = anisotropy
  let last = ''
  return {
    texture,
    scale,
    draw(page, accent) {
      const sig = JSON.stringify(page) + accent
      if (sig === last) return false
      last = sig
      if (!ctx) return true
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      ctx.fillStyle = '#1e1e1e'
      ctx.fillRect(0, 0, MON_W, MON_H)
      // Barra de título estilo editor.
      ctx.fillStyle = '#2d2d30'
      ctx.fillRect(0, 0, MON_W, 30)
      ctx.fillStyle = accent
      ctx.fillRect(0, 28, MON_W, 2)
      for (const [i, col] of ['#ff5f57', '#febc2e', '#28c840'].entries()) {
        ctx.fillStyle = col
        ctx.beginPath()
        ctx.arc(14 + i * 16, 15, 5, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.textBaseline = 'middle'
      ctx.font = 'bold 15px Consolas, "Cascadia Mono", monospace'
      ctx.fillStyle = '#ffffff'
      ctx.fillText(page.title, 66, 15)
      const tw = ctx.measureText(page.title).width
      ctx.font = '14px Consolas, "Cascadia Mono", monospace'
      ctx.fillStyle = '#9cdcfe'
      ctx.fillText(page.subtitle, 66 + tw + 10, 15, MON_W - tw - 86)
      // Código.
      const lineH = 17
      ctx.font = '14px Consolas, "Cascadia Mono", monospace'
      const cw = ctx.measureText('M').width || 7.7
      page.lines.forEach((l, i) => {
        const y = 36 + i * lineH
        const bg = LINE_BG[l.kind]
        if (bg) {
          ctx.fillStyle = bg
          ctx.fillRect(0, y, MON_W, lineH)
        }
        let x = 8
        if (l.gutter) {
          ctx.fillStyle = '#5a6270'
          ctx.fillText(l.gutter.padStart(4), x, y + lineH / 2)
          x += cw * 5
        }
        const fg = LINE_FG[l.kind]
        if (l.kind === 'code' || l.kind === 'add' || l.kind === 'del') {
          const prefix = l.kind === 'code' ? '' : l.text.slice(0, 2)
          if (prefix) {
            ctx.fillStyle = fg ?? '#d4d4d4'
            ctx.fillText(prefix, x, y + lineH / 2)
            x += cw * 2
          }
          for (const t of tokenize(l.text.slice(prefix.length))) {
            ctx.fillStyle = TOKEN_COLORS[t.kind]
            ctx.fillText(t.text, x, y + lineH / 2)
            x += cw * t.text.length
          }
        } else {
          ctx.fillStyle = fg ?? '#d4d4d4'
          ctx.fillText(l.text, x, y + lineH / 2)
        }
      })
      // Cursor no fim.
      const n = page.lines.length
      if (n < MON_ROWS) {
        ctx.fillStyle = accent
        ctx.fillRect(8, 38 + n * lineH, cw, lineH - 4)
      }
      texture.needsUpdate = true
      return true
    }
  }
}
