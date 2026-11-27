/**
 * Ligações do preview com o Electron (o resto do preview é puro e testado à parte):
 *
 *   registerPrivilegedSchemes(outros)  ANTES do app.ready. O Electron aceita UMA
 *                                      chamada de registerSchemesAsPrivileged: a
 *                                      segunda sobrescreve as chaves (secure, fetch,
 *                                      stream…) que vão para os renderers. Por isso
 *                                      o agent-preview vai junto com os esquemas do
 *                                      app (hoje o agent-mockup) numa chamada só.
 *   setupPreviewProtocol()             depois do ready: handler do agent-preview://
 *                                      na partição do <webview> e na sessão padrão,
 *                                      e as permissões da partição (nega quase tudo).
 *   hardenPreviewWebviews(contents, p) no webContents da janela: força preload,
 *                                      partição e isolamento em todo <webview>, e
 *                                      manda janela nova (window.open/target=_blank)
 *                                      para o navegador do sistema.
 *
 * Formatos de URL: ver previewUrls.ts.
 */
import { net, protocol, session, type CustomScheme, type WebContents } from 'electron'
import { pathToFileURL } from 'node:url'
import { PREVIEW_PARTITION, PREVIEW_PROTOCOL } from '../../shared/preview'
import { resolvePreviewRequest } from './previewServe'
import { isOpenedPreviewFile, parsePreviewUrl } from './previewUrls'

/** Privilégios do agent-preview: origem padrão (relativos), segura, fetch e streaming de mídia. */
export const PREVIEW_SCHEME: CustomScheme = {
  scheme: PREVIEW_PROTOCOL,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}

/** Registra o agent-preview e os demais esquemas do app numa única chamada. */
export function registerPrivilegedSchemes(others: CustomScheme[]): void {
  protocol.registerSchemesAsPrivileged([...others, PREVIEW_SCHEME])
}

/** Endereços que um <webview> do preview pode abrir. */
export function allowedWebviewSrc(src: string | undefined): boolean {
  if (!src || src === 'about:blank') return true
  try {
    const p = new URL(src).protocol
    return p === 'http:' || p === 'https:' || p === `${PREVIEW_PROTOCOL}:`
  } catch {
    return false
  }
}

/** Permissões que a página do preview pode ter; o resto é negado. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen'])

/** Extensão interna do Chromium/Electron que desenha PDF (pode repedir o arquivo). */
const PDF_VIEWER_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai'

/** De onde veio o pedido: Origin, Referer e o referrer do Request (o que houver). */
function requestSources(request: Request): string[] {
  return [request.headers.get('origin'), request.headers.get('referer'), request.referrer].filter(
    (v): v is string => !!v && v !== 'about:client' && v !== 'no-referrer'
  )
}

/**
 * Pedido feito POR uma página da web (site aberto no preview embutindo
 * `<img|script src="agent-preview://...">`)? Arquivo local só vai para página
 * local; o site não pode puxar arquivos do disco.
 */
export function requestedByWebPage(request: Request): boolean {
  return requestSources(request).some((v) => /^https?:\/\//i.test(v))
}

/** Pedido de uma página agent-preview: (html local aberto pelo preview, ou a própria mídia). */
export function requestedByPreviewPage(request: Request): boolean {
  const from = requestSources(request)
  return from.length > 0 && from.every((v) => v.toLowerCase().startsWith(`${PREVIEW_PROTOCOL}:`))
}

/** Origem do renderer do app em dev (electron-vite); em produção ele é file:// e não manda Referer. */
function requestedByAppRenderer(request: Request): boolean {
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (!dev) return false
  let origin: string
  try {
    origin = new URL(dev).origin
  } catch {
    return false
  }
  const from = requestSources(request)
  return from.length > 0 && from.every((v) => v === origin || v.startsWith(`${origin}/`))
}

/**
 * Host `file` (um arquivo por URL, qualquer caminho do disco): lista POSITIVA.
 * Serve só quando o pedido vem de uma página agent-preview:, quando é o caminho
 * que o próprio app abriu (previewMediaUrl — a navegação de topo do <webview>
 * chega sem Origin/Referer) ou, na sessão padrão, do renderer do app em dev.
 * Sem cabeçalho de origem não basta: `<img referrerpolicy=no-referrer>` e
 * iframe data: (Origin: null) de um site também chegam assim.
 */
export function fileHostAllowed(request: Request, path: string, fromWebview: boolean): boolean {
  if (requestedByPreviewPage(request)) return true
  if (!fromWebview && requestedByAppRenderer(request)) return true
  // Caminho aberto pelo app: só a navegação sem origem (ou o visualizador de PDF
  // embutido). Origin "null" (iframe data:/sandbox) ou de site fica de fora.
  const from = requestSources(request)
  const clean = from.every((v) => v.toLowerCase().startsWith(`${PREVIEW_PROTOCOL}:`) || v.startsWith(PDF_VIEWER_ORIGIN))
  return clean && isOpenedPreviewFile(path)
}

const forbidden = (message: string): Response =>
  new Response(message, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } })

/**
 * Responde a um pedido agent-preview:// (Range/streaming ficam com o loader de file://).
 * `fromWebview`: pedido da partição do <webview>, onde rodam sites de fora. Na sessão
 * padrão quem pede é o próprio app (que em dev roda em http://localhost).
 */
export async function handlePreviewRequest(request: Request, fromWebview = false): Promise<Response> {
  const parsed = parsePreviewUrl(request.url)
  if (parsed?.kind === 'file') {
    if (!fileHostAllowed(request, parsed.path, fromWebview)) {
      return forbidden('Este endereço só abre arquivos que o Preview do app abriu.')
    }
  } else if (fromWebview && requestedByWebPage(request)) {
    return forbidden('Uma página da web não pode abrir arquivos do computador.')
  }
  const r = await resolvePreviewRequest(request.url)
  if (!r.ok) {
    return new Response(r.message, { status: r.status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  }
  const range = request.headers.get('range')
  const res = await net.fetch(pathToFileURL(r.file).href, range ? { headers: { range } } : undefined)
  const headers = new Headers(res.headers)
  headers.set('content-type', r.mime)
  headers.set('cache-control', 'no-cache')
  headers.set('x-content-type-options', 'nosniff')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

const safeHandle = (fromWebview: boolean) => async (request: Request): Promise<Response> => {
  try {
    return await handlePreviewRequest(request, fromWebview)
  } catch (err) {
    console.error('[preview] falha ao servir', request.url, err)
    return new Response('Falha ao abrir o arquivo.', { status: 500 })
  }
}

/** Depois do app.ready: protocolo nas duas sessões e permissões da partição do preview. */
export function setupPreviewProtocol(): void {
  const part = session.fromPartition(PREVIEW_PARTITION)
  part.protocol.handle(PREVIEW_PROTOCOL, safeHandle(true))
  // Sessão padrão: o renderer do app pode mostrar a mesma mídia direto (<img>/<video>),
  // com a mesma barreira — nada além do que previewReadFile já entrega.
  protocol.handle(PREVIEW_PROTOCOL, safeHandle(false))
  part.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)))
  part.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))
}

/**
 * Trava todo <webview> criado pela janela: o renderer só escolhe o src; preload
 * (o seletor), partição e isolamento são impostos aqui. Janela nova pedida pela
 * página vai para o navegador do sistema.
 */
export function hardenPreviewWebviews(
  contents: WebContents,
  preloadPath: string,
  openExternal: (url: string) => void | Promise<void>
): void {
  contents.on('will-attach-webview', (event, prefs, params) => {
    if (!allowedWebviewSrc(params.src)) {
      event.preventDefault()
      return
    }
    // preloadURL é a forma que o Electron usa no <webview>; o `preload` cobre versões antigas.
    delete (prefs as { preloadURL?: string }).preloadURL
    prefs.preload = preloadPath
    prefs.nodeIntegration = false
    prefs.nodeIntegrationInSubFrames = false
    prefs.contextIsolation = true
    // O preload do seletor usa ipcRenderer.sendToHost: precisa de sandbox desligado.
    prefs.sandbox = false
    prefs.webSecurity = true
    prefs.allowRunningInsecureContent = false
    params.partition = PREVIEW_PARTITION
  })
  contents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void openExternal(url)
      return { action: 'deny' }
    })
  })
}
