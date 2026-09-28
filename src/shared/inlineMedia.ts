import type { ImageAttachment } from './ipc'

/**
 * Anexo no ponto do texto (composer inline).
 *
 * O texto que vai ao agente leva `{{midia:N}}` exatamente onde o usuário pôs o
 * anexo — N é a ordem do anexo no texto, a partir de 1. Os anexos continuam indo
 * como anexo normal, na mesma ordem, e cada um leva o rótulo `midia:N = nome`
 * para o agente ligar o marcador ao arquivo. Tudo aqui é puro (main e renderer).
 */

/** Casa um marcador `{{midia:N}}`; o grupo 1 é o N. Use com `new RegExp(…, 'g')`. */
export const MEDIA_MARKER_SOURCE = '\\{\\{midia:(\\d{1,4})\\}\\}'

export function mediaMarker(n: number): string {
  return `{{midia:${n}}}`
}

/** Nome de arquivo numa linha só, sem controle, com teto — vai para o modelo. */
function oneLine(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return (clean || 'arquivo').slice(0, 200)
}

export function mediaLabel(n: number, name: string): string {
  return `midia:${n} = ${oneLine(name)}`
}

const LABEL_RE = /^midia:(\d{1,4}) = [^\r\n]{1,200}$/

/** Rótulo vindo do renderer (fronteira de IPC): só passa o formato esperado. */
export function sanitizeMediaLabel(label: unknown): string | undefined {
  return typeof label === 'string' && LABEL_RE.test(label) ? label : undefined
}

/** O N de um rótulo válido; null sem rótulo. */
export function mediaLabelNumber(label: unknown): number | null {
  const ok = sanitizeMediaLabel(label)
  return ok ? Number(LABEL_RE.exec(ok)![1]) : null
}

export function hasMediaMarkers(text: string): boolean {
  return new RegExp(MEDIA_MARKER_SOURCE).test(text)
}

export type MediaTextPart = { text: string } | { media: number }

/** Quebra o texto nos marcadores, na ordem: trechos de texto e números de mídia. */
export function splitMediaText(text: string): MediaTextPart[] {
  const out: MediaTextPart[] = []
  const re = new RegExp(MEDIA_MARKER_SOURCE, 'g')
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) })
    out.push({ media: Number(m[1]) })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

/** Texto legível onde não há como mostrar o anexo (título, celular): "[mídia N]". */
export function readableMediaText(text: string): string {
  return text.replace(new RegExp(MEDIA_MARKER_SOURCE, 'g'), (_m, n: string) => `[mídia ${n}]`)
}

/**
 * Ordena pelo N do rótulo (estável). Sem rótulo fica depois, na ordem em que
 * veio — é o formato antigo, que não tinha posição.
 */
export function orderByMediaLabel<T extends { label?: unknown }>(items: readonly T[]): T[] {
  return items
    .map((item, i) => ({ item, i, n: mediaLabelNumber(item.label) }))
    .sort((a, b) => (a.n ?? Infinity) - (b.n ?? Infinity) || a.i - b.i)
    .map((x) => x.item)
}

/**
 * Blocos de imagem no formato nativo da Anthropic (o proxy do GPT converte os
 * mesmos blocos, na mesma ordem). Imagem com rótulo leva um bloco de texto
 * `midia:N = nome` logo antes dela; sem rótulo, sai como sempre saiu.
 */
export function imageContentBlocks(images: readonly ImageAttachment[]): unknown[] {
  const blocks: unknown[] = []
  for (const img of orderByMediaLabel(images)) {
    const label = sanitizeMediaLabel(img.label)
    if (label) blocks.push({ type: 'text', text: label })
    blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })
  }
  return blocks
}
