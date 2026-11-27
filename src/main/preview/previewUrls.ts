/**
 * Formatos de URL do protocolo agent-preview:// — PURO (sem Electron).
 *
 *   agent-preview://file/<encodeURIComponent(caminho absoluto)>
 *       Formato do contrato (shared/preview.ts: previewFileUrl/pathFromPreviewUrl).
 *       Serve UM arquivo e só ele: é o que a mídia (imagem, pdf, vídeo, áudio)
 *       usa. Um HTML aberto assim não resolveria os relativos (o caminho todo
 *       vira um segmento só) — e por isso o host `file` não serve html/svg/xml:
 *       todo arquivo dele é da mesma origem, e um script ali leria os outros.
 *       Só é servido para página agent-preview: ou para o caminho que o app
 *       abriu (previewMediaUrl); ver previewProtocol.ts.
 *
 *   agent-preview://<token>/<segmentos relativos codificados>
 *       Formato do HTML/SVG local. O host é um token (hex) da PASTA do arquivo,
 *       e o caminho é relativo a ela: `<img src="img/a.png">` e `../x.css`
 *       resolvem pelo próprio Chromium dentro dessa pasta (o `..` acima da raiz
 *       é preso nela pela normalização da URL). Cada pasta é uma origem: o
 *       localStorage de um projeto não vaza para outro. O token é determinístico
 *       (sha256 do caminho normalizado), mas só vale depois que o main o
 *       registrou — readPreviewFile registra ao devolver a URL; reiniciado o app,
 *       o renderer pede previewReadFile de novo para reabrir.
 */
import { createHash } from 'node:crypto'
import { basename, dirname } from 'node:path'
import { normalizePath } from '../../shared/pathGuard'
import { PREVIEW_PROTOCOL, pathFromPreviewUrl, previewFileUrl } from '../../shared/preview'

/** Host reservado do formato do contrato. */
export const FILE_HOST = 'file'

/** token → pasta raiz (com a caixa original). Em memória, vale enquanto o app roda. */
const roots = new Map<string, string>()

/** Token (20 hex) da pasta: o mesmo para a mesma pasta, em qualquer caixa no Windows. */
export function rootToken(dir: string): string {
  return createHash('sha256').update(normalizePath(dir)).digest('hex').slice(0, 20)
}

/** Registra a pasta como raiz servível e devolve o token dela. */
export function registerPreviewRoot(dir: string): string {
  const token = rootToken(dir)
  roots.set(token, dir)
  return token
}

/** Pasta registrada para o token; undefined se o main não a conhece. */
export function rootForToken(token: string): string | undefined {
  return roots.get(token.toLowerCase())
}

/**
 * Arquivos que o próprio app abriu pelo host `file` (readPreviewFile → mídia),
 * pelo caminho normalizado. É a navegação de topo legítima do <webview>: ela
 * chega sem Origin/Referer, igual a um `<img referrerpolicy=no-referrer>` de um
 * site — só que o site não consegue registrar nada aqui.
 */
const openedFiles = new Set<string>()
const MAX_OPENED_FILES = 2000

/** Só para os testes: esquece as raízes e os arquivos registrados. */
export function clearPreviewRoots(): void {
  roots.clear()
  openedFiles.clear()
}

/** URL `agent-preview://file/...` de uma mídia aberta pelo app (registra o caminho). */
export function previewMediaUrl(absPath: string): string {
  const key = normalizePath(absPath)
  openedFiles.delete(key)
  openedFiles.add(key)
  // Teto de memória: esquece o mais antigo (o renderer reabre com previewReadFile).
  if (openedFiles.size > MAX_OPENED_FILES) openedFiles.delete(openedFiles.values().next().value as string)
  return previewFileUrl(absPath)
}

/** O app abriu este caminho com previewMediaUrl? */
export function isOpenedPreviewFile(absPath: string): boolean {
  return openedFiles.has(normalizePath(absPath))
}

/** URL de um HTML/SVG local com os relativos funcionando (registra a pasta dele). */
export function previewHtmlUrl(absPath: string): string {
  const token = registerPreviewRoot(dirname(absPath))
  return `${PREVIEW_PROTOCOL}://${token}/${encodeURIComponent(basename(absPath))}`
}

export type ParsedPreviewUrl =
  | { kind: 'file'; path: string }
  | { kind: 'root'; token: string; segments: string[] }

/** Segmento que poderia sair da raiz ou trocar de unidade/fluxo NTFS. */
function badSegment(seg: string): boolean {
  return seg === '.' || seg === '..' || /[\\/:\0]/.test(seg)
}

/** Lê uma URL do protocolo; null se não for nossa ou for malformada/perigosa. */
export function parsePreviewUrl(url: string): ParsedPreviewUrl | null {
  const path = pathFromPreviewUrl(url)
  if (path !== null) return path ? { kind: 'file', path } : null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== `${PREVIEW_PROTOCOL}:`) return null
  const token = u.hostname.toLowerCase()
  if (!/^[a-f0-9]{20}$/.test(token)) return null
  const segments: string[] = []
  for (const raw of u.pathname.split('/')) {
    if (!raw) continue
    let seg: string
    try {
      seg = decodeURIComponent(raw)
    } catch {
      return null
    }
    if (badSegment(seg)) return null
    segments.push(seg)
  }
  return { kind: 'root', token, segments }
}
