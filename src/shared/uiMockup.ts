import type { UiMockupArtifact, UiMockupSeed } from './ipc'

export const UI_MOCKUP_TOOL_NAME = 'render_ui_mockup'
export const UI_MOCKUP_MCP_TOOL_NAME = 'mcp__wiremd__render_ui_mockup'
export const MAX_UI_MOCKUP_TITLE = 80
export const MAX_UI_MOCKUP_SOURCE = 2_500
export const MAX_UI_MOCKUP_HTML = 250_000

export const UI_MOCKUP_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  "font-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "media-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join('; ')

export const UI_MOCKUP_DOCUMENT_PREFIX = '<!doctype html><html><head>' +
  '<meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  `<meta http-equiv="Content-Security-Policy" content="${UI_MOCKUP_CSP}">` +
  '<style>'
const UI_MOCKUP_BODY_BOUNDARY = '</style></head><body class="wmd-root wmd-clean">'

export const UI_MOCKUP_ALLOWED_TAGS = [
  'a', 'article', 'aside', 'blockquote', 'br', 'button', 'circle', 'code', 'details', 'div', 'em',
  'fieldset', 'figcaption', 'figure', 'footer', 'g', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hr', 'img', 'input', 'label', 'legend', 'li', 'line', 'main', 'nav', 'ol', 'option', 'p', 'path',
  'polygon', 'polyline', 'pre', 'rect', 'section', 'select', 'small', 'span', 'strong', 'summary', 'svg',
  'table', 'tbody', 'td', 'textarea', 'tfoot', 'th', 'thead', 'tr', 'ul'
] as const

export const UI_MOCKUP_ALLOWED_ATTRIBUTES: Record<string, readonly string[]> = {
  '*': ['class', 'title', 'role', 'aria-label', 'hidden'],
  button: ['type', 'disabled'],
  details: ['open'],
  input: ['type', 'placeholder', 'value', 'checked', 'disabled', 'required', 'min', 'max', 'step'],
  textarea: ['placeholder', 'rows', 'cols', 'disabled', 'required'],
  select: ['disabled', 'required', 'multiple'],
  option: ['value', 'selected', 'disabled'],
  img: ['alt', 'width', 'height'],
  svg: ['width', 'height', 'viewbox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'],
  path: ['d', 'fill', 'stroke', 'stroke-width', 'transform'],
  circle: ['cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry', 'fill', 'stroke', 'stroke-width'],
  line: ['x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width'],
  polyline: ['points', 'fill', 'stroke', 'stroke-width'],
  polygon: ['points', 'fill', 'stroke', 'stroke-width'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan']
}

const MAX_UI_MOCKUP_ID = 128
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const ACTIVE_MARKUP = /<\s*\/?\s*(?:script|iframe|object|embed|form|base|link)\b/i
const ACTIVE_ATTRIBUTE = /(?:^|[\s/])(?:on[a-z0-9_-]+|href|src|srcset|imagesrcset|ping|manifest|action|formaction|poster|background|data|xlink:href)\s*=/i
const ACTIVE_PROTOCOL_OR_CSS = /(?:javascript|vbscript)\s*:|@import\b|url\s*\(|expression\s*\(|behavior\s*:|-moz-binding/i
const META_REFRESH = /<meta\b[^>]*http-equiv\s*=\s*(["'])?refresh\1/i
const ALLOWED_TAG_SET = new Set<string>(UI_MOCKUP_ALLOWED_TAGS)
const SAFE_CLASS = /^(?:icon|(?:wmd|icon|icons)-[a-z0-9-]+)$/i
const BODY_TAG = /<\/?([a-z][a-z0-9-]*)(?:\s[^<>]*?)?\/?>/gi
const ATTRIBUTE = /^\s+([a-z_:][a-z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/i
const LAYOUT_ATTRIBUTE_LIMITS: Record<string, [number, number]> = {
  rows: [1, 20],
  cols: [1, 120],
  colspan: [1, 12],
  rowspan: [1, 12],
  width: [0, 4_096],
  height: [0, 4_096]
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

function hasValidSeedFields(value: UnknownRecord): boolean {
  return (
    isBoundedString(value.id, MAX_UI_MOCKUP_ID) &&
    Number.isSafeInteger(value.version) &&
    (value.version as number) >= 1 &&
    isBoundedString(value.title, MAX_UI_MOCKUP_TITLE) &&
    !CONTROL_CHARACTERS.test(value.title as string) &&
    isBoundedString(value.source, MAX_UI_MOCKUP_SOURCE) &&
    (value.viewport === 'desktop' || value.viewport === 'mobile')
  )
}

function hasCanonicalCsp(html: string): boolean {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? []
  const canonicalTag = `<meta http-equiv="Content-Security-Policy" content="${UI_MOCKUP_CSP}">`
  return metaTags.filter((tag) => tag === canonicalTag).length === 1
}

function hasCanonicalMetadata(html: string): boolean {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? []
  if (metaTags.length !== 3) return false
  const hasCharset = metaTags.some((tag) => /^<meta\s+charset=(['"])utf-8\1>$/i.test(tag))
  const hasViewport = metaTags.some((tag) =>
    /^<meta\s+name=(['"])viewport\1\s+content=(['"])width=device-width, initial-scale=1\2>$/i.test(tag)
  )
  return hasCharset && hasViewport && hasCanonicalCsp(html)
}

function hasSingleDocumentBoundary(html: string): boolean {
  const count = (pattern: RegExp): number => html.match(pattern)?.length ?? 0
  return (
    count(/<!doctype html>/gi) === 1 &&
    count(/<html\b/gi) === 1 &&
    count(/<\/html>/gi) === 1 &&
    count(/<head\b/gi) === 1 &&
    count(/<\/head>/gi) === 1 &&
    count(/<body\b/gi) === 1 &&
    count(/<\/body>/gi) === 1
  )
}

function hasOnlyAllowedAttributes(tag: string, tagName: string): boolean {
  if (/^<\//.test(tag)) return new RegExp(`^<\\/${tagName}\\s*>$`, 'i').test(tag)
  const endLength = /\/>$/.test(tag) ? 2 : 1
  let rest = tag.slice(1 + tagName.length, tag.length - endLength)
  const allowed = new Set([
    ...(UI_MOCKUP_ALLOWED_ATTRIBUTES['*'] ?? []),
    ...(UI_MOCKUP_ALLOWED_ATTRIBUTES[tagName] ?? [])
  ])
  const seen = new Set<string>()
  while (rest) {
    if (/^\s*$/.test(rest)) return true
    const match = ATTRIBUTE.exec(rest)
    if (!match) return false
    const name = match[1].toLowerCase()
    if (!allowed.has(name) || seen.has(name)) return false
    seen.add(name)
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    if (CONTROL_CHARACTERS.test(value)) return false
    if (name === 'class' && value.split(/\s+/).filter(Boolean).some((item) => !SAFE_CLASS.test(item))) return false
    if ((name === 'fill' || name === 'stroke') && /url\s*\(|(?:javascript|vbscript|data)\s*:/i.test(value)) return false
    const numericLimit = LAYOUT_ATTRIBUTE_LIMITS[name]
    if (numericLimit) {
      if (!/^\d+(?:\.\d+)?$/.test(value)) return false
      const numeric = Number(value)
      if (!Number.isFinite(numeric) || numeric < numericLimit[0] || numeric > numericLimit[1]) return false
    }
    rest = rest.slice(match[0].length)
  }
  return true
}

function hasOnlyAllowedBodyMarkup(body: string): boolean {
  let cursor = 0
  BODY_TAG.lastIndex = 0
  for (let match = BODY_TAG.exec(body); match; match = BODY_TAG.exec(body)) {
    if (body.slice(cursor, match.index).includes('<')) return false
    const tagName = match[1].toLowerCase()
    if (!ALLOWED_TAG_SET.has(tagName) || !hasOnlyAllowedAttributes(match[0], tagName)) return false
    cursor = match.index + match[0].length
  }
  return !body.slice(cursor).includes('<')
}

export function isSafeUiMockupHtml(value: unknown): value is string {
  if (!isBoundedString(value, MAX_UI_MOCKUP_HTML)) return false
  const html = value
  if (!html.startsWith(UI_MOCKUP_DOCUMENT_PREFIX)) return false
  if (!html.endsWith('</body></html>')) return false
  if (!hasSingleDocumentBoundary(html) || !hasCanonicalMetadata(html)) return false
  if ((html.match(/<style>/g) ?? []).length !== 1 || (html.match(/<\/style>/g) ?? []).length !== 1) return false
  if ((html.match(/<\/style><\/head><body class="wmd-root wmd-clean">/g) ?? []).length !== 1) return false
  if (!html.includes(UI_MOCKUP_BODY_BOUNDARY)) return false
  if (ACTIVE_MARKUP.test(html) || META_REFRESH.test(html)) return false
  const tags = html.match(/<[^>]+>/g) ?? []
  if (tags.some((tag) => ACTIVE_ATTRIBUTE.test(tag))) return false
  const styles = [...html.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi)]
  if (styles.some((match) => ACTIVE_PROTOCOL_OR_CSS.test(match[1]))) return false
  const bodyStart = html.indexOf(UI_MOCKUP_BODY_BOUNDARY) + UI_MOCKUP_BODY_BOUNDARY.length
  const body = html.slice(bodyStart, -'</body></html>'.length)
  return hasOnlyAllowedBodyMarkup(body)
}

export function normalizeUiMockupTitle(title: string): string {
  return title.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR')
}

export function isRenderUiMockupToolName(value: unknown): value is string {
  return value === UI_MOCKUP_TOOL_NAME || value === UI_MOCKUP_MCP_TOOL_NAME
}

export function isSafeUiMockupSeed(value: unknown): value is UiMockupSeed {
  return isRecord(value) && hasValidSeedFields(value)
}

export function isSafeUiMockupArtifact(value: unknown): value is UiMockupArtifact {
  return (
    isRecord(value) &&
    value.type === 'ui_mockup' &&
    hasValidSeedFields(value) &&
    isSafeUiMockupHtml(value.html)
  )
}

function candidateSeed(value: unknown): UiMockupSeed | null {
  let candidate = value
  if (isRecord(value) && value.kind === 'ui-mockup') candidate = value.artifact

  // An artifact with unsafe HTML must not be accepted through the less strict
  // seed shape merely because it also contains all seed fields.
  if (isRecord(candidate) && ('html' in candidate || candidate.type === 'ui_mockup')) {
    if (!isSafeUiMockupArtifact(candidate)) return null
  } else if (!isSafeUiMockupSeed(candidate)) {
    return null
  }

  const seed = candidate as UiMockupSeed
  return {
    id: seed.id,
    version: seed.version,
    title: seed.title,
    source: seed.source,
    viewport: seed.viewport
  }
}

/**
 * Return all safe seeds, newest title first. Input order is treated as
 * chronological. A title is deduplicated after NFKC/trim/case normalization;
 * its highest valid version supplies the seed while its last occurrence
 * determines recency.
 */
export function latestUiMockupSeeds(values: readonly unknown[]): UiMockupSeed[] {
  const byTitle = new Map<string, { seed: UiMockupSeed; lastSeen: number }>()

  values.forEach((value, index) => {
    const seed = candidateSeed(value)
    if (!seed) return
    const key = normalizeUiMockupTitle(seed.title)
    const current = byTitle.get(key)
    if (!current) {
      byTitle.set(key, { seed, lastSeen: index })
      return
    }
    if (seed.version >= current.seed.version) current.seed = seed
    current.lastSeen = index
  })

  return [...byTitle.values()]
    .sort((left, right) => right.lastSeen - left.lastSeen)
    .map(({ seed }) => ({ ...seed }))
}
