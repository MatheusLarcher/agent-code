/**
 * O PRINT DA TAREFA VISUAL no cartão (`app_anexar_print`): o agente que testou
 * algo visível anexa a imagem; o app reconhece o tipo pelos bytes, acha o
 * cartão e comprime (até 1600 px de largura, JPEG perto de 300 KB, mais uma
 * miniatura) antes de gravar no banco. No banco e não numa pasta: o quadro é
 * compartilhado entre PCs, e print só no disco de um apareceria quebrado no outro.
 * Puro (sem Electron): a imagem entra por `PrintImageDeps`.
 */
import { boardItemStatus, boardItemTitle, type BoardItem } from '../../shared/ipc'

export const PRINT_MAX_FILE_BYTES = 10 * 1024 * 1024
export const PRINT_MAX_WIDTH = 1600
export const PRINT_TARGET_BYTES = 300 * 1024
export const PRINT_THUMB_WIDTH = 320
/** Fica com os 4 mais novos de cada cartão. */
export const PRINTS_PER_CARD = 4
export const PRINT_CAPTION_MAX = 200

export type PrintMime = 'image/png' | 'image/jpeg' | 'image/webp'

const ascii = (buf: Uint8Array, from: number, to: number): string => String.fromCharCode(...buf.subarray(from, to))

/** O tipo pelos primeiros bytes (a extensão mente); null se não é PNG, JPEG nem WebP. */
export function sniffImage(buf: Uint8Array): PrintMime | null {
  if (buf.length >= 8 && buf[0] === 0x89 && ascii(buf, 1, 4) === 'PNG') return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 12 && ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return 'image/webp'
  return null
}

export type CardPick = { ok: true; item: BoardItem } | { ok: false; error: string }

const norm = (s: string): string => s.trim().toLowerCase()
const names = (items: readonly BoardItem[]): string =>
  items.length === 0 ? 'nenhum' : items.slice(0, 8).map((i) => `"${boardItemTitle(i)}"`).join(', ')

/**
 * O cartão do print, entre os da conversa: pelo id da tarefa (o do TodoWrite),
 * pelo título exato ou pelo prefixo "[id-da-etapa]". Sem `tarefa`, o único em
 * andamento. Ambíguo ou nenhum → erro que diz quais existem.
 */
export function resolvePrintCard(items: readonly BoardItem[], conversationId: string, tarefa?: string | null): CardPick {
  const mine = items.filter((i) => i.conversationId === conversationId && i.dismissedAt === null)
  const wanted = (tarefa ?? '').trim()
  if (!wanted) {
    const doing = mine.filter((i) => boardItemStatus(i) === 'in_progress')
    if (doing.length === 1) return { ok: true, item: doing[0] }
    return {
      ok: false,
      error: doing.length === 0
        ? `nenhum cartão em andamento nesta conversa; diga qual em "tarefa" (cartões: ${names(mine)})`
        : `mais de um cartão em andamento (${names(doing)}); diga qual em "tarefa"`
    }
  }
  const titles = (i: BoardItem): string[] => [norm(boardItemTitle(i)), norm(i.sourceTitle)]
  const byId = mine.filter((i) => i.sourceId === wanted)
  const byTitle = mine.filter((i) => titles(i).includes(norm(wanted)))
  const prefix = /^\[[^\]]+\]/.exec(wanted)?.[0]
  const byPrefix = prefix ? mine.filter((i) => titles(i).some((t) => t.startsWith(norm(prefix)))) : []
  for (const found of [byId, byTitle, byPrefix]) if (found.length === 1) return { ok: true, item: found[0] }
  const many = [byId, byTitle, byPrefix].find((found) => found.length > 1)
  if (many) return { ok: false, error: `"${wanted}" casa com mais de um cartão (${names(many)}); use o id da tarefa ou o título exato` }
  return { ok: false, error: `nenhum cartão desta conversa casa com "${wanted}" (cartões: ${names(mine)})` }
}

/** O pedaço do `nativeImage` que a compressão usa (o teste passa um falso). */
export interface ImageLike {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width: number; quality?: 'good' | 'better' | 'best' }): ImageLike
  toJPEG(quality: number): Buffer
}

export interface PrintImageDeps {
  fromBuffer(buf: Buffer): ImageLike
  /** WebP: o `nativeImage` não lê; o Chromium decodifica e devolve PNG (null se falhou). */
  decodeWebp?(buf: Buffer): Promise<Buffer | null>
}

export interface CompressedPrint {
  mime: 'image/jpeg'
  data: Buffer
  thumb: Buffer
  width: number
  height: number
  /** Tamanho do original, antes de reduzir (a checagem de tela inteira). */
  sourceWidth: number
  sourceHeight: number
}

/** Até 1600 px, JPEG perto de 300 KB (a qualidade desce, depois a largura) e a miniatura de 320 px. */
export async function compressPrint(buf: Buffer, mime: PrintMime, deps: PrintImageDeps): Promise<CompressedPrint | { error: string }> {
  let source = buf
  if (mime === 'image/webp') {
    const png = deps.decodeWebp ? await deps.decodeWebp(buf).catch(() => null) : null
    if (!png) return { error: 'não consegui ler o WebP; salve o print como PNG ou JPEG' }
    source = png
  }
  let img = deps.fromBuffer(source)
  if (img.isEmpty()) return { error: 'a imagem não abriu (arquivo corrompido?)' }
  const original = img.getSize()
  if (original.width > PRINT_MAX_WIDTH) img = img.resize({ width: PRINT_MAX_WIDTH, quality: 'good' })
  let data = img.toJPEG(82)
  for (const quality of [72, 62, 52]) {
    if (data.length <= PRINT_TARGET_BYTES) break
    data = img.toJPEG(quality)
  }
  for (const width of [1280, 1024]) {
    if (data.length <= PRINT_TARGET_BYTES || img.getSize().width <= width) continue
    img = img.resize({ width, quality: 'good' })
    data = img.toJPEG(62)
  }
  const size = img.getSize()
  const thumb = (size.width > PRINT_THUMB_WIDTH ? img.resize({ width: PRINT_THUMB_WIDTH, quality: 'good' }) : img).toJPEG(70)
  return { mime: 'image/jpeg', data, thumb, width: size.width, height: size.height, sourceWidth: original.width, sourceHeight: original.height }
}
