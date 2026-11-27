/**
 * PowerPoint (.pptx) → slides da aba Preview, sem LibreOffice e sem dependência nova: o zip abre com
 * XLSX.CFB (o SheetJS já está no projeto) e o XML do DrawingML passa por um parser mínimo (o main não tem DOMParser).
 * Sai: caixas (preenchimento, borda, texto com tamanho/cor/negrito/alinhamento), imagens, tabelas (texto das
 * células), linhas e conectores, em posição relativa ao slide. Grupos são achatados; placeholder sem posição herda
 * a do layout/mestre; as formas fixas do layout e do mestre (logo, faixas) entram por baixo. Gráfico, SmartArt e
 * imagem .emf/.wmf viram um marcador com o nome. A ordem vem de sldIdLst (o nome slideN.xml não garante ordem).
 */
import { promises as fs } from 'node:fs'
import * as XLSX from 'xlsx'
import { PREVIEW_LIMITS, type PreviewFileResult, type PreviewParagraph, type PreviewRun, type PreviewShape, type PreviewSlide, type PreviewTextBody } from '../../shared/preview'
// ── XML mínimo ──
export interface XNode { n: string; a: Record<string, string>; c: XNode[]; t: string }
const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] !== '#') return ENT[e] ?? m
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
  })
}
const TOKEN =
  /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|<(\/?)([\w:.-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
/** Árvore do XML (bem formado, como o do Office). Texto só importa em a:t. */
export function parseXml(xml: string): XNode {
  const root: XNode = { n: '', a: {}, c: [], t: '' }
  const stack = [root]
  for (const m of xml.matchAll(TOKEN)) {
    const top = stack[stack.length - 1]
    if (m[1] !== undefined) top.t += m[1]
    else if (m[3] && m[2]) {
      if (stack.length > 1) stack.pop()
    } else if (m[3]) {
      const a: Record<string, string> = {}
      for (const at of m[4].matchAll(ATTR)) a[at[1]] = decodeXml(at[2] ?? at[3] ?? '')
      const node: XNode = { n: m[3], a, c: [], t: '' }
      top.c.push(node)
      if (!m[5]) stack.push(node)
    } else if (m[6] !== undefined && stack.length > 1) top.t += decodeXml(m[6])
  }
  return root
}
const kid = (x: XNode | undefined, n: string): XNode | undefined => x?.c.find((k) => k.n === n)
const kids = (x: XNode | undefined, n: string): XNode[] => (x ? x.c.filter((k) => k.n === n) : [])
const at = (x: XNode | undefined, ...path: string[]): XNode | undefined => path.reduce<XNode | undefined>((acc, n) => kid(acc, n), x)
const num = (s: string | undefined, d = 0): number => (s !== undefined && s !== '' && Number.isFinite(Number(s)) ? Number(s) : d)
const clamp = (v: number): number => Math.min(1, Math.max(0, v))
const round = (v: number): number => Math.round(v * 1e5) / 1e5
/** Elemento raiz do documento (p:sld, p:sldLayout, p:sldMaster…). */
const rootOf = (doc: XNode | null): XNode | undefined => doc?.c.find((k) => k.n.includes(':'))
// ── Pacote (zip) ──
type Cfb = { FullPaths?: string[] }
const CFB = XLSX.CFB as unknown as { read(b: Buffer, o: { type: 'buffer' }): Cfb; find(c: Cfb, p: string): { content?: unknown } | null }
interface Rel { target: string; type: string; external: boolean }
/** Caminho de `target` relativo à pasta de `base` (ppt/slides/slide1.xml + ../media/a.png). */
function resolvePart(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = base.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}
class Pkg {
  private docs = new Map<string, XNode | null>()
  private relMaps = new Map<string, Map<string, Rel>>()
  constructor(private cfb: Cfb) {}
  bytes(part: string): Buffer | null {
    // O CFB só acha com a barra inicial ("/ppt/...").
    const c = CFB.find(this.cfb, '/' + part)?.content
    if (!c || typeof c !== 'object') return null
    return Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array)
  }
  doc(part: string): XNode | null {
    if (!this.docs.has(part)) {
      const b = this.bytes(part)
      this.docs.set(part, b ? parseXml(b.toString('utf8')) : null)
    }
    return this.docs.get(part) ?? null
  }
  rels(part: string): Map<string, Rel> {
    let map = this.relMaps.get(part)
    if (map) return map
    map = new Map()
    const slash = part.lastIndexOf('/')
    const doc = this.doc(`${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`)
    for (const r of kids(kid(doc ?? undefined, 'Relationships'), 'Relationship')) {
      const external = r.a.TargetMode === 'External'
      map.set(r.a.Id, { type: r.a.Type ?? '', external, target: external ? r.a.Target : resolvePart(part, r.a.Target ?? '') })
    }
    this.relMaps.set(part, map)
    return map
  }
  relOfType(part: string, suffix: string): string | undefined {
    for (const r of this.rels(part).values()) if (r.type.endsWith(suffix) && !r.external) return r.target
    return undefined
  }
}
// ── Cores e tema ──
interface Theme { colors: Record<string, string>; major: string; minor: string }
const PRESET: Record<string, string> = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080' }
const COLOR_EL = /^a:(srgbClr|schemeClr|sysClr|prstClr)$/
function toHsl(r: number, g: number, b: number): [number, number, number] {
  const [max, min] = [Math.max(r, g, b), Math.min(r, g, b)]
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h / 6, s, l]
}
function fromHsl(h: number, s: number, l: number): [number, number, number] {
  if (!s) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number): number => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t
    return u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p
  }
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)]
}
/** Aplica lumMod/lumOff/tint/shade (o jeito do Office de clarear/escurecer a cor do tema). */
function adjust(hex: string, c: XNode): string {
  const v = (n: string): number | undefined => (kid(c, n) ? num(kid(c, n)?.a.val) / 100000 : undefined)
  let rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
  const [shade, tint, lumMod, lumOff, a = 1] = [v('a:shade'), v('a:tint'), v('a:lumMod'), v('a:lumOff'), v('a:alpha')]
  if (shade !== undefined) rgb = rgb.map((x) => x * shade) as typeof rgb
  if (tint !== undefined) rgb = rgb.map((x) => x + (1 - x) * (1 - tint)) as typeof rgb
  if (lumMod !== undefined || lumOff !== undefined) {
    const [h, s, l] = toHsl(...rgb)
    rgb = fromHsl(h, s, clamp(l * (lumMod ?? 1) + (lumOff ?? 0)))
  }
  return '#' + [...rgb, ...(a < 1 ? [a] : [])].map((x) => Math.round(clamp(x) * 255).toString(16).padStart(2, '0')).join('') // a < 1: #rrggbbaa
}
function readTheme(pkg: Pkg, part: string | undefined): Theme {
  const els = at(rootOf(part ? pkg.doc(part) : null), 'a:themeElements')
  const colors: Record<string, string> = {}
  for (const c of at(els, 'a:clrScheme')?.c ?? []) {
    const v = c.c[0]
    const hex = v?.n === 'a:srgbClr' ? v.a.val : v?.n === 'a:sysClr' ? v.a.lastClr : undefined
    if (hex) colors[c.n.replace(/^a:/, '')] = hex
  }
  const font = (k: string): string => at(els, 'a:fontScheme', k, 'a:latin')?.a.typeface ?? ''
  return { colors, major: font('a:majorFont'), minor: font('a:minorFont') }
}
// ── Camadas (mestre/layout) e placeholders ──
interface Box { x: number; y: number; w: number; h: number; rot?: number; flipH?: boolean; flipV?: boolean }
interface Ph { type: string; idx?: string; box?: Box; lst?: XNode; body?: XNode }
interface Layer { part: string; root: XNode; phs: Ph[] }
interface Master extends Layer { theme: Theme; map: Record<string, string>; styles: Record<'title' | 'body' | 'other', XNode | undefined> }
function xfrmBox(x: XNode | undefined): Box | undefined {
  const [off, ext] = [kid(x, 'a:off'), kid(x, 'a:ext')]
  if (!off || !ext) return undefined
  const box: Box = { x: num(off.a.x), y: num(off.a.y), w: num(ext.a.cx), h: num(ext.a.cy) }
  if (x?.a.rot) box.rot = num(x.a.rot) / 60000
  return { ...box, ...(x?.a.flipH === '1' ? { flipH: true } : {}), ...(x?.a.flipV === '1' ? { flipV: true } : {}) }
}
/** O p:ph da forma (placeholder), se for um. */
const phOf = (shape: XNode): XNode | undefined => at(shape.c.find((k) => k.n.startsWith('p:nv')), 'p:nvPr', 'p:ph')
function readPhs(root: XNode): Ph[] {
  const out: Ph[] = []
  for (const k of at(root, 'p:cSld', 'p:spTree')?.c ?? []) {
    const ph = phOf(k)
    if (!ph) continue
    const tx = kid(k, 'p:txBody')
    const box = xfrmBox(kid(kid(k, 'p:spPr'), 'a:xfrm') ?? kid(k, 'p:xfrm'))
    out.push({ type: ph.a.type ?? 'body', idx: ph.a.idx, box, lst: kid(tx, 'a:lstStyle'), body: kid(tx, 'a:bodyPr') })
  }
  return out
}
/** ctrTitle conta como title; subTitle/obj/sem tipo, como body (é o que o mestre tem). */
const phFamily = (t: string): string => (t === 'ctrTitle' ? 'title' : ['subTitle', 'obj', 'body'].includes(t) ? 'body' : t)
function findPh(phs: Ph[] | undefined, ph: XNode, byIdx: boolean): Ph | undefined {
  if (!phs) return undefined
  const type = ph.a.type ?? 'body'
  return (
    (byIdx && ph.a.idx !== undefined ? phs.find((p) => p.idx === ph.a.idx) : undefined) ??
    phs.find((p) => p.type === type) ??
    phs.find((p) => phFamily(p.type) === phFamily(type))
  )
}
// ── Imagens e contexto ──
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp' }
class Images {
  map: Record<string, string> = {}
  private keys = new Map<string, string>()
  private bytes = 0
  /** Chave da imagem em `map`, ou o rótulo do marcador quando não dá para mostrar. */
  add(pkg: Pkg, part: string, rid: string | undefined): { key: string } | { label: string } {
    const rel = rid ? pkg.rels(part).get(rid) : undefined
    if (!rel) return { label: 'Imagem' }
    if (rel.external) return { label: 'Imagem externa' }
    const known = this.keys.get(rel.target)
    if (known) return { key: known }
    const ext = rel.target.split('.').pop()?.toLowerCase() ?? ''
    if (!MIME[ext]) return { label: `Imagem .${ext}` }
    const buf = pkg.bytes(rel.target)
    if (!buf) return { label: 'Imagem' }
    if (this.bytes + buf.length > PREVIEW_LIMITS.pptxImageBytes) return { label: 'Imagem omitida (limite do preview)' }
    this.bytes += buf.length
    const key = `img${this.keys.size + 1}`
    this.keys.set(rel.target, key)
    this.map[key] = `data:${MIME[ext]};base64,${buf.toString('base64')}`
    return { key }
  }
}
/** `skipPh`: formas do layout/mestre (os placeholders ficam de fora, o slide traz os dele). */
interface Ctx { pkg: Pkg; part: string; W: number; H: number; images: Images; skipPh: boolean; master?: Master; layout?: Layer; defaultStyle?: XNode }
function colorOf(holder: XNode | undefined, cx: Ctx): string | undefined {
  const c = holder?.c.find((k) => COLOR_EL.test(k.n))
  if (!c) return undefined
  const [theme, map] = [cx.master?.theme.colors ?? {}, cx.master?.map ?? {}]
  const hex =
    c.n === 'a:srgbClr' ? c.a.val
    : c.n === 'a:sysClr' ? (c.a.lastClr ?? (c.a.val === 'window' ? 'FFFFFF' : '000000'))
    : c.n === 'a:prstClr' ? PRESET[c.a.val]
    : theme[map[c.a.val] ?? c.a.val]
  return hex && /^[0-9a-f]{6}$/i.test(hex) ? adjust(hex, c) : undefined
}
/** Cor de um preenchimento (sólido, 1ª parada do degradê, padrão); null = sem preenchimento declarado. */
function fillIn(parent: XNode | undefined, cx: Ctx): string | undefined | null {
  for (const k of parent?.c ?? []) {
    if (k.n === 'a:noFill') return undefined
    if (k.n === 'a:solidFill') return colorOf(k, cx)
    if (k.n === 'a:gradFill') return colorOf(at(k, 'a:gsLst', 'a:gs'), cx)
    if (k.n === 'a:pattFill') return colorOf(kid(k, 'a:fgClr'), cx)
  }
  return null
}
const refColor = (ref: XNode | undefined, cx: Ctx): string | undefined => (ref && ref.a.idx !== '0' ? colorOf(ref, cx) : undefined)
const TX1: XNode = { n: '', a: {}, c: [{ n: 'a:schemeClr', a: { val: 'tx1' }, c: [], t: '' }], t: '' }
function lineOf(spPr: XNode | undefined, style: XNode | undefined, cx: Ctx): { line: string; lineW: number } | undefined {
  const ln = kid(spPr, 'a:ln')
  const declared = fillIn(ln, cx)
  const color = declared === null ? refColor(kid(style, 'a:lnRef'), cx) : declared
  return color ? { line: color, lineW: round(Math.max(num(ln?.a.w, 12700), 6350) / cx.W) } : undefined
}
// ── Texto ──
const ALIGN: Record<string, PreviewParagraph['align']> = { l: 'left', ctr: 'center', r: 'right', just: 'justify', dist: 'justify' }
const ANCHOR: Record<string, PreviewTextBody['anchor']> = { t: 'top', ctr: 'middle', b: 'bottom' }
const isRun = (k: XNode): boolean => k.n === 'a:r' || k.n === 'a:fld'
const textOf = (p: XNode): string => p.c.map((k) => (isRun(k) ? (kid(k, 'a:t')?.t ?? '') : k.n === 'a:br' ? '\n' : '')).join('')
/**
 * Cadeia de estilo (do mais perto ao mais longe): pPr/rPr do parágrafo, lstStyle da forma, do placeholder do layout,
 * do placeholder do mestre e txStyles do mestre (ou defaultTextStyle da apresentação, fora de placeholder).
 */
function textBody(tx: XNode | undefined, ph: XNode | undefined, cx: Ctx, fontColor: string | undefined): PreviewTextBody | undefined {
  const paras = kids(tx, 'a:p')
  if (!paras.some((p) => textOf(p).trim())) return undefined
  const lph = ph ? findPh(cx.layout?.phs, ph, true) : undefined
  const mph = ph ? findPh(cx.master?.phs, ph, false) : undefined
  const fam = ph ? phFamily(ph.a.type ?? 'body') : ''
  const style = ph ? cx.master?.styles[fam === 'title' || fam === 'body' ? fam : 'other'] : cx.defaultStyle
  const bodies = [kid(tx, 'a:bodyPr'), lph?.body, mph?.body]
  const bodyAttr = (k: string): string | undefined => bodies.find((b) => b?.a[k] !== undefined)?.a[k]
  const fit = kid(bodies[0], 'a:normAutofit')
  const [scale, lnCut] = [num(fit?.a.fontScale, 100000) / 100000, num(fit?.a.lnSpcReduction) / 100000]
  const theme = cx.master?.theme
  const fallbackColor = fontColor ?? colorOf(TX1, cx)
  const lists = [kid(tx, 'a:lstStyle'), lph?.lst, mph?.lst, style]
  let autoNum = 0
  const paragraphs = paras.map((p): PreviewParagraph => {
    const pPr = kid(p, 'a:pPr')
    const level = Math.min(8, num(pPr?.a.lvl))
    const levels = [pPr, ...lists.map((l) => kid(l, `a:lvl${level + 1}pPr`))]
    const runStyle = (rPr: XNode | undefined): Omit<PreviewRun, 'text'> => {
      const chain = [rPr, ...levels.map((l) => kid(l, 'a:defRPr'))]
      const pick = (k: string): string | undefined => chain.find((n) => n?.a[k] !== undefined)?.a[k]
      const r: Omit<PreviewRun, 'text'> = { size: round((num(pick('sz'), 1800) / 100) * scale) }
      if (pick('b') === '1' || pick('b') === 'true') r.bold = true
      if (pick('i') === '1' || pick('i') === 'true') r.italic = true
      if ((pick('u') ?? 'none') !== 'none') r.underline = true
      if (num(pick('spc'))) r.spacing = round(num(pick('spc')) / 100)
      const color = chain.map((n) => colorOf(kid(n, 'a:solidFill'), cx)).find(Boolean) ?? fallbackColor
      if (color) r.color = color
      const face = chain.map((n) => kid(n, 'a:latin')?.a.typeface).find(Boolean)
      const font = face === '+mj-lt' ? theme?.major : face === '+mn-lt' ? theme?.minor : face
      if (font) r.font = font
      return r
    }
    const runs: PreviewRun[] = []
    for (const k of p.c) {
      if (isRun(k)) runs.push({ text: kid(k, 'a:t')?.t ?? '', ...runStyle(kid(k, 'a:rPr')) })
      else if (k.n === 'a:br') runs.push({ text: '\n', ...runStyle(kid(k, 'a:rPr')) })
    }
    const out: PreviewParagraph = { runs }
    const algn = levels.find((l) => l?.a.algn)?.a.algn
    if (algn && ALIGN[algn] && algn !== 'l') out.align = ALIGN[algn]
    if (level) out.level = level
    const bu = levels.map((l) => l?.c.find((k) => /^a:bu(None|Char|AutoNum)$/.test(k.n))).find(Boolean)
    if (runs.length && bu?.n === 'a:buChar') out.bullet = bu.a.char || '•'
    else if (runs.length && bu?.n === 'a:buAutoNum') out.bullet = `${num(bu.a.startAt, 1) + autoNum++}.`
    if (!runs.length) out.size = runStyle(kid(p, 'a:endParaRPr')).size
    // Espaçamento: spcPct em milésimos de % (do espaçamento simples, 1,2 × fonte) ou spcPts em centésimos de pt.
    const space = (k: string): { pct: number } | { pt: number } | undefined => {
      const el = levels.map((l) => kid(l, k)).find(Boolean)
      const [pct, pts] = [num(kid(el, 'a:spcPct')?.a.val), num(kid(el, 'a:spcPts')?.a.val)]
      return pct > 0 ? { pct: pct / 100000 } : pts > 0 ? { pt: pts / 100 } : undefined
    }
    const ln = space('a:lnSpc')
    if (ln && 'pct' in ln) out.lineH = round(Math.max(0.3, ln.pct - lnCut))
    else if (ln) out.linePt = round(ln.pt)
    else if (lnCut) out.lineH = round(1 - lnCut)
    const em = (out.size ?? runs[0]?.size ?? 18) * 1.2
    const toPt = (s: ReturnType<typeof space>): number => (!s ? 0 : round('pt' in s ? s.pt : s.pct * em))
    if (toPt(space('a:spcBef'))) out.before = toPt(space('a:spcBef'))
    if (toPt(space('a:spcAft'))) out.after = toPt(space('a:spcAft'))
    return out
  })
  const ins = (k: string, d: number): number => round(num(bodyAttr(k), d) / cx.W)
  const pad: PreviewTextBody['pad'] = [ins('tIns', 45720), ins('rIns', 91440), ins('bIns', 45720), ins('lIns', 91440)]
  const body: PreviewTextBody = { paragraphs, anchor: ANCHOR[bodyAttr('anchor') ?? 't'] ?? 'top', pad }
  // Ajuste automático: vale o primeiro bodyPr (forma, layout, mestre) que diz qual é; só normAutofit encolhe a fonte.
  const auto = bodies.map((b) => ['a:normAutofit', 'a:noAutofit', 'a:spAutoFit'].find((k) => kid(b, k))).find(Boolean) === 'a:normAutofit'
  return { ...body, ...(bodyAttr('wrap') === 'none' ? { noWrap: true } : {}), ...(auto ? { autofit: true } : {}) }
}
// ── Formas ──
type Xf = (b: Box) => Box

function rel(b: Box, cx: Ctx): Pick<PreviewShape, 'x' | 'y' | 'w' | 'h' | 'rot'> {
  const out = { x: round(b.x / cx.W), y: round(b.y / cx.H), w: round(b.w / cx.W), h: round(b.h / cx.H) }
  return b.rot ? { ...out, rot: round(b.rot) } : out
}

const flips = (b: Box): { flipH?: true; flipV?: true } => ({ ...(b.flipH ? { flipH: true } : {}), ...(b.flipV ? { flipV: true } : {}) })
/** Posição própria (passando pela transformação do grupo) ou a do placeholder herdado. */
function boxFor(shape: XNode, xfrm: XNode | undefined, cx: Ctx, xf: Xf): Box | undefined {
  const own = xfrmBox(xfrm)
  if (own) return xf(own)
  const ph = phOf(shape)
  return ph ? (findPh(cx.layout?.phs, ph, true)?.box ?? findPh(cx.master?.phs, ph, false)?.box) : undefined
}

function picture(box: Box, blip: XNode | undefined, cx: Ctx): PreviewShape {
  const img = cx.images.add(cx.pkg, cx.part, blip?.a['r:embed'])
  if ('label' in img) return { type: 'missing', label: img.label, ...rel(box, cx) }
  return { type: 'image', image: img.key, ...rel(box, cx), ...flips(box) }
}

function sp(k: XNode, cx: Ctx, xf: Xf, out: PreviewShape[]): void {
  const ph = phOf(k)
  if (ph && cx.skipPh) return
  const spPr = kid(k, 'p:spPr')
  const box = boxFor(k, kid(spPr, 'a:xfrm'), cx, xf)
  if (!box) return
  const style = kid(k, 'p:style')
  const prst = kid(spPr, 'a:prstGeom')?.a.prst ?? 'rect'
  const ln = lineOf(spPr, style, cx)
  if (k.n === 'p:cxnSp' || prst === 'line' || prst.startsWith('straightConnector')) {
    if (ln) out.push({ type: 'line', ...ln, ...rel(box, cx), ...flips(box) })
    return
  }
  const blipFill = kid(spPr, 'a:blipFill')
  if (blipFill) out.push(picture(box, kid(blipFill, 'a:blip'), cx))
  const declared = fillIn(spPr, cx)
  const fill = blipFill ? undefined : declared === null ? (ph ? undefined : refColor(kid(style, 'a:fillRef'), cx)) : declared
  const text = textBody(kid(k, 'p:txBody'), ph, cx, refColor(kid(style, 'a:fontRef'), cx))
  if (!fill && !ln && !text) return
  const geom = prst === 'ellipse' ? 'ellipse' : prst.startsWith('round') ? 'round' : undefined
  out.push({ type: 'box', ...rel(box, cx), ...(fill ? { fill } : {}), ...ln, ...(geom ? { geom } : {}), ...(text ? { text } : {}) })
}

const [MAX_ROWS, MAX_COLS] = [60, 20] // tabela: só texto, até 60 × 20

function frame(k: XNode, cx: Ctx, xf: Xf, out: PreviewShape[]): void {
  if (phOf(k) && cx.skipPh) return
  const box = boxFor(k, kid(k, 'p:xfrm'), cx, xf)
  if (!box) return
  const gd = at(k, 'a:graphic', 'a:graphicData')
  const tbl = kid(gd, 'a:tbl')
  if (!tbl) {
    const uri = gd?.a.uri ?? ''
    const label = /chart/i.test(uri) ? 'Gráfico' : /diagram/i.test(uri) ? 'Diagrama (SmartArt)' : 'Objeto incorporado'
    out.push({ type: 'missing', label, ...rel(box, cx) })
    return
  }
  const cells = kids(tbl, 'a:tr').slice(0, MAX_ROWS).map((tr) => kids(tr, 'a:tc').slice(0, MAX_COLS))
  const rows = cells.map((r) => r.map((tc) => kids(kid(tc, 'a:txBody'), 'a:p').map(textOf).join('\n')))
  const rPr = cells.flat().map((tc) => at(tc, 'a:txBody', 'a:p', 'a:r', 'a:rPr')).find(Boolean)
  const color = colorOf(kid(rPr, 'a:solidFill'), cx)
  out.push({ type: 'table', rows, ...rel(box, cx), ...(rPr?.a.sz ? { size: num(rPr.a.sz) / 100 } : {}), ...(color ? { color } : {}) })
}

/** Filhos do grupo vêm no espaço chOff/chExt dele: a transformação os leva para off/ext. */
function groupXf(g: XNode | undefined, xf: Xf): Xf | undefined {
  const [off, chOff, chExt] = [xfrmBox(g), kid(g, 'a:chOff'), kid(g, 'a:chExt')]
  if (!off || !chOff || !chExt) return undefined
  const sx = num(chExt.a.cx) ? off.w / num(chExt.a.cx) : 1
  const sy = num(chExt.a.cy) ? off.h / num(chExt.a.cy) : 1
  const [ox, oy] = [num(chOff.a.x), num(chOff.a.y)]
  return (b) => xf({ ...b, x: off.x + (b.x - ox) * sx, y: off.y + (b.y - oy) * sy, w: b.w * sx, h: b.h * sy })
}

function walk(tree: XNode | undefined, cx: Ctx, xf: Xf, out: PreviewShape[]): void {
  for (const k of tree?.c ?? []) {
    if (k.n === 'p:sp' || k.n === 'p:cxnSp') sp(k, cx, xf, out)
    else if (k.n === 'p:graphicFrame') frame(k, cx, xf, out)
    else if (k.n === 'mc:AlternateContent') walk(kid(k, 'mc:Fallback') ?? kid(k, 'mc:Choice'), cx, xf, out)
    else if (k.n === 'p:grpSp') walk(k, cx, groupXf(at(k, 'p:grpSpPr', 'a:xfrm'), xf) ?? xf, out)
    else if (k.n === 'p:pic' && !(phOf(k) && cx.skipPh)) {
      const box = boxFor(k, at(k, 'p:spPr', 'a:xfrm'), cx, xf)
      if (box) out.push(picture(box, at(k, 'p:blipFill', 'a:blip'), cx))
    }
  }
}
// ── Slides ──
type Bg = Pick<PreviewSlide, 'background' | 'backgroundImage'>

function background(root: XNode | undefined, cx: Ctx, part: string): Bg | undefined {
  const bg = at(root, 'p:cSld', 'p:bg')
  if (!bg) return undefined
  const bgPr = kid(bg, 'p:bgPr')
  const blip = at(bgPr, 'a:blipFill', 'a:blip')
  const img = blip ? cx.images.add(cx.pkg, part, blip.a['r:embed']) : undefined
  if (img && 'key' in img) return { backgroundImage: img.key }
  const color = bgPr ? fillIn(bgPr, cx) : colorOf(kid(bg, 'p:bgRef'), cx)
  return color ? { background: color } : undefined
}

function notesOf(pkg: Pkg, part: string): string | undefined {
  const np = pkg.relOfType(part, '/notesSlide')
  const tree = at(rootOf(np ? pkg.doc(np) : null), 'p:cSld', 'p:spTree')
  const body = tree?.c.find((k) => k.n === 'p:sp' && phOf(k)?.a.type === 'body')
  return kids(kid(body, 'p:txBody'), 'a:p').map(textOf).join('\n').trim() || undefined
}

function loadMaster(pkg: Pkg, part: string): Master | undefined {
  const root = rootOf(pkg.doc(part))
  if (!root) return undefined
  const tx = kid(root, 'p:txStyles')
  const theme = readTheme(pkg, pkg.relOfType(part, '/theme'))
  const map = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2', ...(kid(root, 'p:clrMap')?.a ?? {}) }
  const styles = { title: kid(tx, 'p:titleStyle'), body: kid(tx, 'p:bodyStyle'), other: kid(tx, 'p:otherStyle') }
  return { part, root, phs: readPhs(root), theme, map, styles }
}

/** Mesmo valor para a mesma chave (layout e mestre são compartilhados entre slides). */
function cached<T>(make: (k: string) => T | undefined): (k: string | undefined) => T | undefined {
  const memo = new Map<string, T | undefined>()
  return (k) => (!k ? undefined : memo.has(k) ? memo.get(k) : memo.set(k, make(k)).get(k))
}

export interface Deck { width: number; height: number; slides: PreviewSlide[]; images: Record<string, string>; truncated: boolean }
/** Desmonta o pptx. null = não é um pptx (sem zip ou sem ppt/presentation.xml). */
export function pptxToDeck(buf: Buffer): Deck | null {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) return null
  const pkg = new Pkg(CFB.read(buf, { type: 'buffer' }))
  const pres = rootOf(pkg.doc('ppt/presentation.xml'))
  if (pres?.n !== 'p:presentation') return null
  const sz = kid(pres, 'p:sldSz')
  const W = num(sz?.a.cx) > 0 ? num(sz?.a.cx) : 9144000
  const H = num(sz?.a.cy) > 0 ? num(sz?.a.cy) : 6858000
  const presRels = pkg.rels('ppt/presentation.xml')
  const parts = kids(kid(pres, 'p:sldIdLst'), 'p:sldId').map((s) => presRels.get(s.a['r:id'])?.target).filter((p): p is string => !!p)
  const images = new Images()
  const masterOf = cached((p) => loadMaster(pkg, p))
  const layoutOf = cached<Layer>((p) => {
    const root = rootOf(pkg.doc(p))
    return root && { part: p, root, phs: readPhs(root) }
  })
  const defaultStyle = kid(pres, 'p:defaultTextStyle')
  const id: Xf = (b) => b
  const slides = parts.slice(0, PREVIEW_LIMITS.pptxSlides).map((part): PreviewSlide => {
    const root = rootOf(pkg.doc(part))
    const layout = layoutOf(pkg.relOfType(part, '/slideLayout'))
    const master = masterOf(layout && pkg.relOfType(layout.part, '/slideMaster'))
    const base = { pkg, W, H, images, master, layout, defaultStyle }
    const shapes: PreviewShape[] = []
    // showMasterSp="0" no slide esconde layout e mestre; no layout, só o mestre.
    const showMaster = root?.a.showMasterSp !== '0'
    if (master && showMaster && layout?.root.a.showMasterSp !== '0') {
      walk(at(master.root, 'p:cSld', 'p:spTree'), { ...base, part: master.part, skipPh: true }, id, shapes)
    }
    if (layout && showMaster) walk(at(layout.root, 'p:cSld', 'p:spTree'), { ...base, part: layout.part, skipPh: true }, id, shapes)
    const cx: Ctx = { ...base, part, skipPh: false }
    walk(at(root, 'p:cSld', 'p:spTree'), cx, id, shapes)
    const bg = background(root, cx, part) ?? (layout && background(layout.root, cx, layout.part)) ?? (master && background(master.root, cx, master.part))
    const notes = notesOf(pkg, part)
    return { shapes, ...bg, ...(notes ? { notes } : {}), ...(root?.a.show === '0' ? { hidden: true } : {}) }
  })
  return { width: W, height: H, slides, images: images.map, truncated: parts.length > PREVIEW_LIMITS.pptxSlides }
}

/** `path` é o pedido (volta na resposta); `real` é o que se lê (já passou pela barreira). */
export async function readPptx(path: string, real: string, size: number): Promise<PreviewFileResult> {
  const mb = (b: number): number => Math.round(b / (1024 * 1024))
  if (size > PREVIEW_LIMITS.pptxFileBytes) {
    const message = `Apresentação grande demais para o preview (${mb(size)} MB; o limite é ${mb(PREVIEW_LIMITS.pptxFileBytes)} MB).`
    return { ok: false, path, reason: 'too-big', message }
  }
  const deck = pptxToDeck(await fs.readFile(real))
  if (!deck) return { ok: false, path, reason: 'unsupported', message: 'O arquivo não parece um PowerPoint (.pptx) válido.' }
  if (!deck.slides.length) return { ok: false, path, reason: 'unsupported', message: 'A apresentação não tem nenhum slide.' }
  return { ok: true, kind: 'slides', path, ...deck }
}
