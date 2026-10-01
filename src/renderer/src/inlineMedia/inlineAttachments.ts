import type { FileAttachment, FileRefAttachment, ImageAttachment, PickedElement } from '@shared/ipc'
import { mediaLabel, mediaMarker, mediaLabelNumber } from '@shared/inlineMedia'
import { fileMeta, fmtSize } from '../files'
import { TOKEN } from './editorModel'
import type { DraftRefMedia } from './draftMedia'
import { buildQuotedMessage, chipLabel, quoteRef, type Quote } from '../components/quoteComment/quoteFormat'

/**
 * Anexos do composer inline: o registro (id -> anexo), a imagem que o item
 * mostra no campo, a serialização do envio (`{{midia:N}}` + anexos rotulados),
 * o rascunho e o índice da bolha. Sem React e sem DOM do campo.
 */

export type InlineAtt =
  // `stored`: cópia em disco feita para o rascunho (ver draftMedia.ts).
  | { id: string; kind: 'image'; name: string; image: ImageAttachment; src: string; stored?: string }
  | { id: string; kind: 'file'; name: string; file: FileAttachment; src: string; stored?: string }
  | { id: string; kind: 'ref'; name: string; ref: FileRefAttachment; src: string }
  /** Ainda resolvendo; não é enviado (o envio espera). `line`: caminho/URL colado, que dá para resolver de novo.
   *  `from`: o item do rascunho que está sendo relido/conferido (um flush no meio grava ele de novo, igual). */
  | { id: string; kind: 'pending'; name: string; src: string; line?: string; from?: DraftRefMedia }
  /** Trecho de uma resposta do agente ("Comentar"): no envio vira "[trecho N]" + a citação no topo.
   *  `name` é "trecho N" (N = ordem no texto; ver quoteComment/quoteToken.ts). */
  | { id: string; kind: 'quote'; name: string; quote: Quote; src: string }
  /** Elemento da página ("Selecionar" do navegador): no envio vira "[elemento N]" + os detalhes no fim.
   *  `name` é "elemento N" (ver elementPick/elementToken.ts). */
  | { id: string; kind: 'element'; name: string; el: PickedElement; src: string }

let seq = 0
export function newAttId(): string {
  return `att${Date.now().toString(36)}${(++seq).toString(36)}`
}

// ---------- imagem do item no campo ----------

const BADGE: Record<string, string> = {
  pdf: '#df5048', doc: '#4a82e0', xls: '#3aa162', ppt: '#e0863a', txt: '#7d828c', zip: '#9a6fd0', code: '#2fb0a6', file: '#6b7280'
}
const CHIP_FONT = "12px 'Segoe UI', system-ui, sans-serif"
const MAX_CHIP_NAME = 28

function xml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
}

function shortName(name: string): string {
  return name.length > MAX_CHIP_NAME ? `${name.slice(0, MAX_CHIP_NAME - 1)}…` : name
}

function textWidth(text: string): number {
  try {
    // jsdom (testes) não tem canvas: vai direto para a estimativa.
    const ctx = /jsdom/i.test(navigator.userAgent) ? null : document.createElement('canvas').getContext('2d')
    if (ctx) {
      ctx.font = CHIP_FONT
      const w = ctx.measureText(text).width
      if (w > 0) return Math.ceil(w)
    }
  } catch {
    /* sem canvas (teste): estimativa abaixo */
  }
  return Math.ceil(text.length * 6.6)
}

/** Chip "badge da extensão + nome" como SVG (vira o src de um <img>, que é atômico no campo). */
export function chipSvg(name: string, opts: { pending?: boolean } = {}): string {
  const meta = fileMeta(name)
  const label = opts.pending ? `resolvendo ${shortName(name)}` : shortName(name)
  const badgeW = opts.pending ? 18 : Math.max(22, meta.ext.length * 6 + 8)
  const w = badgeW + 6 + textWidth(label) + 8
  const badge = opts.pending
    ? `<circle cx="11" cy="10" r="5" fill="none" stroke="#9aa0a6" stroke-width="2" stroke-dasharray="16 8"/>`
    : `<rect x="2" y="2" width="${badgeW}" height="16" rx="4" fill="${BADGE[meta.kind]}"/>` +
      `<text x="${2 + badgeW / 2}" y="13.5" text-anchor="middle" font-family="ui-monospace, monospace" font-size="8.5" font-weight="700" fill="#fff">${xml(meta.ext)}</text>`
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" viewBox="0 0 ${w} 20">` +
    `<rect x="0.5" y="0.5" width="${w - 1}" height="19" rx="6" fill="#2b2f36" stroke="#4a505a"/>` +
    badge +
    `<text x="${badgeW + 8}" y="14" font-family="'Segoe UI', system-ui, sans-serif" font-size="12" fill="${opts.pending ? '#9aa0a6' : '#e8eaed'}">${xml(label)}</text>` +
    `</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** Miniatura como data: URL — a CSP do app só libera `img-src 'self' data:` (blob: é bloqueado). */
export function imageSrc(img: ImageAttachment): string {
  return `data:${img.mediaType};base64,${img.data}`
}

export function releaseSrc(att: InlineAtt): void {
  if (att.src.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(att.src)
    } catch {
      /* nada a liberar */
    }
  }
}

export function makeImageAtt(image: ImageAttachment, name: string): InlineAtt {
  return { id: newAttId(), kind: 'image', name: name || 'imagem', image, src: imageSrc(image) }
}
export function makeFileAtt(file: FileAttachment): InlineAtt {
  return { id: newAttId(), kind: 'file', name: file.name, file, src: chipSvg(file.name) }
}
export function makeRefAtt(ref: FileRefAttachment): InlineAtt {
  return { id: newAttId(), kind: 'ref', name: ref.name, ref, src: chipSvg(ref.name) }
}
/** Item resolvendo. `line` só para caminho/URL colado (arquivo lido do disco não tem como refazer). */
export function makePendingAtt(label: string, line?: string, id: string = newAttId()): InlineAtt {
  const name = label.trim().split(/[\\/]+/).filter(Boolean).pop() || label.trim()
  return { id, kind: 'pending', name, src: chipSvg(name, { pending: true }), ...(line ? { line } : {}) }
}

/** Texto acessível do item (alt do <img>). */
export function attAlt(att: InlineAtt): string {
  if (att.kind === 'image') return `Imagem anexada: ${att.name}`
  if (att.kind === 'pending') return `Resolvendo anexo: ${att.name}`
  if (att.kind === 'quote') return `Trecho citado ${att.name.replace(/^trecho /, '')}: ${chipLabel(att.quote.text)}`
  if (att.kind === 'element') return `Elemento da página ${att.name.replace(/^elemento /, '')}: ${att.el.tagName}${att.el.id ? '#' + att.el.id : ''}`
  const size = att.kind === 'file' ? att.file.size : att.ref.size
  return `Arquivo anexado: ${att.name}${size ? ` (${fmtSize(size)})` : ''}`
}

// ---------- envio ----------

/**
 * Onde a cópia do rascunho fica depois do envio: o mesmo arquivo, um nível
 * acima de `rascunho/` (`attachments/<conversa>/<nome>`). O main a move para lá
 * no envio (promoteDraftCopy). Outro caminho volta igual.
 */
export function sentCopyPath(stored: string): string {
  const m = /^(.*)[\\/]rascunho([\\/])([^\\/]+)$/i.exec(stored)
  return m ? `${m[1]}${m[2]}${m[3]}` : stored
}

export interface OutgoingMessage {
  text: string
  images: ImageAttachment[]
  files: FileAttachment[]
  fileRefs: FileRefAttachment[]
  /** Elementos da página, na ordem dos "[elemento N]" do texto. */
  elements: PickedElement[]
}

/**
 * Texto do campo -> mensagem. Cada anexo vira `{{midia:N}}` no ponto exato e
 * segue como anexo normal com o rótulo `midia:N = nome` (N = ordem no texto).
 * Trecho citado ("Comentar") não é mídia: vira "[trecho K]" no ponto dele (K =
 * ordem entre os trechos) e o bloco citado vai na frente do texto.
 * Sem anexo no texto, o texto sai idêntico. Item removido do texto não vai.
 */
export function serializeInline(
  value: string,
  order: readonly string[],
  atts: ReadonlyMap<string, InlineAtt>
): OutgoingMessage {
  const out: OutgoingMessage = { text: '', images: [], files: [], fileRefs: [], elements: [] }
  if (!value.includes(TOKEN)) return { ...out, text: value }
  let next = 0
  let n = 0
  const quotes: Quote[] = []
  for (const ch of value) {
    if (ch !== TOKEN) {
      out.text += ch
      continue
    }
    const att = atts.get(order[next++] ?? '')
    if (!att || att.kind === 'pending') continue
    if (att.kind === 'quote') {
      quotes.push(att.quote)
      out.text += quoteRef(quotes.length)
      continue
    }
    if (att.kind === 'element') {
      out.elements.push(att.el)
      out.text += `[elemento ${out.elements.length}]`
      continue
    }
    n++
    out.text += mediaMarker(n)
    const label = mediaLabel(n, att.name)
    if (att.kind === 'image') out.images.push({ ...att.image, label })
    // Arquivo que o rascunho já copiou para o disco: vai pelo caminho da pasta do ENVIO (o main move a cópia para lá).
    else if (att.kind === 'file' && att.stored)
      out.fileRefs.push({ name: att.file.name, path: sentCopyPath(att.stored), mediaType: att.file.mediaType, size: att.file.size, label })
    else if (att.kind === 'file') out.files.push({ ...att.file, label })
    else out.fileRefs.push({ ...att.ref, label })
  }
  if (quotes.length) out.text = buildQuotedMessage(quotes, out.text)
  return out
}

// ---------- rascunho: ver draftMedia.ts ----------
export type { DraftMedia } from './draftMedia'

function nameOf(label: string | undefined): string {
  return label?.replace(/^midia:\d+ = /, '') || 'imagem'
}

// ---------- bolha do histórico ----------

/** Onde está a mídia N na bolha: imagem i de `images`, ou arquivo i de `files`. */
export type BubbleMedia = { t: 'i'; i: number; name: string } | { t: 'f'; i: number }

/**
 * Índice da bolha a partir dos rótulos. `files` da bolha é `[...files, ...fileRefs]`.
 * Sem rótulo nenhum (mensagem antiga, celular), devolve undefined: a bolha fica como sempre.
 */
export function bubbleMedia(
  images: readonly ImageAttachment[],
  files: readonly FileAttachment[],
  fileRefs: readonly FileRefAttachment[]
): BubbleMedia[] | undefined {
  const slots: Array<{ n: number; m: BubbleMedia }> = []
  images.forEach((img, i) => {
    const n = mediaLabelNumber(img.label)
    if (n) slots.push({ n, m: { t: 'i', i, name: nameOf(img.label) } })
  })
  ;[...files, ...fileRefs].forEach((f, i) => {
    const n = mediaLabelNumber(f.label)
    if (n) slots.push({ n, m: { t: 'f', i } })
  })
  if (slots.length === 0) return undefined
  const out: BubbleMedia[] = []
  for (const s of slots) out[s.n - 1] = s.m
  return Array.from(out, (m) => m ?? { t: 'f', i: -1 })
}

/** Anexos da bolha do usuário: miniaturas, cartões e, com anexo no texto, o índice {{midia:N}}. */
export function userBubbleAttachments(
  thumbs: readonly string[],
  images: readonly ImageAttachment[],
  files: readonly FileAttachment[],
  fileRefs: readonly FileRefAttachment[]
): { images?: string[]; files?: { name: string; size: number }[]; media?: BubbleMedia[] } {
  const all = [...files, ...fileRefs]
  const media = bubbleMedia(images, files, fileRefs)
  return {
    images: thumbs.length ? [...thumbs] : undefined,
    files: all.length ? all.map((f) => ({ name: f.name, size: f.size })) : undefined,
    ...(media ? { media } : {})
  }
}
