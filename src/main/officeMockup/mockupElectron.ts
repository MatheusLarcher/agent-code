/**
 * O HTML do agente no Escritório, lado Electron (dec-rede-html):
 *
 *   registerMockupScheme()   ANTES do app.ready: `agent-mockup` é padrão (origem
 *                            por host, URL relativa resolve) e seguro (contexto
 *                            seguro, recurso https sem "mixed content"); fetch só
 *                            na própria origem (a CSP manda);
 *   setupOfficeMockup(deps)  depois do ready: o protocolo na sessão padrão (o
 *                            iframe do foco na TV) e na partição da captura, a
 *                            janela escondida de captura e os dois IPCs.
 *
 * A janela de captura: escondida e reaproveitada, sandbox, sem Node, partição
 * em memória própria (sem "persist:"), sem permissão nenhuma, sem som; janela
 * nova e navegação recusadas.
 */
import { BrowserWindow, protocol, session } from 'electron'
import { Channels } from '../../shared/ipc'
import {
  MOCKUP_CAPTURE_H,
  MOCKUP_CAPTURE_W,
  MOCKUP_SCHEME,
  type MockupCaptureResult,
  type MockupRequest,
  type MockupUrlResult
} from '../../shared/officeMockup'
import { MockupCapturer, type CaptureWindow } from './mockupCapture'
import { MockupFiles } from './mockupFiles'

/** Partição da captura: em memória (sem "persist:"), separada da do app. */
export const CAPTURE_PARTITION = 'office-mockup-capture'

export function registerMockupScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: MOCKUP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])
}

const MAX_PATH = 4096
function validRequest(req: unknown): req is MockupRequest {
  const r = req as Partial<MockupRequest> | null
  const ok = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_PATH && !v.includes('\0')
  return !!r && typeof r === 'object' && ok(r.cwd) && ok(r.path)
}

function captureWindow(): CaptureWindow {
  const win = new BrowserWindow({
    show: false,
    width: MOCKUP_CAPTURE_W,
    height: MOCKUP_CAPTURE_H,
    useContentSize: true,
    paintWhenInitiallyHidden: true,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: CAPTURE_PARTITION,
      backgroundThrottling: false,
      spellcheck: false
    }
  })
  const wc = win.webContents
  wc.setAudioMuted(true)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (event) => event.preventDefault())
  return {
    // Pelos eventos, não pela promessa do loadURL: a página que tenta navegar
    // (barrada no will-navigate) faz a promessa rejeitar com ERR_ABORTED, mas o
    // documento dela segue carregando e termina normalmente.
    load: (url) =>
      new Promise<void>((resolve, reject) => {
        const finish = (): void => {
          off()
          resolve()
        }
        const fail = (_e: unknown, code: number, desc: string, validatedURL: string, isMainFrame: boolean): void => {
          if (!isMainFrame || validatedURL !== url || code === -3) return
          off()
          reject(new Error(`${desc} (${code})`))
        }
        const off = (): void => {
          wc.off('did-finish-load', finish)
          wc.off('did-fail-load', fail)
        }
        wc.on('did-finish-load', finish)
        wc.on('did-fail-load', fail)
        wc.loadURL(url).catch(() => undefined)
      }),
    capture: async () => {
      const img = await wc.capturePage()
      return img.isEmpty() ? new Uint8Array() : new Uint8Array(img.toPNG())
    },
    destroy: () => {
      if (!win.isDestroyed()) win.destroy()
    }
  }
}

interface Deps {
  handle(channel: string, handler: (_event: unknown, ...args: unknown[]) => unknown): void
}

/** Liga o protocolo, a captura e os IPCs; `release` fecha a janela de captura (a próxima captura abre outra). */
export function setupOfficeMockup(deps: Deps): { release(): void } {
  const files = new MockupFiles()
  const serve = (req: Request): Promise<Response> => files.serve(req.url)
  protocol.handle(MOCKUP_SCHEME, serve)
  const capture = session.fromPartition(CAPTURE_PARTITION)
  capture.protocol.handle(MOCKUP_SCHEME, serve)
  capture.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  capture.setPermissionCheckHandler(() => false)
  const capturer = new MockupCapturer(captureWindow)

  deps.handle(Channels.officeMockupUrl, async (_e, req): Promise<MockupUrlResult> =>
    validRequest(req) ? files.urlFor(req) : { ok: false, error: 'pedido inválido' }
  )
  deps.handle(Channels.officeMockupCapture, async (_e, req): Promise<MockupCaptureResult> => {
    if (!validRequest(req)) return { ok: false, error: 'pedido inválido' }
    const at = await files.urlFor(req)
    if (!at.ok) return at
    const shot = await capturer.capture(at.url)
    return shot.ok ? { ok: true, url: at.url, png: shot.png } : shot
  })
  return { release: () => capturer.release() }
}
