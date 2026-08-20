import { parse, renderToHTML, validate, type DocumentNode, type WiremdNode } from '@eclectic-ai/wiremd'
import sanitizeHtml from 'sanitize-html'
import {
  isSafeUiMockupHtml,
  MAX_UI_MOCKUP_HTML,
  MAX_UI_MOCKUP_SOURCE,
  UI_MOCKUP_ALLOWED_ATTRIBUTES,
  UI_MOCKUP_ALLOWED_TAGS,
  UI_MOCKUP_DOCUMENT_PREFIX
} from '../shared/uiMockup'

export const MAX_MOCKUP_SOURCE = MAX_UI_MOCKUP_SOURCE
export const MAX_MOCKUP_HTML = MAX_UI_MOCKUP_HTML

const CONTROL_TYPES = new Set([
  'button',
  'input',
  'textarea',
  'select',
  'checkbox',
  'switch',
  'radio',
  'link',
  'nav-item',
  'tab',
  'accordion-item'
])
const BLOCK_TYPES = new Set([
  'grid-item',
  'nav',
  'list',
  'table',
  'blockquote',
  'tabs',
  'accordion',
  'alert',
  'loading-state',
  'empty-state',
  'error-state'
])
const LAYOUT_TYPES = new Set(['grid', 'grid-item', 'row', 'nav', 'form', 'tabs', 'tab', 'accordion'])

export interface UiMockupRenderer {
  render(source: string): Promise<{ html: string; source: string }>
}

export interface MockupComplexity {
  screens: number
  sections: number
  columns: number
  blocks: number
  controls: number
  hierarchyDepth: number
}

export class UiMockupValidationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'UiMockupValidationError'
  }
}

export function validateWiremdSource(source: string): void {
  if (!source.trim()) throw new UiMockupValidationError('WireMD source is required.', 'SOURCE_REQUIRED')
  if (source.length > MAX_MOCKUP_SOURCE) {
    throw new UiMockupValidationError('WireMD source exceeds 2,500 characters.', 'SOURCE_TOO_LONG')
  }
  if (
    /```/.test(source) ||
    /(?:^|\n)\s*(?:import|export)\s+/m.test(source) ||
    /(?:^|\n)\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/m.test(source) ||
    /\bfunction\s+[A-Za-z_$][\w$]*\s*\(/.test(source) ||
    /\bReact\s*\.|\bclassName\s*=|=>\s*[({]/.test(source)
  ) {
    throw new UiMockupValidationError('React and JavaScript code are not accepted; provide WireMD only.', 'CODE_NOT_ALLOWED')
  }
  if (/<\s*\/?\s*[a-z][^>]*>/i.test(source)) {
    throw new UiMockupValidationError(
      'HTML is not accepted. Use WireMD containers such as ::: columns-N with nested ::: column blocks.',
      'HTML_NOT_ALLOWED'
    )
  }
  if (/(?:javascript|vbscript|data\s*:\s*text\/html)\s*:/i.test(source) || /\bon\w+\s*=/i.test(source)) {
    throw new UiMockupValidationError('JavaScript and active content are not accepted.', 'ACTIVE_CONTENT_NOT_ALLOWED')
  }
}

function childrenOf(node: WiremdNode): WiremdNode[] {
  const children = (node as { children?: unknown }).children
  return Array.isArray(children) ? (children as WiremdNode[]) : []
}

function isVisualBlock(node: WiremdNode): boolean {
  if (node.type === 'container') return !['form-group', 'layout', 'grid'].includes(node.containerType)
  return BLOCK_TYPES.has(node.type)
}

function isLayoutNode(node: WiremdNode): boolean {
  if (node.type === 'container') return !['form-group', 'layout', 'grid'].includes(node.containerType)
  return LAYOUT_TYPES.has(node.type)
}

export function analyzeMockupComplexity(ast: DocumentNode): MockupComplexity {
  const result: MockupComplexity = {
    screens: 0,
    sections: 0,
    columns: 0,
    blocks: 0,
    controls: 0,
    hierarchyDepth: 0
  }
  let nodeCount = 0

  const visit = (node: WiremdNode, layoutDepth: number): void => {
    nodeCount++
    if (nodeCount > 256) throw new UiMockupValidationError('Mockup contains too many AST nodes.', 'TOO_MANY_NODES')
    if (node.type === 'heading' && node.level === 1) result.screens++
    // Main sections are headings at document level, regardless of which
    // Markdown heading depth the model chose. Card labels inside a grid are
    // blocks, not additional main sections.
    if (node.type === 'heading' && node.level >= 2 && layoutDepth === 0) result.sections++
    if (node.type === 'grid') result.columns = Math.max(result.columns, node.columns, node.children.length)
    if (isVisualBlock(node)) result.blocks++
    if (CONTROL_TYPES.has(node.type)) result.controls++
    const nextDepth = layoutDepth + (isLayoutNode(node) ? 1 : 0)
    result.hierarchyDepth = Math.max(result.hierarchyDepth, nextDepth)
    for (const child of childrenOf(node)) visit(child, nextDepth)
  }

  for (const child of ast.children) visit(child, 0)
  // A document without an H1 still represents one screen, not zero screens.
  result.screens = Math.max(1, result.screens)
  return result
}

export function validateMockupCompactness(ast: DocumentNode): MockupComplexity {
  const validationErrors = validate(ast)
  if (validationErrors.length) {
    throw new UiMockupValidationError(validationErrors[0].message, validationErrors[0].code ?? 'INVALID_AST')
  }
  for (const node of ast.children) assertPopulatedGrids(node)
  const complexity = analyzeMockupComplexity(ast)
  const limits: Array<[keyof MockupComplexity, number]> = [
    ['screens', 1],
    ['sections', 4],
    ['columns', 4],
    ['blocks', 8],
    ['controls', 16],
    ['hierarchyDepth', 2]
  ]
  for (const [key, limit] of limits) {
    if (complexity[key] > limit) {
      throw new UiMockupValidationError(
        `Mockup is not compact: ${key} is ${complexity[key]} (maximum ${limit}).`,
        `COMPACTNESS_${key.toUpperCase()}`
      )
    }
  }
  return complexity
}

function assertPopulatedGrids(node: WiremdNode): void {
  if (node.type === 'grid' && node.children.length === 0) {
    throw new UiMockupValidationError(
      'A columns container needs nested ::: column blocks; bare content inside ::: columns-N is ignored by WireMD.',
      'EMPTY_COLUMNS'
    )
  }
  for (const child of childrenOf(node)) assertPopulatedGrids(child)
}

export function sanitizeWiremdHtml(rendered: string): string {
  if (rendered.length > MAX_MOCKUP_HTML) {
    throw new UiMockupValidationError('Rendered mockup is too large.', 'HTML_TOO_LARGE')
  }
  const styleBlocks = [...rendered.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi)].map((match) => match[1])
  const styles = styleBlocks.join('\n')
  if (!styles || /@import\b|url\s*\(|expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding|<\s*\/\s*style/i.test(styles)) {
    throw new UiMockupValidationError('Rendered styles contain unsupported content.', 'UNSAFE_STYLES')
  }
  const body = rendered.match(/<body(?:\s[^>]*)?>([\s\S]*?)<\/body>/i)?.[1]
  if (body == null) throw new UiMockupValidationError('WireMD did not return an HTML body.', 'MISSING_BODY')

  const cleanBody = sanitizeHtml(body, {
    allowedTags: [...UI_MOCKUP_ALLOWED_TAGS],
    allowedAttributes: {
      ...Object.fromEntries(
        Object.entries(UI_MOCKUP_ALLOWED_ATTRIBUTES).map(([tag, attributes]) => [
          tag,
          attributes.map((attribute) => attribute === 'viewbox' ? 'viewBox' : attribute)
        ])
      )
    },
    allowedClasses: {
      '*': ['icon', /^(?:wmd|icon|icons)-[a-z0-9-]+$/i]
    },
    allowedSchemes: [],
    allowedSchemesByTag: {},
    allowedSchemesAppliedToAttributes: ['href', 'src', 'cite'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'completelyDiscard',
    nonTextTags: ['script', 'style', 'xmp', 'iframe', 'object', 'embed', 'template', 'noscript', 'noembed', 'noframes'],
    // Keep explicitly allowlisted boolean state such as hidden/open/disabled.
    // URL-bearing attributes are absent from the allowlist regardless.
    nonBooleanAttributes: [],
    enforceHtmlBoundary: false,
    nestingLimit: 20,
    parser: { lowerCaseAttributeNames: false }
  })

  const fixedStyles = '.wmd-grid-1{--grid-columns:1}.wmd-grid-2{--grid-columns:2}.wmd-grid-3{--grid-columns:3}.wmd-grid-4{--grid-columns:4}html,body{margin:0;min-height:100%;overflow:auto;background:#f5f5f5}body{box-sizing:border-box;padding:16px}'
  const document = `${UI_MOCKUP_DOCUMENT_PREFIX}${styles}\n${fixedStyles}</style></head><body class="wmd-root wmd-clean">${cleanBody}</body></html>`
  if (document.length > MAX_MOCKUP_HTML) {
    throw new UiMockupValidationError('Sanitized mockup is too large.', 'HTML_TOO_LARGE')
  }
  if (!isSafeUiMockupHtml(document)) {
    throw new UiMockupValidationError('Sanitized mockup failed the canonical allowlist.', 'UNSAFE_RENDERED_HTML')
  }
  return document
}

export class WireMdMockupRenderer implements UiMockupRenderer {
  async render(source: string): Promise<{ html: string; source: string }> {
    validateWiremdSource(source)
    const ast = parse(source, { position: true, validate: true, strict: true })
    validateMockupCompactness(ast)
    const rendered = renderToHTML(ast, {
      style: 'clean',
      cursorSync: false,
      showComments: false
    })
    return { html: sanitizeWiremdHtml(rendered), source }
  }
}
