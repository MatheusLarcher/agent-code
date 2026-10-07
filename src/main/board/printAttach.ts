/**
 * `app_anexar_print` de ponta a ponta, com o mundo injetado (disco, quadro,
 * imagem, banco): valida o arquivo (existe, até 10 MB, PNG/JPEG/WebP pelos
 * bytes), acha o cartão da conversa, comprime, recusa a tela inteira do
 * computador e grava — o banco fica com os 4 mais novos do cartão.
 */
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { boardItemTitle, type BoardItem } from '../../shared/ipc'
import {
  compressPrint,
  PRINT_CAPTION_MAX,
  PRINT_MAX_FILE_BYTES,
  resolvePrintCard,
  sniffImage,
  type PrintImageDeps
} from './boardPrints'

/** O print pronto para o banco. */
export interface NewBoardItemPrint {
  id: string
  boardItemId: string
  projectId: string
  conversationId: string
  mime: string
  data: Buffer
  thumb: Buffer
  width: number
  height: number
  legenda: string | null
  createdAt: string
}

export interface AttachPrintInput {
  conversationId: string
  /** A pasta da conversa: o caminho relativo parte dela. */
  cwd: string
  arquivo: string
  tarefa?: string | null
  legenda?: string | null
}

export type AttachPrintResult = { ok: true; message: string; boardItemId: string } | { ok: false; message: string }

export interface AttachPrintDeps {
  stat(path: string): Promise<{ isFile(): boolean; size: number }>
  readFile(path: string): Promise<Buffer>
  /** Os cartões da conversa e o projeto; null com o quadro fora do ar. */
  board(cwd: string, conversationId: string): Promise<{ projectId: string; items: BoardItem[] } | null>
  image: PrintImageDeps
  /** O print tem o tamanho de uma tela inteira do computador? */
  fullScreen?(width: number, height: number): boolean
  save(print: NewBoardItemPrint): Promise<void>
  changed?(projectId: string): void
  now?(): number
  newId?(): string
}

const fail = (message: string): AttachPrintResult => ({ ok: false, message: `Recusado: ${message}` })

export async function attachPrint(input: AttachPrintInput, deps: AttachPrintDeps): Promise<AttachPrintResult> {
  const path = isAbsolute(input.arquivo) ? input.arquivo : join(input.cwd, input.arquivo)
  const info = await deps.stat(path).catch(() => null)
  if (!info?.isFile()) return fail(`o arquivo não existe (${input.arquivo})`)
  if (info.size > PRINT_MAX_FILE_BYTES) return fail(`o arquivo tem ${(info.size / 1024 / 1024).toFixed(1)} MB; o limite é 10 MB`)
  const buf = await deps.readFile(path).catch(() => null)
  if (!buf) return fail(`não consegui ler o arquivo (${input.arquivo})`)
  const mime = sniffImage(buf)
  if (!mime) return fail('o arquivo não é imagem PNG, JPEG ou WebP')
  const board = await deps.board(input.cwd, input.conversationId).catch(() => null)
  if (!board) return fail('o quadro está indisponível agora (banco ou pasta do projeto fora do ar)')
  const pick = resolvePrintCard(board.items, input.conversationId, input.tarefa)
  if (!pick.ok) return fail(pick.error)
  const img = await compressPrint(buf, mime, deps.image)
  if ('error' in img) return fail(img.error)
  if (deps.fullScreen?.(img.sourceWidth, img.sourceHeight)) {
    return fail(`o print tem o tamanho da tela inteira do computador (${img.sourceWidth}×${img.sourceHeight}); anexe só a janela ou a página testada`)
  }
  const legenda = (input.legenda ?? '').trim().slice(0, PRINT_CAPTION_MAX) || null
  await deps.save({
    id: deps.newId?.() ?? randomUUID(),
    boardItemId: pick.item.id,
    projectId: board.projectId,
    conversationId: input.conversationId,
    mime: img.mime,
    data: img.data,
    thumb: img.thumb,
    width: img.width,
    height: img.height,
    legenda,
    createdAt: new Date(deps.now?.() ?? Date.now()).toISOString()
  })
  deps.changed?.(board.projectId)
  return {
    ok: true,
    boardItemId: pick.item.id,
    message: `ok: print anexado ao cartão "${boardItemTitle(pick.item)}" (${img.width}×${img.height}, ${Math.round(img.data.length / 1024)} KB)`
  }
}
