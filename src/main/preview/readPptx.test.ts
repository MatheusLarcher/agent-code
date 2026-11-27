// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as XLSX from 'xlsx'
import { afterAll, describe, expect, it } from 'vitest'
import { PREVIEW_LIMITS, type PreviewShape } from '../../shared/preview'
import { decodeXml, parseXml, pptxToDeck, readPptx } from './readPptx'

// ── Montagem de um .pptx mínimo com o próprio CFB do SheetJS ──

type Zip = object
const CFB = XLSX.CFB as unknown as {
  utils: { cfb_new(o: { type: 'zip' }): Zip; cfb_add(c: Zip, p: string, b: Buffer): void }
  write(c: Zip, o: { type: 'buffer'; fileType: 'zip' }): Buffer
}

function zip(files: Record<string, string | Buffer>): Buffer {
  const c = CFB.utils.cfb_new({ type: 'zip' })
  for (const [p, v] of Object.entries(files)) CFB.utils.cfb_add(c, '/' + p, Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8'))
  return Buffer.from(CFB.write(c, { type: 'buffer', fileType: 'zip' }))
}

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
const rels = (list: [string, string, string][]): string =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${RT}${type}" Target="${target}"/>`).join('') +
  '</Relationships>'
const xfrm = (x: number, y: number, w: number, h: number): string => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`
const nv = (tag: string, ph = ''): string => `<p:nv${tag}Pr><p:cNvPr id="1" name="s"/><p:cNv${tag}Pr/><p:nvPr>${ph}</p:nvPr></p:nv${tag}Pr>`
const shape = (spPr: string, body = '', ph = ''): string => `<p:sp>${nv('Sp', ph)}<p:spPr>${spPr}</p:spPr>${body}</p:sp>`
const txt = (t: string): string => `<p:txBody><a:bodyPr/><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody>`
const fill = (clr: string): string => `<a:solidFill>${clr}</a:solidFill>`
const pic = (x: number): string =>
  `<p:pic>${nv('Pic')}<p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr>${xfrm(x, 0, 100, 100)}</p:spPr></p:pic>`
const sld = (attrs: string, tree: string): string => `<p:sld ${NS} ${attrs}><p:cSld><p:spTree>${tree}</p:spTree></p:cSld></p:sld>`
const W = 12192000
const H = 6858000

const theme =
  `<a:theme ${NS}><a:themeElements><a:clrScheme name="c"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>` +
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme>' +
  '<a:fontScheme name="f"><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont>' +
  '</a:fontScheme></a:themeElements></a:theme>'

const master =
  `<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr>${fill('<a:srgbClr val="112233"/>')}</p:bgPr></p:bg><p:spTree>` +
  shape(xfrm(100000, 200000, 1000000, 500000), txt('Título do mestre'), '<p:ph type="title"/>') +
  shape(xfrm(0, 0, 50000, 50000) + fill('<a:schemeClr val="accent1"/>')) +
  '</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1"/>' +
  '<p:txStyles><p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4400"><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>' +
  '<p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>'

const table =
  `<p:graphicFrame>${nv('GraphicFrame')}<p:xfrm><a:off x="0" y="${H / 2}"/><a:ext cx="${W / 2}" cy="${H / 4}"/></p:xfrm>` +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>' +
  '<a:tr><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1200"/><a:t>A</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>B</a:t></a:r></a:p></a:txBody></a:tc></a:tr>' +
  '<a:tr><a:tc><a:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p/></a:txBody></a:tc></a:tr>' +
  '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
const chart =
  `<p:graphicFrame>${nv('GraphicFrame')}<p:xfrm><a:off x="0" y="0"/><a:ext cx="${W}" cy="${H}"/></p:xfrm>` +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></p:graphicFrame>'
const group =
  `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm>` +
  '<a:off x="1000000" y="1000000"/><a:ext cx="2000000" cy="2000000"/><a:chOff x="0" y="0"/><a:chExt cx="1000000" cy="1000000"/></a:xfrm></p:grpSpPr>' +
  shape(xfrm(500000, 500000, 100000, 100000) + fill('<a:srgbClr val="00FF00"/>')) +
  '</p:grpSp>'

const slideA = sld(
  '',
  shape('', txt('Olá &amp; até &#x2192; fim'), '<p:ph type="title"/>') +
    shape(xfrm(W / 4, H / 4, W / 2, H / 2) + fill('<a:srgbClr val="FF0000"/>') + '<a:ln w="25400">' + fill('<a:schemeClr val="accent1"/>') + '</a:ln>') +
    shape('<a:xfrm rot="5400000"><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="ellipse"/>' + fill('<a:srgbClr val="FFFFFF"><a:lumMod val="50000"/><a:alpha val="9000"/></a:srgbClr>')) +
    pic(0) + pic(200) + chart + group + table
)
const slideB = sld('show="0" showMasterSp="0"', shape(xfrm(0, 0, W, H), txt('Escondido')))

const notes =
  `<p:notes ${NS}><p:cSld><p:spTree>${shape('', txt('Fale devagar'), '<p:ph type="body" idx="1"/>')}</p:spTree></p:cSld></p:notes>`

function deckFiles(extra: Record<string, string | Buffer> = {}): Record<string, string | Buffer> {
  return {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'ppt/presentation.xml':
      `<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst>` +
      `<p:sldSz cx="${W}" cy="${H}"/></p:presentation>`,
    // A ordem vem do sldIdLst: slide11 (rId2) antes de slide10 (rId1).
    'ppt/_rels/presentation.xml.rels': rels([['rId1', 'slide', 'slides/slide10.xml'], ['rId2', 'slide', 'slides/slide11.xml']]),
    'ppt/slides/slide11.xml': slideA,
    'ppt/slides/_rels/slide11.xml.rels': rels([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'image', '../media/a.png'],
      ['rId3', 'notesSlide', '../notesSlides/notesSlide1.xml']
    ]),
    'ppt/slides/slide10.xml': slideB,
    'ppt/slides/_rels/slide10.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
    'ppt/notesSlides/notesSlide1.xml': notes,
    'ppt/media/a.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout ${NS}><p:cSld><p:spTree/></p:cSld></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    'ppt/slideMasters/slideMaster1.xml': master,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([['rId1', 'theme', '../theme/theme1.xml']]),
    'ppt/theme/theme1.xml': theme,
    ...extra
  }
}

const near = (v: number): number => Math.round(v * 1e5) / 1e5

// ── Testes ──

describe('parseXml / decodeXml', () => {
  it('decodifica entidades nomeadas e numéricas e ignora declaração, comentário e CDATA vira texto', () => {
    expect(decodeXml('a &amp; b &lt;c&gt; &#233; &#x2192; &nada;')).toBe('a & b <c> é → &nada;')
    const root = parseXml('<?xml version="1.0"?><!-- x --><a:t k="1 &quot;2&quot;">x &amp; y<![CDATA[<z>]]></a:t><b/>')
    expect(root.c.map((n) => n.n)).toEqual(['a:t', 'b'])
    expect(root.c[0]).toMatchObject({ a: { k: '1 "2"' }, t: 'x & y<z>' })
  })
})

describe('pptxToDeck', () => {
  const deck = pptxToDeck(zip(deckFiles()))

  it('ordem pelo sldIdLst, tamanho do slide, oculto, anotações e fundo herdado do mestre', () => {
    expect(deck).not.toBeNull()
    expect(deck).toMatchObject({ width: W, height: H, truncated: false })
    const [a, b] = deck!.slides
    expect(deck!.slides).toHaveLength(2)
    expect(a).toMatchObject({ background: '#112233', notes: 'Fale devagar' })
    expect(a.hidden).toBeUndefined()
    expect(b).toMatchObject({ hidden: true, background: '#112233' })
    // showMasterSp="0": a forma fixa do mestre não entra.
    expect(b.shapes).toHaveLength(1)
    expect(b.shapes[0]).toMatchObject({ type: 'box', x: 0, y: 0, w: 1, h: 1 })
  })

  it('forma fixa do mestre por baixo; placeholder herda posição e estilo do mestre', () => {
    const [fixed, title] = deck!.slides[0].shapes
    expect(fixed).toMatchObject({ type: 'box', fill: '#4472c4' })
    expect(title).toMatchObject({ type: 'box', x: near(100000 / W), y: near(200000 / H), w: near(1000000 / W), h: near(500000 / H) })
    const p = (title as Extract<PreviewShape, { type: 'box' }>).text!.paragraphs[0]
    expect(p.align).toBe('center')
    expect(p.runs).toEqual([{ text: 'Olá & até → fim', size: 44, color: '#000000', font: 'Calibri Light' }])
  })

  it('preenchimento, borda, elipse girada, lumMod e transparência', () => {
    const [, , rect, ell] = deck!.slides[0].shapes
    expect(rect).toEqual({ type: 'box', x: 0.25, y: 0.25, w: 0.5, h: 0.5, fill: '#ff0000', line: '#4472c4', lineW: near(25400 / W) })
    // alpha 9% vira #rrggbbaa (17 = 0,09 × 255): sem isso a camada cobria o slide.
    expect(ell).toMatchObject({ type: 'box', geom: 'ellipse', rot: 90, fill: '#80808017' })
  })

  it('a mesma imagem vira uma chave só; gráfico vira marcador; grupo é achatado; tabela traz o texto', () => {
    const shapes = deck!.slides[0].shapes.slice(4)
    expect(shapes[0]).toMatchObject({ type: 'image', image: 'img1' })
    expect(shapes[1]).toMatchObject({ type: 'image', image: 'img1' })
    expect(Object.keys(deck!.images)).toEqual(['img1'])
    expect(deck!.images.img1).toBe('data:image/png;base64,iVBORw==')
    expect(shapes[2]).toEqual({ type: 'missing', label: 'Gráfico', x: 0, y: 0, w: 1, h: 1 })
    expect(shapes[3]).toMatchObject({ type: 'box', fill: '#00ff00', x: near(2000000 / W), y: near(2000000 / H), w: near(200000 / W) })
    expect(shapes[4]).toEqual({ type: 'table', rows: [['A', 'B'], ['1', '']], size: 12, x: 0, y: 0.5, w: 0.5, h: 0.25 })
  })

  it('imagem em formato que o Chromium não mostra vira marcador com a extensão', () => {
    const files = deckFiles({
      'ppt/slides/_rels/slide11.xml.rels': rels([
        ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
        ['rId2', 'image', '../media/a.emf']
      ]),
      'ppt/media/a.emf': Buffer.from([1, 2, 3])
    })
    const d = pptxToDeck(zip(files))!
    expect(d.slides[0].shapes.filter((s) => s.type === 'missing').map((s) => (s as { label: string }).label)).toEqual(['Imagem .emf', 'Imagem .emf', 'Gráfico'])
    expect(d.images).toEqual({})
  })

  it('entrelinha, espaço antes/depois, espaçamento entre letras, margens internas e wrap="none"', () => {
    const body =
      '<p:txBody><a:bodyPr wrap="none" lIns="25400" rIns="25400"><a:normAutofit lnSpcReduction="10000"/></a:bodyPr><a:lstStyle/>' +
      '<a:p><a:pPr><a:lnSpc><a:spcPct val="85669"/></a:lnSpc><a:spcBef><a:spcPts val="600"/></a:spcBef><a:spcAft><a:spcPct val="50000"/></a:spcAft></a:pPr>' +
      '<a:r><a:rPr sz="4200" b="1" spc="-126"/><a:t>ARC</a:t></a:r></a:p>' +
      '<a:p><a:pPr><a:lnSpc><a:spcPts val="3000"/></a:lnSpc></a:pPr><a:r><a:rPr sz="1000"/><a:t>b</a:t></a:r></a:p></p:txBody>'
    const d = pptxToDeck(zip(deckFiles({ 'ppt/slides/slide10.xml': sld('', shape(xfrm(0, 0, 1154460, 500000), body)) })))!
    const t = (d.slides[1].shapes.at(-1) as Extract<PreviewShape, { type: 'box' }>).text!
    expect(t.noWrap).toBe(true)
    expect(t.autofit).toBe(true)
    expect(t.pad).toEqual([near(45720 / W), near(25400 / W), near(45720 / W), near(25400 / W)])
    const [p1, p2] = t.paragraphs
    // lnSpcReduction (10%) sai do 85,669%; spcAft 50% = metade de uma linha simples (1,2 × 42 pt).
    expect(p1).toMatchObject({ lineH: near(0.85669 - 0.1), before: 6, after: near(0.5 * 42 * 1.2) })
    expect(p1.runs[0]).toMatchObject({ text: 'ARC', size: 42, bold: true, spacing: -1.26 })
    expect(p2).toMatchObject({ linePt: 30 })
    expect(p2.lineH).toBeUndefined()
    expect(p2.runs[0].spacing).toBeUndefined()
    // Sem wrap="none", a caixa quebra linha (campo ausente).
    const plain = (deck!.slides[1].shapes[0] as Extract<PreviewShape, { type: 'box' }>).text!
    expect(plain.noWrap).toBeUndefined()
    // Sem a:normAutofit, a fonte fica como está.
    expect(plain.autofit).toBeUndefined()
  })

  it('entrada que não é pptx devolve null', () => {
    expect(pptxToDeck(Buffer.from('não é zip'))).toBeNull()
    expect(pptxToDeck(Buffer.alloc(0))).toBeNull()
    expect(pptxToDeck(zip({ 'word/document.xml': '<w:document/>' }))).toBeNull()
  })
})

describe('readPptx', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-preview-pptx-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const put = (name: string, buf: Buffer): string => {
    const p = join(dir, name)
    writeFileSync(p, buf)
    return p
  }

  it('devolve os slides com o caminho pedido', async () => {
    const p = put('ok.pptx', zip(deckFiles()))
    const r = await readPptx(p, p, 1000)
    expect(r).toMatchObject({ ok: true, kind: 'slides', path: p, width: W, height: H, truncated: false })
    expect((r as { slides: unknown[] }).slides).toHaveLength(2)
  })

  it('grande demais, inválido e sem slides', async () => {
    expect(await readPptx('x.pptx', 'x.pptx', PREVIEW_LIMITS.pptxFileBytes + 1)).toMatchObject({ ok: false, reason: 'too-big' })
    const bad = put('bad.pptx', Buffer.from('texto'))
    expect(await readPptx(bad, bad, 5)).toMatchObject({ ok: false, reason: 'unsupported', message: expect.stringContaining('válido') })
    const files = deckFiles({ 'ppt/presentation.xml': `<p:presentation ${NS}><p:sldIdLst/></p:presentation>` })
    const empty = put('vazio.pptx', zip(files))
    expect(await readPptx(empty, empty, 5)).toMatchObject({ ok: false, reason: 'unsupported', message: expect.stringContaining('nenhum slide') })
  })
})
