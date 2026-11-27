/**
 * Regras puras das abas do Preview: o que o campo de endereço aceita, como
 * duas aberturas do mesmo alvo viram a mesma aba e que título a aba ganha.
 * Sem React, para testar direto.
 */
import { extOf, isWebUrl, pathFromPreviewUrl, previewKindFor, type PreviewTab } from '@shared/preview'
import { callPath } from '../office3d/officeCalls'

/** Caminho absoluto: C:\…, C:/…, \\servidor\… ou /…. */
const ABS_PATH = /^([a-zA-Z]:[\\/]|\\\\|\/)/

/** localhost, 127.x e 0.0.0.0 (com porta e caminho opcionais). */
const LOCAL_HOST = /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0)(:\d+)?([/?#].*)?$/i

/** Algo com cara de domínio: nome.tld, com porta/caminho opcionais. */
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([/?#].*)?$/i

/** `file:///C:/a/b.md` → `C:\a\b.md`; `file:///home/x` → `/home/x`. */
function pathFromFileUrl(url: string): string | null {
  try {
    const rest = decodeURIComponent(url.replace(/^file:\/*/i, '').split(/[?#]/)[0])
    if (/^[a-zA-Z]:[\\/]/.test(rest)) return rest.replace(/\//g, '\\')
    return '/' + rest
  } catch {
    return null
  }
}

/**
 * O que o usuário digitou (ou o link/caminho clicado) → URL http(s) ou caminho
 * absoluto. null = não dá para saber o que é.
 */
export function normalizeTarget(input: string, cwd?: string): string | null {
  const s = input.trim().replace(/^["'<]+|["'>]+$/g, '').trim()
  if (!s) return null
  if (isWebUrl(s)) return s
  if (/^file:/i.test(s)) return pathFromFileUrl(s)
  const fromPreview = pathFromPreviewUrl(s)
  if (fromPreview) return fromPreview
  if (ABS_PATH.test(s)) return s
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !LOCAL_HOST.test(s) && !DOMAIN.test(s)) return null // mailto:, javascript:, etc.
  if (LOCAL_HOST.test(s)) return `http://${s}`
  // "relatorio.md" com o projeto aberto: arquivo do projeto. "example.com": site.
  const kind = previewKindFor(s)
  if (kind !== 'unsupported' && !s.includes(' ')) {
    if (cwd) return callPath(s, cwd)
    return null
  }
  if (DOMAIN.test(s) && !s.includes(' ')) return `https://${s}`
  return null
}

/** Pasta de um caminho de arquivo: `C:\a\b.md` → `C:\a`; `/x/y.md` → `/x`. */
export function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  if (i < 0) return path
  return i === 0 ? path.slice(0, 1) : path.slice(0, i)
}

/**
 * Link relativo de um arquivo aberto no Preview (`./b.md`, `../img/a.png`,
 * `pasta%20x/c.md`) → caminho absoluto a partir da pasta `baseDir`. null = não
 * é relativo (site, file:, C:\…, \\…, esquema, #âncora) ou não é arquivo que o
 * Preview abre.
 */
export function resolveRelativeLink(input: string, baseDir: string): string | null {
  const s = input.trim().replace(/^<|>$/g, '')
  if (!s || !baseDir || s.startsWith('#') || isWebUrl(s) || ABS_PATH.test(s) || /^[a-z][a-z0-9+.-]*:/i.test(s)) return null
  let rel: string
  try {
    rel = decodeURIComponent(s.split(/[?#]/)[0])
  } catch {
    return null
  }
  if (!rel || ABS_PATH.test(rel) || previewKindFor(rel) === 'unsupported') return null
  const sep = baseDir.includes('\\') ? '\\' : '/'
  const parts = baseDir.replace(/[\\/]+$/, '').split(/[\\/]/)
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === '' || seg === '.') continue
    // Nunca sobe acima da raiz (C: ou /).
    if (seg === '..') {
      if (parts.length > 1) parts.pop()
    } else parts.push(seg)
  }
  return parts.join(sep) || sep
}

/** Chave para achar a aba já aberta do mesmo alvo. */
export function targetKey(target: string): string {
  if (isWebUrl(target)) return target.replace(/\/+$/, '')
  return target.replace(/\//g, '\\').toLowerCase()
}

/** Título inicial da aba: o host do site ou o nome do arquivo. */
export function titleFor(target: string): string {
  if (isWebUrl(target)) {
    try {
      return new URL(target).host || target
    } catch {
      return target
    }
  }
  return target.split(/[\\/]/).filter(Boolean).pop() ?? target
}

let seq = 0
/** Id novo de aba. */
export function newTabId(): string {
  seq += 1
  return `pv-${Date.now().toString(36)}-${seq}`
}

/** A aba de um alvo já normalizado. */
export function makeTab(target: string): PreviewTab {
  return { id: newTabId(), kind: previewKindFor(target), target, title: titleFor(target) }
}

/** Mostra no <webview> (site, página ou mídia local) em vez do FileViewer? */
export function opensInWebview(tab: Pick<PreviewTab, 'kind'>): boolean {
  return tab.kind === 'web' || tab.kind === 'html' || tab.kind === 'media'
}

/** Extensão em maiúsculas para o rótulo da aba ("MD", "XLSX"); '' em site. */
export function extLabel(target: string): string {
  return isWebUrl(target) ? '' : extOf(target).toUpperCase()
}
