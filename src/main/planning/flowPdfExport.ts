import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, BrowserWindow, dialog, type WebContents } from 'electron'
import { z } from 'zod'
import type { FlowPdfResult } from '../../shared/ipc'

/**
 * Exporta o flow do planejamento em PDF. O renderer manda uma página HTML
 * autocontida (o viewport do React Flow clonado + o CSS do app, ver
 * renderer/planning/flowPdf.ts); aqui ela é aberta numa janela oculta, sem
 * JavaScript, e impressa com printToPDF — texto e setas saem vetoriais, numa
 * página do tamanho exato do flow.
 */

/** Maior lado aceito (px CSS): o PDF limita a página a 200 pol ≈ 19200 px. */
export const MAX_SIDE = 19_000

const FlowPdfReq = z.strictObject({
  html: z.string().min(1).max(60_000_000),
  width: z.number().finite().min(1).max(MAX_SIDE),
  height: z.number().finite().min(1).max(MAX_SIDE),
  name: z.string().max(200)
})

/** Nome de arquivo seguro no Windows, sem extensão. */
export function pdfFileName(name: string): string {
  const clean = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '')
  return clean || 'planejamento'
}

export async function exportFlowPdf(sender: WebContents, payload: unknown): Promise<FlowPdfResult> {
  const parsed = FlowPdfReq.safeParse(payload)
  if (!parsed.success) return { ok: false, message: 'Pedido de exportação inválido.' }
  const { html, width, height, name } = parsed.data

  const parent = BrowserWindow.fromWebContents(sender)
  const options = {
    title: 'Exportar o flow em PDF',
    defaultPath: path.join(app.getPath('downloads'), `${pdfFileName(name)}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  }
  const pick = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
  if (pick.canceled || !pick.filePath) return { ok: false, canceled: true }

  const tmp = path.join(os.tmpdir(), `agentcode-flow-${randomUUID()}.html`)
  let win: BrowserWindow | null = null
  try {
    await fs.writeFile(tmp, html, 'utf8')
    win = new BrowserWindow({
      show: false,
      width: Math.ceil(width),
      height: Math.ceil(height),
      webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    await win.loadFile(tmp)
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    })
    await fs.writeFile(pick.filePath, pdf)
    return { ok: true, path: pick.filePath }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  } finally {
    win?.destroy()
    void fs.unlink(tmp).catch(() => {})
  }
}
