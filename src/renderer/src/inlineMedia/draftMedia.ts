import { MEDIA_MARKER_SOURCE, mediaMarker } from '@shared/inlineMedia'
import { TOKEN } from './editorModel'
import { makeFileAtt, makeImageAtt, makePendingAtt, type InlineAtt } from './inlineAttachments'
import { makeQuoteAtt } from '../components/quoteComment/quoteToken'

/**
 * Rascunho com anexos: texto com `{{midia:N}}` + a lista na ordem N.
 *
 * O rascunho guarda uma REFERÊNCIA ao anexo, nunca os bytes: imagem e arquivo
 * vão para o disco (`<userData>/attachments/<conversa>/`, o mesmo lugar e a
 * mesma função do envio) e aqui fica só o caminho. O payload da conversa, que é
 * regravado a cada mudança, não cresce com o tamanho do arquivo.
 *
 * Item ainda resolvendo também entra (`pending`, com o id): se a resolução
 * terminar com a conversa fora da tela, o resultado espera por esse id (ver
 * useInlineAttachments), e o caminho/URL colado dá para resolver de novo.
 */
export type DraftRefMedia =
  | { kind: 'image'; name: string; mediaType: string; path: string; size: number }
  | { kind: 'file'; name: string; mediaType: string; path: string; size: number }
  | { kind: 'ref'; name: string; path: string; mediaType: string; size: number }
  | { kind: 'pending'; id: string; name: string; line?: string }
  /** Trecho citado ("Comentar"): só texto, volta pronto. */
  | { kind: 'quote'; messageId: string; text: string }

/** Formato antigo (bytes dentro do rascunho): continua sendo LIDO; na próxima gravação vira referência. */
export type LegacyDraftMedia =
  | { kind: 'image'; name: string; mediaType: string; data: string }
  | { kind: 'file'; name: string; mediaType: string; data: string; size: number }

export type DraftMedia = DraftRefMedia | LegacyDraftMedia

/**
 * Como devolver ao campo um item do rascunho que não volta pronto. Nenhum
 * anexo volta direto: imagem e arquivo são relidos da cópia do rascunho, e o
 * caminho colado (`ref`) é conferido no disco. O que sumiu dá aviso e sai.
 */
export type DraftRestore =
  | { id: string; kind: 'image' | 'file'; name: string; mediaType: string; path: string }
  | { id: string; kind: 'ref'; name: string; mediaType: string; path: string; size: number }
  | { id: string; kind: 'pending'; line?: string }

const base64Bytes = (b64: string): number =>
  Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)

function entryOf(att: InlineAtt): DraftRefMedia | null {
  switch (att.kind) {
    case 'image':
      return att.stored
        ? { kind: 'image', name: att.name, mediaType: att.image.mediaType, path: att.stored, size: base64Bytes(att.image.data) }
        : null
    case 'file':
      return att.stored ? { kind: 'file', name: att.name, mediaType: att.file.mediaType, path: att.stored, size: att.file.size } : null
    case 'ref':
      return { kind: 'ref', name: att.ref.name, path: att.ref.path, mediaType: att.ref.mediaType, size: att.ref.size }
    case 'pending':
      if (att.from) return att.from
      return { kind: 'pending', id: att.id, name: att.name, ...(att.line ? { line: att.line } : {}) }
    case 'quote':
      return { kind: 'quote', messageId: att.quote.messageId, text: att.quote.text }
  }
}

/**
 * Campo -> rascunho. Imagem/arquivo sem cópia em disco (`stored`) não entra:
 * volta em `missing` para quem chamou avisar. Nunca grava bytes.
 */
export function toDraft(
  value: string,
  order: readonly string[],
  atts: ReadonlyMap<string, InlineAtt>
): { text: string; media: DraftRefMedia[]; missing: string[] } {
  const media: DraftRefMedia[] = []
  const missing: string[] = []
  if (!value.includes(TOKEN)) return { text: value, media, missing }
  let text = ''
  let next = 0
  for (const ch of value) {
    if (ch !== TOKEN) {
      text += ch
      continue
    }
    const att = atts.get(order[next++] ?? '')
    if (!att) continue
    const d = entryOf(att)
    if (!d) {
      missing.push(att.name)
      continue
    }
    media.push(d)
    text += mediaMarker(media.length)
  }
  return { text, media, missing }
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length <= max ? v : null
}

/** Valida um item de rascunho vindo do banco (novo formato ou o antigo, com bytes). */
export function isDraftMedia(v: unknown): v is DraftMedia {
  if (!v || typeof v !== 'object') return false
  const d = v as Record<string, unknown>
  if (d.kind === 'quote') return !!str(d.messageId, 200) && !!str(d.text, 4000)
  if (d.kind === 'pending') return !!str(d.id, 200) && str(d.name, 400) !== null && (d.line === undefined || !!str(d.line, 4000))
  if (!str(d.name, 400) || !str(d.mediaType, 200)) return false
  const ref = !!str(d.path, 4000) && typeof d.size === 'number'
  if (d.kind === 'ref') return ref
  // formato antigo: bytes no rascunho (até 100M caracteres, como antes)
  const legacy = str(d.data, 100_000_000) !== null
  if (d.kind === 'image') return ref || legacy
  if (d.kind === 'file') return ref || (legacy && typeof d.size === 'number')
  return false
}

/**
 * Rascunho gravado -> texto do campo + anexos. Marcador sem mídia correspondente
 * fica como texto. `restore`: itens que voltam como "resolvendo" (imagem lida
 * de novo do disco; item que ainda resolvia quando o rascunho foi salvo).
 */
export function fromDraft(
  text: string,
  media: readonly unknown[] | undefined
): { value: string; order: string[]; atts: InlineAtt[]; restore: DraftRestore[] } {
  const list = (media ?? []).filter(isDraftMedia)
  const restore: DraftRestore[] = []
  if (list.length === 0) return { value: text, order: [], atts: [], restore }
  const atts: InlineAtt[] = []
  const order: string[] = []
  const value = text.replace(new RegExp(MEDIA_MARKER_SOURCE, 'g'), (m, n: string) => {
    const d = list[Number(n) - 1]
    if (!d) return m
    let att: InlineAtt
    if (d.kind === 'quote') {
      // O número certo vem na renumeração do campo (useComposerQuotes).
      att = makeQuoteAtt({ messageId: d.messageId, text: d.text }, order.length + 1)
    } else if (d.kind === 'pending') {
      att = makePendingAtt(d.name, d.line, d.id)
      restore.push({ id: d.id, kind: 'pending', ...(d.line ? { line: d.line } : {}) })
    } else if ('data' in d) {
      att = d.kind === 'image'
        ? makeImageAtt({ mediaType: d.mediaType, data: d.data }, d.name)
        : makeFileAtt({ name: d.name, mediaType: d.mediaType, data: d.data, size: d.size })
    } else if (d.kind === 'ref') {
      // Caminho colado: volta "resolvendo" até conferir que o arquivo ainda existe.
      att = { ...makePendingAtt(d.name), from: d } as InlineAtt
      restore.push({ id: att.id, kind: 'ref', name: d.name, mediaType: d.mediaType, path: d.path, size: d.size })
    } else {
      // Imagem/arquivo guardado: os bytes voltam da cópia do rascunho (que continua a referência).
      att = { ...makePendingAtt(d.name), from: d } as InlineAtt
      restore.push({ id: att.id, kind: d.kind, name: d.name, mediaType: d.mediaType, path: d.path })
    }
    atts.push(att)
    order.push(att.id)
    return TOKEN
  })
  return { value, order, atts, restore }
}

/** Troca no texto do campo os itens de `replace` (id -> texto) e tira o id da ordem. */
export function replaceTokens(
  value: string,
  order: readonly string[],
  replace: ReadonlyMap<string, string>
): { value: string; order: string[] } {
  let out = ''
  const kept: string[] = []
  let next = 0
  for (const ch of value) {
    if (ch !== TOKEN) {
      out += ch
      continue
    }
    const id = order[next++] ?? ''
    const text = replace.get(id)
    if (text === undefined) {
      out += ch
      kept.push(id)
    } else {
      out += text
    }
  }
  return { value: out, order: kept }
}

const sameMedia = (a: readonly DraftMedia[] | undefined, b: readonly DraftMedia[] | undefined): boolean =>
  (!a?.length && !b?.length) || JSON.stringify(a ?? []) === JSON.stringify(b ?? [])

// ---------- cópias em disco do rascunho ----------

/** Caminhos das cópias em disco de um rascunho gravado (imagem/arquivo; nunca o caminho colado). */
export function draftCopyPaths(media: readonly unknown[] | undefined): string[] {
  return (media ?? []).filter(isDraftMedia).flatMap((d) => ((d.kind === 'image' || d.kind === 'file') && 'path' in d ? [d.path] : []))
}

/** A conversa dona da cópia: `<userData>/attachments/<conversa>/rascunho/<arquivo>`. */
function copyConv(path: string): string {
  const parts = path.split(/[\\/]+/)
  const i = parts.map((s) => s.toLowerCase()).lastIndexOf('rascunho')
  return i > 0 ? parts[i - 1] : ''
}

function byConversation(paths: readonly string[]): Map<string, string[]> {
  const byConv = new Map<string, string[]>()
  for (const p of new Set(paths)) {
    const conv = p ? copyConv(p) : ''
    if (conv) byConv.set(conv, [...(byConv.get(conv) ?? []), p])
  }
  return byConv
}

const draftApi = (): Partial<Window['api']> | undefined =>
  (typeof window !== 'undefined' ? window.api : undefined) as Partial<Window['api']> | undefined

/**
 * Apaga cópias que eram só do rascunho (item removido, campo limpo, envio de
 * imagem, conversa apagada). O main só aceita as da pasta `rascunho/` da
 * conversa; o arquivo enviado já saiu de lá (promoteDraftCopies).
 */
export function discardDraftCopies(paths: readonly string[]): void {
  const api = draftApi()
  if (!api?.discardDraftAttachments) return
  for (const [conv, list] of byConversation(paths)) void api.discardDraftAttachments(conv, list).catch(() => undefined)
}

/**
 * Envio: as cópias dos arquivos enviados saem de `rascunho/` para a pasta do
 * envio da conversa (o caminho que a mensagem leva, ver sentCopyPath). O main
 * também move no próprio envio, então a ordem entre os dois pedidos não importa.
 */
export function promoteDraftCopies(paths: readonly string[]): void {
  const api = draftApi()
  if (!api?.promoteDraftAttachments) return
  for (const [conv, list] of byConversation(paths)) void api.promoteDraftAttachments(conv, list).catch(() => undefined)
}

/**
 * Aplica o rascunho à conversa. Nada mudou (texto E anexos iguais): devolve a
 * MESMA conversa, e nada é regravado — o blur sem edição não gera upsert.
 */
export function applyDraft<C extends { draft?: string; draftMedia?: DraftMedia[] }>(
  conv: C,
  text: string,
  media?: DraftMedia[]
): C {
  const next = media?.length ? media : undefined
  if ((conv.draft ?? '') === text && sameMedia(conv.draftMedia, next)) return conv
  return { ...conv, draft: text, draftMedia: next }
}
