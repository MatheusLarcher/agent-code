/**
 * A janela do VS Code desenhada em canvas 2D — a textura do monitor do agente
 * vista de longe (sem clicar): barra de título com o nome da conversa, barra de
 * atividades, explorador com os arquivos que o agente escreveu (U/M), abas, o
 * editor com números de linha e o trecho da última edição em cores (um
 * realce simples por palavra — palavra-chave, string, número, comentário,
 * chamada) e a barra de status na cor da sala. Só roda quando a página muda.
 */
import { chatPalette, ellipsize } from './chatPaint'
import type { CodePage } from './codePage'

type Ctx = CanvasRenderingContext2D

const C = {
  title: '#1f1f1f',
  activity: '#2c2c2c',
  side: '#252526',
  editor: '#1e1e1e',
  tabOff: '#2d2d2d',
  border: '#141414',
  text: '#cccccc',
  dim: '#8b8b8b',
  gutter: '#6e7681',
  select: '#37373d',
  status: '#007acc',
  added: '#73c991',
  modified: '#e2c08d',
  kw: '#569cd6',
  ctl: '#c586c0',
  str: '#ce9178',
  num: '#b5cea8',
  com: '#6a9955',
  fn: '#dcdcaa',
  type: '#4ec9b0',
  ident: '#9cdcfe'
}

const TITLE_H = 18
const ACT_W = 24
const SIDE_W = 128
const TAB_H = 20
const STATUS_H = 15
const LINE_H = 14.5

const KW = new Set(['const', 'let', 'var', 'function', 'class', 'interface', 'type', 'enum', 'new', 'this', 'true', 'false', 'null', 'undefined', 'void', 'def', 'self', 'None', 'True', 'False', 'public', 'private', 'readonly', 'static', 'async', 'extends', 'implements', 'in', 'of', 'typeof', 'keyof', 'as', 'string', 'number', 'boolean'])
const CTL = new Set(['if', 'else', 'for', 'while', 'return', 'import', 'export', 'from', 'await', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'default', 'yield', 'do'])

/** Cor de cada pedaço da linha (realce simples, por palavra). */
export function tokenize(line: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const re = /(\/\/.*$|#(?![\w-]*\s*[:{]).*$|--.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_.xXa-fA-F]*\b)|([A-Za-z_$][\w$]*)|(\s+|[^\sA-Za-z_$\d"'`]+)/g
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const [t, com, str, num, word] = m
    if (com) out.push([t, C.com])
    else if (str) out.push([t, C.str])
    else if (num) out.push([t, C.num])
    else if (word) {
      const next = line.slice(re.lastIndex).trimStart()[0]
      out.push([t, CTL.has(t) ? C.ctl : KW.has(t) ? C.kw : next === '(' ? C.fn : /^[A-Z]/.test(t) ? C.type : C.ident])
    } else out.push([t, C.text])
  }
  return out
}

/** Cor do glifo do arquivo pela extensão (a "etiqueta" do explorador). */
function fileColor(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'ts' || ext === 'tsx') return '#3178c6'
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs') return '#f1e05a'
  if (ext === 'css' || ext === 'scss') return '#c586c0'
  if (ext === 'json') return '#cbcb41'
  if (ext === 'md') return '#519aba'
  if (ext === 'py') return '#4b8bbe'
  if (ext === 'html') return '#e44d26'
  return '#8b8b8b'
}

/** Desenha a janela inteira em `w`×`h` (unidades do canvas; quem chama põe a escala). `accent` = cor da sala. */
export function paintCode(ctx: Ctx, page: CodePage, title: string, busy: boolean, accent: string, w: number, h: number): void {
  const p = chatPalette()
  const ui = (size: number, weight = ''): string => `${weight} ${size}px ${p.font}`.trim()
  const mono = (size: number): string => `${size}px ${p.mono}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'

  // Barra de título.
  ctx.fillStyle = C.title
  ctx.fillRect(0, 0, w, TITLE_H)
  ctx.font = ui(10)
  ctx.fillStyle = C.dim
  const head = ellipsize(ctx, `${page.files[0]?.name ? `${page.files[0].name} — ` : ''}${title || 'Agente'} — Visual Studio Code`, w - 120)
  ctx.fillText(head, (w - ctx.measureText(head).width) / 2, TITLE_H / 2)
  ctx.fillStyle = '#3c8dde'
  ctx.fillRect(7, 5, 8, 8)

  const top = TITLE_H
  const bottom = h - STATUS_H
  // Barra de atividades: explorador ativo (a faixa na cor da sala).
  ctx.fillStyle = C.activity
  ctx.fillRect(0, top, ACT_W, bottom - top)
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = i === 0 ? C.text : '#6b6b6b'
    ctx.fillRect(ACT_W / 2 - 5, top + 10 + i * 24, 10, 10)
  }
  ctx.fillStyle = accent
  ctx.fillRect(0, top + 6, 2, 18)

  // Explorador.
  const sx = ACT_W
  ctx.fillStyle = C.side
  ctx.fillRect(sx, top, SIDE_W, bottom - top)
  ctx.font = ui(8.5, '600')
  ctx.fillStyle = C.dim
  ctx.fillText('EXPLORER', sx + 9, top + 11)
  page.files.forEach((f, i) => {
    const y = top + 24 + i * 16
    if (i === 0) {
      ctx.fillStyle = C.select
      ctx.fillRect(sx, y, SIDE_W, 16)
    }
    ctx.fillStyle = fileColor(f.name)
    ctx.fillRect(sx + 10, y + 5, 6, 6)
    ctx.font = ui(10)
    ctx.fillStyle = f.status === 'U' ? C.added : C.modified
    ctx.fillText(ellipsize(ctx, f.name, SIDE_W - 40), sx + 21, y + 8)
    ctx.fillText(f.status, sx + SIDE_W - 13, y + 8)
  })
  if (page.files.length === 0) {
    ctx.font = ui(9.5)
    ctx.fillStyle = C.dim
    ctx.fillText('Nenhum arquivo alterado', sx + 10, top + 32)
  }

  // Abas.
  const ex = sx + SIDE_W
  const ew = w - ex
  ctx.fillStyle = C.side
  ctx.fillRect(ex, top, ew, TAB_H)
  let tx = ex
  ctx.font = ui(10)
  for (const [i, f] of page.files.slice(0, 3).entries()) {
    const label = ellipsize(ctx, f.name, 92)
    const tw = ctx.measureText(label).width + 30
    if (tx + tw > w) break
    ctx.fillStyle = i === 0 ? C.editor : C.tabOff
    ctx.fillRect(tx, top, tw, TAB_H)
    if (i === 0) {
      ctx.fillStyle = accent
      ctx.fillRect(tx, top, tw, 1.5)
    }
    ctx.fillStyle = fileColor(f.name)
    ctx.fillRect(tx + 8, top + TAB_H / 2 - 3, 6, 6)
    ctx.fillStyle = i === 0 ? '#ffffff' : C.dim
    ctx.fillText(label, tx + 19, top + TAB_H / 2)
    ctx.fillStyle = C.border
    ctx.fillRect(tx + tw - 1, top, 1, TAB_H)
    tx += tw
  }

  // Editor.
  const ey = top + TAB_H
  ctx.fillStyle = C.editor
  ctx.fillRect(ex, ey, ew, bottom - ey)
  if (page.code.length === 0) {
    ctx.font = ui(30, '700')
    ctx.fillStyle = '#2a2a2a'
    const mark = '{ }'
    ctx.fillText(mark, ex + (ew - ctx.measureText(mark).width) / 2, (ey + bottom) / 2 - 6)
    ctx.font = ui(9.5)
    ctx.fillStyle = '#5a5a5a'
    const hint = busy ? 'Pensando…' : 'Aguardando a próxima edição'
    ctx.fillText(hint, ex + (ew - ctx.measureText(hint).width) / 2, (ey + bottom) / 2 + 20)
  } else {
    const gw = 30
    ctx.save()
    ctx.beginPath()
    ctx.rect(ex, ey, ew, bottom - ey)
    ctx.clip()
    const rows = Math.min(page.code.length, Math.floor((bottom - ey - 6) / LINE_H))
    for (let i = 0; i < rows; i++) {
      const y = ey + 5 + i * LINE_H + LINE_H / 2
      ctx.font = mono(9.5)
      ctx.textAlign = 'right'
      ctx.fillStyle = i === rows - 1 && page.pending ? '#c6c6c6' : C.gutter
      ctx.fillText(String(page.firstLine + i), ex + gw - 6, y)
      ctx.textAlign = 'left'
      ctx.font = mono(10)
      let x = ex + gw + 4
      for (const [t, color] of tokenize(page.code[i])) {
        if (x > w) break
        ctx.fillStyle = color
        ctx.fillText(t, x, y)
        x += ctx.measureText(t).width
      }
      if (i === rows - 1 && page.pending) {
        ctx.fillStyle = '#aeafad'
        ctx.fillRect(Math.min(x + 1, w - 3), y - 6, 1.5, 12)
      }
    }
    ctx.restore()
  }

  // Barra de status.
  ctx.fillStyle = C.status
  ctx.fillRect(0, bottom, w, STATUS_H)
  ctx.fillStyle = accent
  ctx.fillRect(0, bottom, ACT_W, STATUS_H)
  ctx.font = ui(9)
  ctx.fillStyle = '#ffffff'
  ctx.fillText('⎇ main', ACT_W + 7, bottom + STATUS_H / 2)
  const right = busy ? '● trabalhando' : `${page.files.length} arquivo${page.files.length === 1 ? '' : 's'}`
  ctx.fillText(right, w - 8 - ctx.measureText(right).width, bottom + STATUS_H / 2)
}
