// @vitest-environment node
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, protocol: {}, session: {} }))

import { net } from 'electron'
import { previewFileUrl } from '../../shared/preview'
import {
  allowedWebviewSrc,
  fileHostAllowed,
  handlePreviewRequest,
  requestedByPreviewPage,
  requestedByWebPage
} from './previewProtocol'
import { clearPreviewRoots, previewHtmlUrl, previewMediaUrl } from './previewUrls'

const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'agent-preview-proto-')))
const png = join(dir, 'foto.png')
writeFileSync(png, 'png')
writeFileSync(join(dir, 'index.html'), '<img src="foto.png">')

const req = (headers: Record<string, string> = {}, url = 'agent-preview://file/C%3A%5Cx.png'): Request =>
  new Request(url, { headers })
const fileReq = (headers: Record<string, string> = {}): Request => req(headers, previewFileUrl(png))

const fetchMock = vi.mocked(net.fetch)

beforeEach(() => {
  clearPreviewRoots()
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => new Response('png', { status: 200 }))
})
afterEach(() => vi.unstubAllEnvs())
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('previewProtocol — origem do pedido', () => {
  it('reconhece pedido feito por uma página da web (Origin ou Referer http/https)', () => {
    expect(requestedByWebPage(req())).toBe(false)
    expect(requestedByWebPage(req({ origin: 'https://site.com' }))).toBe(true)
    expect(requestedByWebPage(req({ referer: 'http://site.com/a' }))).toBe(true)
    expect(requestedByWebPage(req({ referer: 'agent-preview://abc/index.html' }))).toBe(false)
  })

  it('página agent-preview: é a que tem TODA origem no próprio protocolo', () => {
    expect(requestedByPreviewPage(req())).toBe(false)
    expect(requestedByPreviewPage(req({ referer: 'agent-preview://abc/index.html' }))).toBe(true)
    expect(requestedByPreviewPage(req({ origin: 'agent-preview://abc' }))).toBe(true)
    expect(requestedByPreviewPage(req({ origin: 'null' }))).toBe(false)
    expect(requestedByPreviewPage(req({ origin: 'agent-preview://abc', referer: 'https://site.com/' }))).toBe(false)
  })
})

describe('previewProtocol — host file é lista positiva', () => {
  it('recusa o que antes passava: sem Origin/Referer (img no-referrer) e Origin null (iframe data:)', () => {
    expect(fileHostAllowed(fileReq(), png, true)).toBe(false)
    expect(fileHostAllowed(fileReq({ origin: 'null' }), png, true)).toBe(false)
    expect(fileHostAllowed(fileReq({ origin: 'null' }), png, false)).toBe(false)
    expect(fileHostAllowed(fileReq({ referer: 'https://site.com/' }), png, false)).toBe(false)
  })

  it('serve página agent-preview: e o caminho que o próprio app abriu (navegação sem origem)', () => {
    expect(fileHostAllowed(fileReq({ referer: 'agent-preview://abc/index.html' }), png, true)).toBe(true)
    previewMediaUrl(png)
    expect(fileHostAllowed(fileReq(), png, true)).toBe(true)
    // Visualizador de PDF embutido repede o arquivo aberto.
    expect(fileHostAllowed(fileReq({ origin: 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai' }), png, true)).toBe(true)
    // Mesmo aberto pelo app, origem null ou de site fica de fora.
    expect(fileHostAllowed(fileReq({ origin: 'null' }), png, true)).toBe(false)
    expect(fileHostAllowed(fileReq({ referer: 'https://site.com/' }), png, true)).toBe(false)
    // Outro arquivo (não aberto) continua recusado.
    expect(fileHostAllowed(req(), 'C:\\x.png', true)).toBe(false)
  })

  it('renderer do app em dev só na sessão padrão', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    const fromApp = fileReq({ origin: 'http://localhost:5173', referer: 'http://localhost:5173/' })
    expect(fileHostAllowed(fromApp, png, false)).toBe(true)
    expect(fileHostAllowed(fromApp, png, true)).toBe(false)
    expect(fileHostAllowed(fileReq({ origin: 'http://localhost:5174' }), png, false)).toBe(false)
    expect(fileHostAllowed(fileReq({ origin: 'http://localhost:5173.evil.com' }), png, false)).toBe(false)
  })

  it('handlePreviewRequest: 403 sem tocar no disco para pedido de fora; 200 para o que o app abriu', async () => {
    const outside: Record<string, string>[] = [{}, { origin: 'null' }, { referer: 'https://site.com/' }]
    for (const headers of outside) {
      expect((await handlePreviewRequest(fileReq(headers), true)).status).toBe(403)
      expect((await handlePreviewRequest(fileReq(headers), false)).status).toBe(403)
    }
    expect(fetchMock).not.toHaveBeenCalled()

    const url = previewMediaUrl(png)
    const res = await handlePreviewRequest(new Request(url), true)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('host token (html local) segue igual: serve sem origem e recusa site no <webview>', async () => {
    const url = previewHtmlUrl(join(dir, 'index.html'))
    expect((await handlePreviewRequest(new Request(url), true)).status).toBe(200)
    const img = new URL('foto.png', url).href
    expect((await handlePreviewRequest(req({ referer: url }, img), true)).status).toBe(200)
    expect((await handlePreviewRequest(req({ origin: 'https://site.com' }, img), true)).status).toBe(403)
  })

  it('no <webview>, site de fora não puxa arquivo do disco (403)', async () => {
    const res = await handlePreviewRequest(req({ origin: 'https://site.com' }), true)
    expect(res.status).toBe(403)
  })
})

describe('previewProtocol — webview', () => {
  it('o webview só abre http(s), agent-preview e about:blank', () => {
    expect(allowedWebviewSrc('https://a.com')).toBe(true)
    expect(allowedWebviewSrc('agent-preview://file/x')).toBe(true)
    expect(allowedWebviewSrc('about:blank')).toBe(true)
    expect(allowedWebviewSrc('file:///C:/x.html')).toBe(false)
    expect(allowedWebviewSrc('javascript:alert(1)')).toBe(false)
  })
})
