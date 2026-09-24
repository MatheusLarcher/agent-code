/**
 * Monta a página HTML que o main imprime em PDF (Channels.planningExportPdf):
 * o viewport do React Flow clonado, reposicionado para mostrar TODOS os cards
 * (não só o que está na tela), mais o CSS do app. Os ancestrais do viewport
 * vão junto, rasos, para os seletores do planning.css continuarem valendo.
 *
 * Mídia: o PDF leva só os NOMES dos anexos (lista em cada card); miniaturas
 * (img com data:/blob:) não vão — embutir imagem no PDF está fora do escopo.
 */
import type { FlowPdfRequest, PlanningCardDto } from '@shared/ipc'

export interface FlowBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Folga em volta dos cards (px): as setas curvas passam um pouco da caixa deles. */
export const PDF_PADDING = 48
/** Maior lado da página (px CSS), abaixo do teto do main (19000): flows enormes encolhem. */
export const PDF_MAX_SIDE = 18_000

/** Tamanho da página e a escala para caber em PDF_MAX_SIDE. */
export function pageGeometry(bounds: FlowBounds): { width: number; height: number; scale: number } {
  const w = bounds.width + PDF_PADDING * 2
  const h = bounds.height + PDF_PADDING * 2
  const scale = Math.min(1, PDF_MAX_SIDE / Math.max(w, h))
  return { width: Math.ceil(w * scale), height: Math.ceil(h * scale), scale }
}

/** url(...) relativo resolvido contra a folha de onde veio (a página vive em %TEMP%). */
export function absolutizeUrls(css: string, base: string): string {
  return css.replace(/url\((['"]?)([^'")]+)\1\)/g, (all, q: string, ref: string) => {
    if (/^(data:|blob:|[a-z][a-z0-9+.-]*:|#)/i.test(ref.trim())) return all
    try {
      return `url(${q}${new URL(ref.trim(), base).href}${q})`
    } catch {
      return all
    }
  })
}

function collectCss(doc: Document): string {
  const out: string[] = []
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue // folha de outra origem: sem acesso às regras
    }
    const base = sheet.href ?? doc.baseURI
    for (const rule of Array.from(rules)) out.push(absolutizeUrls(rule.cssText, base))
  }
  return out.join('\n')
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
}

function attrs(el: Element): string {
  return Array.from(el.attributes)
    .map((a) => ` ${a.name}="${escapeHtml(a.value)}"`)
    .join('')
}

/** Classe da lista de anexos que o PDF acrescenta no card. */
export const PDF_ANEXOS_CLASS = 'pl-pdf-anexos'

/**
 * No clone (nunca no canvas da tela): em cada card com anexos, a faixa de
 * mídia do nó (`.pl-card-media`: miniaturas/etiquetas, até 3 e "+N") vira a
 * lista com TODOS os nomes, logo abaixo do título. Miniatura que sobrar (card
 * que não veio em `cards`) vira o nome dela (alt) — imagem não vai ao PDF.
 */
export function listAnexosInClone(root: HTMLElement, cards: readonly Pick<PlanningCardDto, 'id' | 'anexos'>[]): void {
  const doc = root.ownerDocument
  const byId = new Map(cards.filter((c) => (c.anexos?.length ?? 0) > 0).map((c) => [c.id, c.anexos as string[]]))
  for (const node of Array.from(root.querySelectorAll<HTMLElement>('.react-flow__node[data-id]'))) {
    const anexos = byId.get(node.getAttribute('data-id') ?? '')
    if (!anexos) continue
    const list = doc.createElement('div')
    list.className = PDF_ANEXOS_CLASS
    list.style.cssText = 'margin:4px 0;font-size:11px;line-height:1.35;opacity:.85;overflow-wrap:anywhere'
    list.textContent = `Anexos: ${anexos.join(', ')}`
    const strip = node.querySelector('.pl-card-media')
    const title = node.querySelector('.pl-card-title')
    if (strip) strip.replaceWith(list)
    else if (title) title.after(list)
    else (node.querySelector('.pl-card-inner') ?? node).appendChild(list)
  }
  for (const img of Array.from(root.querySelectorAll('.react-flow__node img'))) {
    if (!/^(data:|blob:)/i.test(img.getAttribute('src') ?? '')) continue
    const name = doc.createElement('span')
    name.className = 'pl-pdf-media-name'
    name.textContent = img.getAttribute('alt') ?? ''
    img.replaceWith(name)
  }
}

/**
 * `canvas`: o elemento que contém o `.react-flow` do planejamento.
 * `bounds`: caixa de todos os cards em coordenadas do flow (getNodesBounds).
 * `cards`: os cards do plano, para listar os nomes dos anexos (opcional).
 * null quando não há flow montado.
 */
export function buildFlowPdf(
  canvas: Element,
  bounds: FlowBounds,
  name: string,
  cards: readonly Pick<PlanningCardDto, 'id' | 'anexos'>[] = []
): FlowPdfRequest | null {
  const viewport = canvas.querySelector('.react-flow__viewport')
  const doc = canvas.ownerDocument
  if (!(viewport instanceof HTMLElement) || !doc.body) return null
  const { width, height, scale } = pageGeometry(bounds)

  const inner = viewport.cloneNode(true) as HTMLElement
  listAnexosInClone(inner, cards)
  inner.style.transform = `translate(${(PDF_PADDING - bounds.x) * scale}px, ${(PDF_PADDING - bounds.y) * scale}px) scale(${scale})`
  inner.style.transformOrigin = '0 0'

  // Ancestrais rasos (classe, estilo inline, data-*), do viewport até o body,
  // todos com o tamanho da página: o layout de tela (flex, grid) não vale aqui.
  let node: HTMLElement = inner
  for (let el = viewport.parentElement; el && el !== doc.body; el = el.parentElement) {
    const shell = el.cloneNode(false) as HTMLElement
    shell.style.cssText += `;position:relative;inset:auto;width:${width}px;height:${height}px;min-width:0;min-height:0;max-width:none;max-height:none;margin:0;padding:0;border:0;overflow:hidden;transform:none;display:block`
    shell.appendChild(node)
    node = shell
  }

  const bg = getComputedStyle(canvas.querySelector('.react-flow') ?? canvas).backgroundColor
  const page = `
@page { size: ${width}px ${height}px; margin: 0; }
html, body { margin: 0; padding: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: ${bg}; }
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; animation: none !important; transition: none !important; }
.react-flow__handle { visibility: hidden !important; }`

  const html = `<!doctype html>
<html${attrs(doc.documentElement)}><head><meta charset="utf-8"><title>${escapeHtml(name)}</title>
<style>${collectCss(doc)}</style><style>${page}</style></head>
<body${attrs(doc.body)}>${node.outerHTML}</body></html>`
  return { html, width, height, name }
}
