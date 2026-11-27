import type { BrowserWindow } from 'electron'
import { devDataDir } from './devDataDir'

/** Âmbar de "em teste": não existe na paleta do app, então não se confunde com nada dele. */
export const DEV_MARK_COLOR = '#F5A524'

/** Moldura âmbar + selo "TESTE" (só leitura visual, não pega clique). */
export const DEV_MARK_CSS = `
html::after{content:"";position:fixed;inset:0;border:3px solid ${DEV_MARK_COLOR};pointer-events:none;z-index:2147483647}
body::after{content:"TESTE";position:fixed;right:10px;bottom:10px;padding:3px 8px;border-radius:4px;
background:${DEV_MARK_COLOR};color:#1f1e1d;font:700 11px/1.2 system-ui,sans-serif;letter-spacing:.08em;
pointer-events:none;z-index:2147483647}
`

/**
 * Só na cópia de teste (AGENT_CODE_DEV_DATA_DIR, app não instalado): pinta a janela
 * para ninguém confundir com o app de verdade. No app instalado não faz nada.
 */
export function markDevWindow(win: BrowserWindow): void {
  if (!devDataDir()) return
  win.setTitle('Agent Code — TESTE')
  win.on('page-title-updated', (e) => e.preventDefault())
  if (process.platform !== 'darwin') win.setTitleBarOverlay({ color: DEV_MARK_COLOR, symbolColor: '#1f1e1d', height: 52 })
  win.webContents.on('did-finish-load', () => void win.webContents.insertCSS(DEV_MARK_CSS).catch(() => undefined))
}
