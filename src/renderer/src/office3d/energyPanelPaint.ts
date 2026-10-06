/**
 * O que o quadro de energia da parede escreve (energyPanel.ts), em canvas: o
 * painel escuro do alto ("⚡ Pessoal" e a % grandes na cor do nível, a recarga
 * embaixo e as outras contas pequenas à direita) e a fita clara de nomes
 * embaixo das baterias (a conta em destaque em maiúsculas; sob cada pilha da
 * doca, o nome e a %). Cada um tem a assinatura do texto: o canvas só é
 * redesenhado quando ela muda.
 */
import type { BankAccount } from './accountBank'
import { LEVEL_COLORS, POWER_LABEL, resetClock, type OfficePower } from './power'

export const PANEL_PX = { w: 1024, h: 200 } as const
export const STRIP_PX = { w: 1024, h: 96 } as const
/** A fita clara (cinza claro do armário) e os textos escuros dela. */
const STRIP = { bg: '#c2c6cb', feat: '#20252b', sname: '#4f5661', spct: '#363c45' } as const

/** O nome da tomada: a conta em destaque (ou, sem lista de contas, o escritório). */
export const featuredName = (p: OfficePower | null): string => p?.bank.find((b) => b.id === p.accountId)?.name ?? 'Escritório'

/** A linha de baixo do painel: "recarrega às 23:40", "Modo economia · …", "Bateria fraca · …" ou "Apagão — recarrega às …". */
export function panelSubline(p: OfficePower | null, now: number): string {
  if (!p) return 'Sem leitura da sessão de 5h'
  if (p.unread) return 'ainda sem leitura'
  const time = resetClock(p.resetsAt, now)
  if (p.level === 'apagao') return time ? `Apagão — recarrega às ${time}` : 'Apagão — recarrega na próxima janela'
  const when = time ? `recarrega às ${time}` : 'janela de 5 h ainda sem uso'
  return p.level === 'cheia' ? when : `${POWER_LABEL[p.level]} · ${when}`
}

const pctOf = (b: BankAccount): string => (b.pct === null ? '—' : `${b.pct}%`)

/** Assinatura do painel (o que ele mostra). */
export function panelSig(p: OfficePower | null, spares: readonly BankAccount[], now: number): string {
  return `${featuredName(p)}|${p ? (p.unread ? '—' : p.pct) : '-'}|${p?.level ?? ''}|${panelSubline(p, now)}|${spares.map((s) => `${s.name}:${pctOf(s)}:${s.level}`).join(',')}`
}

export function drawPanel(ctx: CanvasRenderingContext2D, p: OfficePower | null, spares: readonly BankAccount[], now: number): void {
  const { w, h } = PANEL_PX
  const col = p ? LEVEL_COLORS[p.level] : '#aab1bd'
  ctx.fillStyle = '#0d1016'
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = col
  ctx.lineWidth = 8
  ctx.strokeRect(8, 8, w - 16, h - 16)
  ctx.textBaseline = 'middle'
  ctx.fillStyle = col
  ctx.textAlign = 'right'
  ctx.font = 'bold 76px "Segoe UI", sans-serif'
  const pct = p ? (p.unread ? '—' : `${p.pct}%`) : '--%'
  ctx.fillText(pct, w - 40, 70)
  const pctW = ctx.measureText(pct).width
  ctx.textAlign = 'left'
  let size = 66
  const name = `⚡ ${featuredName(p)}`
  ctx.font = `bold ${size}px "Segoe UI", "Segoe UI Emoji", sans-serif`
  while (size > 34 && ctx.measureText(name).width > w - 120 - pctW) {
    size -= 4
    ctx.font = `bold ${size}px "Segoe UI", "Segoe UI Emoji", sans-serif`
  }
  ctx.fillText(name, 40, 70)
  ctx.fillStyle = '#cfd5de'
  ctx.font = '600 30px "Segoe UI", sans-serif'
  const sub = panelSubline(p, now)
  ctx.fillText(sub, 42, 140)
  // As outras contas, pequenas e apagadas, à direita da linha de baixo (as que couberem).
  ctx.textAlign = 'right'
  ctx.font = '600 28px "Segoe UI", sans-serif'
  const floor = 42 + ctx.measureText(sub).width + 40
  let x = w - 40
  for (const s of [...spares].reverse()) {
    const t = `${s.name} ${pctOf(s)}`
    const tw = ctx.measureText(t).width
    if (x - tw - 22 < floor) break
    ctx.fillStyle = '#727a88'
    ctx.fillText(t, x, 140)
    ctx.fillStyle = s.level ? LEVEL_COLORS[s.level] : '#5a6170'
    ctx.globalAlpha = 0.55
    ctx.fillRect(x - tw - 22, 128, 10, 24)
    ctx.globalAlpha = 1
    x -= tw + 46
  }
}

/** Assinatura da fita de nomes. */
export function stripSig(name: string, spares: readonly BankAccount[], more: number): string {
  return `${name}|${spares.map((s) => `${s.name}:${pctOf(s)}`).join(',')}|${more}`
}

/**
 * A fita clara embaixo das baterias. `toPx` leva o x local do armário à coluna do canvas;
 * `slots` = o x de cada encaixe da doca; `more` > 0 escreve "+N" (contas que não couberam).
 */
export function drawStrip(ctx: CanvasRenderingContext2D, name: string, featX: number, spares: readonly BankAccount[], slots: readonly number[], more: number, toPx: (x: number) => number): void {
  const { w, h } = STRIP_PX
  ctx.fillStyle = STRIP.bg
  ctx.fillRect(0, 0, w, h)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = STRIP.feat
  ctx.font = 'bold 34px "Segoe UI", sans-serif'
  ctx.fillText(name.toUpperCase(), toPx(featX), 50, 300)
  spares.forEach((s, i) => {
    ctx.fillStyle = STRIP.sname
    ctx.font = '600 22px "Segoe UI", sans-serif'
    ctx.fillText(s.name, toPx(slots[i]), 32, 130)
    ctx.fillStyle = STRIP.spct
    ctx.font = 'bold 26px "Segoe UI", sans-serif'
    ctx.fillText(pctOf(s), toPx(slots[i]), 66)
  })
  if (more > 0) {
    ctx.fillStyle = STRIP.sname
    ctx.font = 'bold 26px "Segoe UI", sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(`+${more}`, w - 16, 50)
  }
}
