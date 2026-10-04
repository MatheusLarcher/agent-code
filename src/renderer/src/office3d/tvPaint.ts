/**
 * O que a TV desenha além da página (projectorPaint.ts), em canvas 2D — PURO:
 *
 *   paintScore    o placar da TV ociosa (prioridade 5): as tarefas do quadro
 *                 nas três colunas, a energia e quem está trabalhando — no
 *                 visual do mockup v2 (fundo verde-petróleo, "SALA DE REUNIÃO");
 *   paintBanner   a faixa de cima do chamado: quem chama e a mensagem;
 *   paintWaiting  o selo "+N esperando" (a fila da sala fora da tela).
 *
 * Tudo em `w`×`h` com a escala `s` (= w / PROJ_W), como o resto da TV.
 */
import { chatPalette, ellipsize, roundRect } from './chatPaint'

/** O placar: o quadro (do projeto do filtro ou de todos), a energia e quem trabalha. */
export interface ScoreData {
  /** O projeto do filtro; null = todos. */
  project: string | null
  todo: number
  doing: number
  done: number
  /** Energia do escritório (0..100) e o nível; null sem leitura. */
  energy: { pct: number; label: string } | null
  /** Quem está trabalhando agora (nomes). */
  working: readonly string[]
}

type Ctx = CanvasRenderingContext2D

const COLS: ReadonlyArray<{ label: string; bg: string; key: 'todo' | 'doing' | 'done' }> = [
  { label: 'A FAZER', bg: '#2a3b3d', key: 'todo' },
  { label: 'EM ANDAMENTO', bg: '#3a3a2c', key: 'doing' },
  { label: 'CONCLUÍDO', bg: '#2c3d30', key: 'done' }
]

export function paintScore(ctx: Ctx, w: number, h: number, d: ScoreData, s: number): void {
  const p = chatPalette()
  ctx.fillStyle = '#19272a'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#95ae9c'
  ctx.font = `${Math.round(13 * s)}px ${p.font}`
  ctx.fillText(ellipsize(ctx, `SALA DE REUNIÃO · ${d.project ?? 'TODOS OS PROJETOS'}`.toUpperCase(), w - 40 * s), 24 * s, 26 * s)
  ctx.fillStyle = '#e6ebdf'
  ctx.font = `600 ${Math.round(24 * s)}px ${p.font}`
  ctx.fillText('Placar do escritório', 24 * s, 58 * s)
  // As três colunas do quadro.
  const cw = (w - 48 * s - 2 * 12 * s) / 3
  COLS.forEach((c, i) => {
    const x = 24 * s + i * (cw + 12 * s)
    const y = 84 * s
    ctx.fillStyle = c.bg
    roundRect(ctx, x, y, cw, 104 * s, 10 * s)
    ctx.fill()
    ctx.fillStyle = '#9fb3a6'
    ctx.font = `600 ${Math.round(11 * s)}px ${p.font}`
    ctx.fillText(c.label, x + 14 * s, y + 20 * s)
    ctx.fillStyle = '#f1f0e7'
    ctx.font = `700 ${Math.round(44 * s)}px ${p.font}`
    ctx.fillText(String(d[c.key]), x + 14 * s, y + 64 * s)
    ctx.fillStyle = '#84917d'
    ctx.font = `${Math.round(11 * s)}px ${p.font}`
    ctx.fillText(d[c.key] === 1 ? 'tarefa' : 'tarefas', x + 14 * s, y + 92 * s)
  })
  // Energia: a barra.
  const ey = 214 * s
  ctx.fillStyle = '#95ae9c'
  ctx.font = `${Math.round(12 * s)}px ${p.font}`
  ctx.fillText(d.energy ? `ENERGIA · ${d.energy.label.toUpperCase()}` : 'ENERGIA', 24 * s, ey)
  const bw = w * 0.42
  ctx.fillStyle = '#2a3b3d'
  roundRect(ctx, 24 * s, ey + 12 * s, bw, 14 * s, 7 * s)
  ctx.fill()
  if (d.energy) {
    const k = Math.max(0, Math.min(1, d.energy.pct / 100))
    ctx.fillStyle = k > 0.5 ? '#6fcf8a' : k > 0.2 ? '#e3b341' : '#e5534b'
    roundRect(ctx, 24 * s, ey + 12 * s, Math.max(14 * s, bw * k), 14 * s, 7 * s)
    ctx.fill()
    ctx.fillStyle = '#e6ebdf'
    ctx.font = `600 ${Math.round(13 * s)}px ${p.font}`
    ctx.fillText(`${Math.round(d.energy.pct)}%`, 24 * s + bw + 10 * s, ey + 19 * s)
  }
  // Quem trabalha agora.
  const wy = 270 * s
  ctx.fillStyle = '#95ae9c'
  ctx.font = `${Math.round(12 * s)}px ${p.font}`
  ctx.fillText('TRABALHANDO AGORA', 24 * s, wy)
  ctx.fillStyle = '#e6ebdf'
  ctx.font = `${Math.round(15 * s)}px ${p.font}`
  const who = d.working.length ? d.working.join(' · ') : 'Ninguém — o escritório está tranquilo.'
  ctx.fillText(ellipsize(ctx, who, w - 48 * s), 24 * s, wy + 26 * s)
  ctx.fillStyle = '#5f7569'
  ctx.font = `${Math.round(11 * s)}px ${p.font}`
  ctx.fillText('Clique para abrir na TV', 24 * s, h - 18 * s)
}

/** A faixa do chamado no alto da TV. */
export function paintBanner(ctx: Ctx, w: number, b: { title: string; text: string }, s: number): void {
  const p = chatPalette()
  const bh = 44 * s
  ctx.fillStyle = 'rgba(217, 119, 87, 0.94)'
  ctx.fillRect(0, 0, w, bh)
  ctx.fillStyle = '#ffffff'
  ctx.font = `700 ${Math.round(15 * s)}px ${p.font}`
  ctx.fillText(ellipsize(ctx, b.title, w - 24 * s), 12 * s, 15 * s)
  ctx.font = `${Math.round(12 * s)}px ${p.font}`
  ctx.fillText(ellipsize(ctx, b.text, w - 24 * s), 12 * s, 33 * s)
}

/** O selo "+N esperando", embaixo à esquerda. */
export function paintWaiting(ctx: Ctx, h: number, n: number, s: number): void {
  const p = chatPalette()
  ctx.font = `700 ${Math.round(13 * s)}px ${p.font}`
  const label = `+${n} esperando`
  const bw = ctx.measureText(label).width + 22 * s
  const bh = 26 * s
  const y = h - bh - 10 * s
  ctx.fillStyle = 'rgba(12, 12, 16, 0.78)'
  roundRect(ctx, 10 * s, y, bw, bh, bh / 2)
  ctx.fill()
  ctx.fillStyle = '#ffd38a'
  ctx.fillText(label, 21 * s, y + bh / 2 + 0.5)
}
