/**
 * Decide o que o protocolo agent-preview:// entrega para uma URL — PURO no
 * sentido de não depender do Electron (só node:fs), para testar sem o app.
 * A barreira é a da leitura (checkPreviewPath); no formato com token o
 * arquivo ainda precisa ficar DENTRO da pasta registrada (também pelo
 * caminho real, contra link simbólico que aponte para fora).
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { isInside } from '../../shared/pathGuard'
import { extOf } from '../../shared/preview'
import { checkPreviewPath, type PreviewGuardFail } from './previewGuard'
import { parsePreviewUrl, rootForToken } from './previewUrls'

export type PreviewServeResult = { ok: true; file: string; mime: string } | { ok: false; status: number; message: string }

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4'
}

/** Content-Type pela extensão (octet-stream se desconhecida). */
export function mimeFor(path: string): string {
  return MIME[extOf(path)] ?? 'application/octet-stream'
}

/**
 * Documento que roda script (html, svg, xml/xhtml). No host `file` todo arquivo
 * é da MESMA origem (agent-preview://file): um script ali leria qualquer outro
 * arquivo do disco por fetch. HTML/SVG abrem pelo formato com token (uma origem
 * por pasta) — previewHtmlUrl.
 */
const ACTIVE_DOC_EXT = new Set(['html', 'htm', 'xhtml', 'xht', 'svg', 'svgz', 'xml', 'xsl', 'xslt', 'mht', 'mhtml'])
const ACTIVE_DOC_FAIL: PreviewServeResult = {
  ok: false,
  status: 403,
  message: 'Página (html/svg/xml) não abre por este endereço: abra o arquivo de novo pelo Preview.'
}

function failStatus(f: PreviewGuardFail): PreviewServeResult {
  const status = f.reason === 'blocked' ? 403 : f.reason === 'error' ? 400 : 404
  return { ok: false, status, message: f.message }
}

async function realOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    return p
  }
}

/** Resolve a URL pedida pelo <webview> para um arquivo servível. Nunca lança. */
export async function resolvePreviewRequest(url: string): Promise<PreviewServeResult> {
  const parsed = parsePreviewUrl(url)
  if (!parsed) return { ok: false, status: 400, message: 'Endereço do preview inválido.' }

  if (parsed.kind === 'file') {
    if (ACTIVE_DOC_EXT.has(extOf(parsed.path))) return ACTIVE_DOC_FAIL
    const g = await checkPreviewPath(parsed.path)
    if (!g.ok) return failStatus(g)
    // Link com nome .png que aponta para um .html: vale a extensão do destino.
    if (ACTIVE_DOC_EXT.has(extOf(g.real))) return ACTIVE_DOC_FAIL
    return { ok: true, file: g.real, mime: mimeFor(g.real) }
  }

  const root = rootForToken(parsed.token)
  if (!root) return { ok: false, status: 404, message: 'Preview expirado: abra o arquivo de novo.' }
  const realRoot = await realOrSelf(root)

  let candidate = join(root, ...parsed.segments)
  let g = await checkPreviewPath(candidate)
  // Pasta (inclusive a raiz): serve o index.html dela, como um servidor estático.
  if (!g.ok && g.reason === 'unsupported') {
    candidate = join(candidate, 'index.html')
    g = await checkPreviewPath(candidate)
  }
  if (!g.ok) return failStatus(g)
  // O arquivo servido fica sempre ABAIXO da raiz (é arquivo; a raiz é pasta).
  if (!isInside(g.real, realRoot)) {
    return { ok: false, status: 403, message: 'Arquivo fora da pasta do preview.' }
  }
  return { ok: true, file: g.real, mime: mimeFor(g.real) }
}
