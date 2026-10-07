/**
 * A última ação do agente no editor do VS Code desenhado em canvas (codePaint.ts
 * põe a janela; isto, a aba, o status e a área do editor):
 *   read      aba em itálico (a de leitura do VS Code) e o trecho lido numerado;
 *   terminal  o código em cima e o painel TERMINAL embaixo, com o comando e o fim da saída;
 *   search    o editor de busca: o padrão, onde, quantos e as primeiras ocorrências;
 *   web       o navegador simples: endereço, o host e o que está fazendo;
 *   delegate  "Delegou para <subagente>" e a tarefa.
 * Só roda quando a página muda (MonitorTexture.draw).
 */
import type { ActionPage } from './actionPage'
import { chatPalette, ellipsize, roundRect, wrapText } from './chatPaint'
import type { CodePage } from './codePage'
import { C, fileColor, paintLines, type EditorView } from './codePaint'

type Ctx = CanvasRenderingContext2D

const ui = (size: number, weight = ''): string => `${weight} ${size}px ${chatPalette().font}`.trim()
const mono = (size: number): string => `${size}px ${chatPalette().mono}`

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** Texto centrado na área (o "{ }" do editor vazio usa o mesmo jeito). */
function hint(ctx: Ctx, text: string, x: number, y: number, w: number): void {
  ctx.font = ui(9.5)
  ctx.fillStyle = '#5a5a5a'
  const t = ellipsize(ctx, text, w - 20)
  ctx.fillText(t, x + (w - ctx.measureText(t).width) / 2, y)
}

function status(a: ActionPage, running: string, done: string, failed: string): string {
  return a.pending ? `● ${running}` : a.error ? `✕ ${failed}` : `✓ ${done}`
}

type Of<K extends ActionPage['kind']> = Extract<ActionPage, { kind: K }>

function readingView(a: Of<'read'>): EditorView {
  return {
    tab: { label: a.file || 'arquivo', color: fileColor(a.file), italic: true },
    status: a.error ? `✕ ${a.summary}` : a.summary,
    paint(ctx, x, y, w, h) {
      if (a.lines.length > 0) return paintLines(ctx, a.lines, a.firstLine, false, x, y, w, h)
      hint(ctx, a.pending ? 'Lendo…' : a.error ? 'Não deu para ler o arquivo' : 'O trecho lido não chegou à tela', x, y + h / 2, w)
    }
  }
}

const TERM_LINE_H = 12

function terminalView(a: Of<'terminal'>, page: CodePage): EditorView {
  return {
    status: status(a, 'executando', 'comando concluído', 'comando com erro'),
    paint(ctx, x, y, w, h) {
      const codeH = Math.round(h * 0.36)
      if (page.code.length > 0) paintLines(ctx, page.code, page.firstLine, false, x, y, w, codeH)
      const py = y + codeH
      const ph = h - codeH
      ctx.fillStyle = '#181818'
      ctx.fillRect(x, py, w, ph)
      ctx.fillStyle = '#2b2b2b'
      ctx.fillRect(x, py, w, 1)
      // Cabeçalho do painel: TERMINAL ativo e o shell à direita.
      ctx.font = ui(8, '600')
      let hx = x + 10
      for (const tab of ['PROBLEMS', 'OUTPUT', 'TERMINAL']) {
        const on = tab === 'TERMINAL'
        ctx.fillStyle = on ? '#e7e7e7' : C.dim
        ctx.fillText(tab, hx, py + 9)
        const tw = ctx.measureText(tab).width
        if (on) {
          ctx.fillStyle = '#e7e7e7'
          ctx.fillRect(hx, py + 15, tw, 1)
        }
        hx += tw + 14
      }
      const shell = a.shell === 'pwsh' ? 'powershell' : 'bash'
      ctx.fillStyle = C.dim
      ctx.fillText(shell, x + w - 10 - ctx.measureText(shell).width, py + 9)
      // Linhas: o prompt com o comando e o fim da saída; o que não cabe sai por cima.
      const prompt = a.shell === 'pwsh' ? 'PS> ' : '$ '
      type L = { text: string; color: string; prompt?: boolean }
      const lines: L[] = [{ text: a.command, color: '#ffffff', prompt: true }]
      if (a.more > 0) lines.push({ text: `… ${plural(a.more, 'linha', 'linhas')} acima`, color: C.dim })
      for (const o of a.output) lines.push({ text: o, color: a.error ? '#f48771' : '#cccccc' })
      const top = py + 22
      const fit = Math.max(1, Math.floor((py + ph - top - 4) / TERM_LINE_H))
      const shown = lines.length > fit ? [lines[0], ...lines.slice(lines.length - fit + 1)] : lines
      ctx.save()
      ctx.beginPath()
      ctx.rect(x, py, w, ph)
      ctx.clip()
      ctx.font = mono(9.5)
      shown.forEach((l, i) => {
        const ly = top + i * TERM_LINE_H + TERM_LINE_H / 2
        let lx = x + 10
        if (l.prompt) {
          ctx.fillStyle = a.shell === 'pwsh' ? '#cccccc' : '#89d185'
          ctx.fillText(prompt, lx, ly)
          lx += ctx.measureText(prompt).width
        }
        ctx.fillStyle = l.color
        const t = ellipsize(ctx, l.text, x + w - 10 - lx)
        ctx.fillText(t, lx, ly)
        if (a.pending && i === shown.length - 1) {
          ctx.fillStyle = '#cccccc'
          ctx.fillRect(Math.min(lx + ctx.measureText(t).width + 3, x + w - 8), ly - 5, 6, 10)
        }
      })
      ctx.restore()
    }
  }
}

function searchView(a: Of<'search'>): EditorView {
  const lines = a.hits.some((h) => h.line !== null)
  const count = a.pending ? 'Buscando…' : a.error ? 'A busca deu erro' : a.total === 0 ? 'Nenhum resultado' : plural(a.total, lines ? 'ocorrência' : 'arquivo', lines ? 'ocorrências' : 'arquivos')
  return {
    tab: { label: `Busca: ${a.pattern || '…'}`, color: '#cccccc' },
    status: status(a, 'buscando', a.total === 0 ? 'nada encontrado' : plural(a.total, 'resultado', 'resultados'), 'erro na busca'),
    paint(ctx, x, y, w, h) {
      // A caixa da busca com o padrão (a ferramenta à direita).
      roundRect(ctx, x + 10, y + 7, w - 20, 18, 2)
      ctx.fillStyle = '#3c3c3c'
      ctx.fill()
      ctx.fillStyle = '#007fd4'
      ctx.fillRect(x + 10, y + 24, w - 20, 1)
      ctx.font = mono(10)
      ctx.fillStyle = '#ffffff'
      ctx.fillText(ellipsize(ctx, a.pattern, w - 70), x + 16, y + 16)
      ctx.font = ui(8.5)
      ctx.fillStyle = C.dim
      ctx.fillText(a.tool, x + w - 16 - ctx.measureText(a.tool).width, y + 16)
      ctx.font = ui(9)
      ctx.fillText(ellipsize(ctx, `${count}${a.where ? ` · em ${a.where}` : ''}`, w - 24), x + 12, y + 36)
      ctx.save()
      ctx.beginPath()
      ctx.rect(x, y + 44, w, h - 44)
      ctx.clip()
      a.hits.forEach((hit, i) => {
        const ly = y + 52 + i * 14
        if (ly > y + h) return
        ctx.fillStyle = fileColor(hit.file)
        ctx.fillRect(x + 12, ly - 3, 6, 6)
        ctx.font = ui(9.5)
        ctx.fillStyle = '#e7e7e7'
        const name = ellipsize(ctx, hit.file, w * 0.45)
        ctx.fillText(name, x + 23, ly)
        let lx = x + 23 + ctx.measureText(name).width
        if (hit.line !== null) {
          const at = `:${hit.line}`
          ctx.fillStyle = C.dim
          ctx.fillText(at, lx, ly)
          lx += ctx.measureText(at).width
        }
        if (hit.text) {
          ctx.font = mono(9.5)
          ctx.fillStyle = C.ident
          ctx.fillText(ellipsize(ctx, hit.text, x + w - 10 - lx - 8), lx + 8, ly)
        }
      })
      ctx.restore()
    }
  }
}

function webView(a: Of<'web'>): EditorView {
  return {
    tab: { label: a.host || 'Navegador', color: '#3c8dde' },
    status: status(a, 'navegando', 'concluído', 'erro no navegador'),
    paint(ctx, x, y, w, h) {
      // Barra do navegador: voltar, avançar, recarregar e o endereço.
      ctx.fillStyle = C.side
      ctx.fillRect(x, y, w, 24)
      ctx.font = ui(10)
      ctx.fillStyle = C.dim
      ctx.fillText('←  →  ⟳', x + 8, y + 12)
      roundRect(ctx, x + 60, y + 4, w - 70, 16, 8)
      ctx.fillStyle = '#3c3c3c'
      ctx.fill()
      ctx.font = ui(9)
      ctx.fillStyle = '#e7e7e7'
      ctx.fillText(ellipsize(ctx, a.url || (a.tool === 'WebSearch' ? `Pesquisa: ${a.what}` : a.host || '—'), w - 90), x + 70, y + 12)
      // A "página": o host em destaque, o que ele faz e umas barras de conteúdo.
      const cx = x + w / 2
      ctx.font = ui(16, '700')
      ctx.fillStyle = '#e7e7e7'
      const host = ellipsize(ctx, a.host || 'Navegador', w - 30)
      ctx.fillText(host, cx - ctx.measureText(host).width / 2, y + 52)
      ctx.font = ui(10.5, '600')
      ctx.fillStyle = a.error ? '#f48771' : '#3c8dde'
      const doing = ellipsize(ctx, a.doing, w - 30)
      ctx.fillText(doing, cx - ctx.measureText(doing).width / 2, y + 76)
      ctx.font = ui(9.5)
      ctx.fillStyle = C.text
      wrapText(ctx, a.what, w - 40, 2).forEach((l, i) => ctx.fillText(l, cx - ctx.measureText(l).width / 2, y + 94 + i * 13))
      ctx.fillStyle = '#2a2a2a'
      for (let i = 0; i < 4; i++) {
        const by = y + 128 + i * 14
        if (by + 6 > y + h) break
        ctx.fillRect(x + 24, by, (w - 48) * (i % 2 ? 0.7 : 0.9), 6)
      }
    }
  }
}

function delegateView(a: Of<'delegate'>): EditorView {
  return {
    tab: { label: `Agente: ${a.who}`, color: '#c586c0' },
    status: status(a, 'subagente trabalhando', 'subagente terminou', 'subagente com erro'),
    paint(ctx, x, y, w, h) {
      const cx = x + w / 2
      const top = y + h / 2 - 46
      ctx.font = ui(10)
      ctx.fillStyle = C.dim
      const lead = 'Delegou para'
      ctx.fillText(lead, cx - ctx.measureText(lead).width / 2, top)
      ctx.font = ui(17, '700')
      ctx.fillStyle = a.error ? '#f48771' : '#c586c0'
      const who = ellipsize(ctx, a.who, w - 30)
      ctx.fillText(who, cx - ctx.measureText(who).width / 2, top + 24)
      ctx.font = ui(9.5)
      ctx.fillStyle = C.text
      wrapText(ctx, a.what, w - 40, 3).forEach((l, i) => ctx.fillText(l, cx - ctx.measureText(l).width / 2, top + 48 + i * 13))
    }
  }
}

/** O editor da última ação (a janela e o explorador continuam os do código). */
export function actionView(a: ActionPage, page: CodePage): EditorView {
  switch (a.kind) {
    case 'read':
      return readingView(a)
    case 'terminal':
      return terminalView(a, page)
    case 'search':
      return searchView(a)
    case 'web':
      return webView(a)
    case 'delegate':
      return delegateView(a)
  }
}
