/**
 * Seletor CSS e captura do elemento clicado no preview (porte do
 * inspector-selector do Nexos). Funções puras sobre o DOM: sem Electron,
 * testadas em jsdom.
 *
 * O seletor prefere o que sobrevive a um rebuild: #id, depois classes
 * "estáveis" (descarta as geradas por CSS-in-JS / hash), e só então
 * tag:nth-of-type. Sobe no máximo 4 níveis e para no primeiro id.
 */
import type { InspectorPick } from '../../shared/preview'

export const MAX_HTML = 300
export const MAX_TEXT = 150
const MAX_LEVELS = 4

/** Classes geradas (css-xxx, sc-, emotion-, jsx-, _x, sufixo __hash, só hex). */
const GENERATED_CLASS_RE = /^(css-|sc-|emotion-|jsx-|_)|__[a-z0-9]{5,}$|^[a-f0-9]{6,}$/i

/** Corta em `max` caracteres, com reticências. */
export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** Texto visível do elemento: espaços colapsados e sem bordas. */
export function visibleText(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** Até 2 classes que não parecem geradas (sem escapar; segmentFor escapa). */
export function stableClasses(el: Element): string[] {
  return Array.from(el.classList)
    .filter((c) => c && !GENERATED_CLASS_RE.test(c))
    .slice(0, 2)
}

/** Escapa um identificador CSS (usa CSS.escape quando existe). */
export function cssEscape(s: string): string {
  const g = globalThis as { CSS?: { escape?: (v: string) => string } }
  if (g.CSS?.escape) return g.CSS.escape(s)
  return s.replace(/^(\d)/, '\\3$1 ').replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch)
}

/** Um nível do seletor: #id, tag.classe, ou tag[:nth-of-type(n)] se houver irmãos iguais. */
export function segmentFor(el: Element): string {
  if (el.id) return '#' + cssEscape(el.id)
  const tag = el.tagName.toLowerCase()
  const classes = stableClasses(el)
  if (classes.length) return tag + classes.map((c) => '.' + cssEscape(c)).join('')
  const parent = el.parentElement
  if (!parent) return tag
  const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName)
  if (sameTag.length <= 1) return tag
  return `${tag}:nth-of-type(${sameTag.indexOf(el) + 1})`
}

/** Seletor de até 4 níveis, parando no primeiro id; nunca inclui body/html. */
export function buildSelector(el: Element): string {
  const parts: string[] = []
  let cur: Element | null = el
  while (cur && parts.length < MAX_LEVELS) {
    const tag = cur.tagName.toLowerCase()
    if (tag === 'body' || tag === 'html') break
    const seg = segmentFor(cur)
    parts.unshift(seg)
    if (seg.startsWith('#')) break
    cur = cur.parentElement
  }
  return parts.join(' > ') || el.tagName.toLowerCase()
}

/** O que o seletor manda ao host; url e index são postos pelo preload. */
export type ElementCapture = Omit<InspectorPick, 'url' | 'index'>

export function captureElement(el: Element): ElementCapture {
  return {
    tagName: el.tagName.toLowerCase(),
    selector: buildSelector(el),
    id: el.id || '',
    classes: Array.from(el.classList).join(' '),
    text: truncate(visibleText(el), MAX_TEXT),
    html: truncate(el.outerHTML, MAX_HTML)
  }
}
