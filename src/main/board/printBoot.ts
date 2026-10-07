/**
 * Os PRINTS dos cartões no processo principal: liga a ferramenta do agente
 * (`app_anexar_print`, via printRuntime.ts) ao quadro, à imagem do Electron e
 * ao banco, e responde as duas consultas da tela (miniaturas e o print grande).
 */
import { BrowserWindow, ipcMain, nativeImage, screen } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { Channels } from '../../shared/ipc'
import type { BoardPrintImageResult, BoardPrintMeta, BoardPrintsResult } from '../../shared/boardPrints'
import type { PersistenceRepository } from '../persistence/types'
import type { BoardItemPrintRecord } from '../persistence/boardPrintTypes'
import type { BoardService } from './boardService'
import { PRINTS_PER_CARD, type ImageLike } from './boardPrints'
import { attachPrint } from './printAttach'
import { setPrintSink } from './printRuntime'

export interface PrintBootDeps {
  /** O repositório gravável (null com o banco fora do ar). */
  repository(): PersistenceRepository | null
  board: Pick<BoardService, 'projectId' | 'list'>
  /** O quadro do projeto mudou (o 📷 relê). */
  changed(projectId: string): void
}

/** WebP: o `nativeImage` não lê; o Chromium de uma janela oculta decodifica e devolve PNG. */
export async function decodeWebpWithChromium(buf: Buffer): Promise<Buffer | null> {
  const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  try {
    await win.loadURL('about:blank')
    const url = JSON.stringify(`data:image/webp;base64,${buf.toString('base64')}`)
    const png: unknown = await win.webContents.executeJavaScript(`(async () => {
      try {
        const bmp = await createImageBitmap(await (await fetch(${url})).blob())
        const c = document.createElement('canvas')
        c.width = bmp.width; c.height = bmp.height
        c.getContext('2d').drawImage(bmp, 0, 0)
        return c.toDataURL('image/png').split(',')[1] || null
      } catch { return null }
    })()`)
    return typeof png === 'string' && png ? Buffer.from(png, 'base64') : null
  } catch {
    return null
  } finally {
    win.destroy()
  }
}

/** O tamanho de uma tela inteira do computador (em pixels físicos ou lógicos). */
export function isFullScreenSize(width: number, height: number): boolean {
  return screen.getAllDisplays().some((d) => {
    const w = d.size.width
    const h = d.size.height
    return (width === w && height === h) || (width === Math.round(w * d.scaleFactor) && height === Math.round(h * d.scaleFactor))
  })
}

const dataUrl = (mime: string, bytes: Uint8Array): string => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`

function meta(p: BoardItemPrintRecord): BoardPrintMeta {
  return { id: p.id, boardItemId: p.boardItemId, legenda: p.legenda, createdAt: p.createdAt, width: p.width, height: p.height, thumbUrl: dataUrl('image/jpeg', p.thumb) }
}

export function startBoardPrints(deps: PrintBootDeps): void {
  setPrintSink((input) =>
    attachPrint(input, {
      stat,
      readFile,
      board: async (cwd, conversationId) => {
        const projectId = await deps.board.projectId(cwd)
        if (!projectId) return null
        const items = await deps.board.list(cwd, { conversationId })
        return items ? { projectId, items } : null
      },
      image: { fromBuffer: (b) => nativeImage.createFromBuffer(b) as unknown as ImageLike, decodeWebp: decodeWebpWithChromium },
      fullScreen: isFullScreenSize,
      save: async (print) => {
        const repo = deps.repository()
        if (!repo) throw new Error('o banco do app está indisponível agora')
        await repo.addBoardItemPrint(print, PRINTS_PER_CARD)
      },
      changed: deps.changed
    })
  )

  ipcMain.handle(Channels.boardPrints, async (_e, query: unknown): Promise<BoardPrintsResult> => {
    const q = (query ?? {}) as { projectCwd?: unknown; boardItemId?: unknown }
    const repo = deps.repository()
    if (!repo) return { available: false, prints: [] }
    try {
      if (typeof q.boardItemId === 'string' && q.boardItemId) {
        return { available: true, prints: (await repo.listBoardItemPrints({ boardItemId: q.boardItemId })).map(meta) }
      }
      if (typeof q.projectCwd !== 'string' || !q.projectCwd) return { available: true, prints: [] }
      const projectId = await deps.board.projectId(q.projectCwd)
      if (!projectId) return { available: false, prints: [] }
      return { available: true, prints: (await repo.listBoardItemPrints({ projectId })).map(meta) }
    } catch {
      return { available: false, prints: [] }
    }
  })

  ipcMain.handle(Channels.boardPrintImage, async (_e, id: unknown): Promise<BoardPrintImageResult> => {
    if (typeof id !== 'string' || !id) return { ok: false, message: 'print inválido' }
    const repo = deps.repository()
    if (!repo) return { ok: false, message: 'o banco do app está indisponível agora' }
    try {
      const p = await repo.getBoardItemPrint(id)
      if (!p) return { ok: false, message: 'o print não existe mais (a faxina de 30 dias ou o limite de 4 por cartão)' }
      return { ok: true, id: p.id, url: dataUrl(p.mime, p.data), legenda: p.legenda, createdAt: p.createdAt, width: p.width, height: p.height }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
}
