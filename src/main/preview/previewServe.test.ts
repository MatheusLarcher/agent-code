// @vitest-environment node
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { pathFromPreviewUrl, previewFileUrl } from '../../shared/preview'
import { mimeFor, resolvePreviewRequest } from './previewServe'
import {
  clearPreviewRoots,
  isOpenedPreviewFile,
  parsePreviewUrl,
  previewHtmlUrl,
  previewMediaUrl,
  registerPreviewRoot,
  rootToken
} from './previewUrls'

/** Cria o link simbólico; false (o teste pula) se o Windows não deixar (sem modo desenvolvedor/admin). */
function trySymlink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, 'file')
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return false
    throw err
  }
}

// realpath: no Windows o tmpdir pode vir no nome curto (BI_2D_~1).
const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'agent-preview-serve-')))
const site = join(base, 'site')
mkdirSync(join(site, 'img'), { recursive: true })
mkdirSync(join(site, 'docs'), { recursive: true })
writeFileSync(join(site, 'index.html'), '<h1>oi</h1>')
writeFileSync(join(site, 'img', 'a b.png'), 'png')
writeFileSync(join(site, 'docs', 'index.html'), 'docs')
writeFileSync(join(site, '.env'), 'SECRET=1')
writeFileSync(join(base, 'fora.html'), 'fora')

beforeEach(() => clearPreviewRoots())
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('previewUrls — formatos', () => {
  it('formato do contrato continua funcionando (file host)', () => {
    const p = join(site, 'img', 'a b.png')
    const url = previewFileUrl(p)
    expect(pathFromPreviewUrl(url)).toBe(p)
    expect(parsePreviewUrl(url)).toEqual({ kind: 'file', path: p })
    expect(parsePreviewUrl('agent-preview://file/')).toBeNull()
  })

  it('token determinístico, igual em qualquer caixa no Windows', () => {
    expect(rootToken(site)).toMatch(/^[a-f0-9]{20}$/)
    expect(rootToken(site)).toBe(rootToken(site))
    if (process.platform === 'win32') expect(rootToken(site.toUpperCase())).toBe(rootToken(site))
  })

  it('recusa host que não é token, outro esquema e segmentos perigosos', () => {
    const t = rootToken(site)
    expect(parsePreviewUrl('agent-preview://nao-token/a.html')).toBeNull()
    expect(parsePreviewUrl(`https://${t}/a.html`)).toBeNull()
    expect(parsePreviewUrl(`agent-preview://${t}/..%5Cfora.html`)).toBeNull()
    expect(parsePreviewUrl(`agent-preview://${t}/C%3A/x`)).toBeNull()
    expect(parsePreviewUrl(`agent-preview://${t}/a%2Fb`)).toBeNull()
    expect(parsePreviewUrl(`agent-preview://${t}/%E0%A4%A`)).toBeNull()
    expect(parsePreviewUrl('não é url')).toBeNull()
  })

  it('".." (literal ou %2e%2e) é preso na raiz pela própria normalização da URL', () => {
    const t = rootToken(site)
    expect(parsePreviewUrl(`agent-preview://${t}/../../fora.html`)).toEqual({ kind: 'root', token: t, segments: ['fora.html'] })
    expect(parsePreviewUrl(`agent-preview://${t}/%2e%2e/fora.html`)).toEqual({ kind: 'root', token: t, segments: ['fora.html'] })
  })
})

describe('resolvePreviewRequest', () => {
  it('serve o HTML e os relativos dentro da pasta registrada', async () => {
    const url = previewHtmlUrl(join(site, 'index.html'))
    const r = await resolvePreviewRequest(url)
    expect(r).toMatchObject({ ok: true, mime: 'text/html; charset=utf-8' })
    const img = await resolvePreviewRequest(new URL('img/a%20b.png', url).href)
    expect(img).toMatchObject({ ok: true, mime: 'image/png' })
    expect((img as { file: string }).file.endsWith('a b.png')).toBe(true)
  })

  it('pasta (inclusive a raiz) cai no index.html dela', async () => {
    const t = registerPreviewRoot(site)
    expect(await resolvePreviewRequest(`agent-preview://${t}/`)).toMatchObject({ ok: true })
    const docs = await resolvePreviewRequest(`agent-preview://${t}/docs`)
    expect((docs as { file: string }).file).toBe(join(site, 'docs', 'index.html'))
  })

  it('token desconhecido, inexistente, sensível e URL inválida', async () => {
    expect(await resolvePreviewRequest(`agent-preview://${rootToken(site)}/index.html`)).toMatchObject({
      ok: false,
      status: 404,
      message: expect.stringContaining('expirado')
    })
    const t = registerPreviewRoot(site)
    expect(await resolvePreviewRequest(`agent-preview://${t}/nada.css`)).toMatchObject({ ok: false, status: 404 })
    expect(await resolvePreviewRequest(`agent-preview://${t}/.env`)).toMatchObject({ ok: false, status: 403 })
    // Arquivo irmão da pasta: o "..%5C" é recusado (400) e o "%2e%2e" vira site/fora.html (404).
    expect(await resolvePreviewRequest(`agent-preview://${t}/..%5Cfora.html`)).toMatchObject({ ok: false, status: 400 })
    expect(await resolvePreviewRequest(`agent-preview://${t}/%2e%2e/fora.html`)).toMatchObject({ ok: false, status: 404 })
  })

  it('file host: um arquivo só, com a mesma barreira', async () => {
    expect(await resolvePreviewRequest(previewFileUrl(join(site, 'img', 'a b.png')))).toMatchObject({ ok: true, mime: 'image/png' })
    expect(await resolvePreviewRequest(previewFileUrl(join(site, '.env')))).toMatchObject({ ok: false, status: 403 })
    expect(await resolvePreviewRequest(previewFileUrl(join(base, 'x.png')))).toMatchObject({ ok: false, status: 404 })
    expect(await resolvePreviewRequest(previewFileUrl('relativo.png'))).toMatchObject({ ok: false, status: 400 })
  })

  it('file host não serve documento ativo (html/svg/xml): todos ali seriam da mesma origem', async () => {
    writeFileSync(join(base, 'x.svg'), '<svg/>')
    writeFileSync(join(base, 'x.xml'), '<a/>')
    for (const name of ['fora.html', 'x.svg', 'x.xml', 'FORA.HTML']) {
      expect(await resolvePreviewRequest(previewFileUrl(join(base, name)))).toMatchObject({ ok: false, status: 403 })
    }
  })

  it('file host: link com nome .png que aponta para um .html é recusado pelo destino', async () => {
    const link = join(base, 'disfarce.png')
    if (!trySymlink(join(base, 'fora.html'), link)) return
    expect(await resolvePreviewRequest(previewFileUrl(link))).toMatchObject({ ok: false, status: 403 })
  })

  it('previewMediaUrl registra o caminho aberto (sem caixa no Windows); clearPreviewRoots esquece', () => {
    const p = join(site, 'img', 'a b.png')
    expect(isOpenedPreviewFile(p)).toBe(false)
    expect(previewMediaUrl(p)).toBe(previewFileUrl(p))
    expect(isOpenedPreviewFile(p)).toBe(true)
    if (process.platform === 'win32') expect(isOpenedPreviewFile(p.toUpperCase())).toBe(true)
    expect(isOpenedPreviewFile(join(site, 'index.html'))).toBe(false)
    clearPreviewRoots()
    expect(isOpenedPreviewFile(p)).toBe(false)
  })

  it('mimeFor', () => {
    expect(mimeFor('a.CSS')).toBe('text/css; charset=utf-8')
    expect(mimeFor('v.mp4')).toBe('video/mp4')
    expect(mimeFor('x.bin')).toBe('application/octet-stream')
  })
})
