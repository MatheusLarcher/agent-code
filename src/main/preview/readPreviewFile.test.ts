// @vitest-environment node
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as XLSX from 'xlsx'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PREVIEW_LIMITS, pathFromPreviewUrl } from '../../shared/preview'
import { decodeDelimited, readPreviewFile } from './readPreviewFile'
import { resolvePreviewRequest } from './previewServe'
import { clearPreviewRoots, isOpenedPreviewFile, parsePreviewUrl, rootForToken } from './previewUrls'

const dir = mkdtempSync(join(tmpdir(), 'agent-preview-read-'))
const file = (name: string, content: string | Buffer): string => {
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

beforeEach(() => clearPreviewRoots())
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('readPreviewFile — texto', () => {
  it('lê markdown/código com lang e sem o BOM', async () => {
    const md = file('leia.md', '﻿# Título\nação')
    expect(await readPreviewFile(md)).toEqual({ ok: true, kind: 'markdown', path: md, text: '# Título\nação', truncated: false, lang: 'md' })
    const ts = file('a.ts', 'const x = 1')
    expect(await readPreviewFile(ts)).toMatchObject({ kind: 'code', lang: 'typescript', text: 'const x = 1' })
    const txt = file('notas.txt', 'oi')
    expect(await readPreviewFile(txt)).toMatchObject({ kind: 'text', lang: 'txt', truncated: false })
  })

  it('corta no limite e não deixa um caractere multibyte pela metade', async () => {
    // "ç" ocupa 2 bytes: o corte em textBytes cai no meio do último.
    const big = file('grande.log', 'a'.repeat(PREVIEW_LIMITS.textBytes - 1) + 'ççç')
    const r = await readPreviewFile(big)
    expect(r).toMatchObject({ ok: true, kind: 'text', truncated: true })
    const text = (r as { text: string }).text
    expect(text.length).toBe(PREVIEW_LIMITS.textBytes - 1)
    expect(text.endsWith('�')).toBe(false)
  })
})

describe('readPreviewFile — planilhas', () => {
  it('csv em utf8 e em windows-1252 (Excel no Brasil)', async () => {
    const utf8 = file('u.csv', 'nome,cidade\nJoão,São Paulo\n')
    expect(await readPreviewFile(utf8)).toEqual({
      ok: true,
      kind: 'table',
      path: utf8,
      sheets: [{ name: 'Sheet1', rows: [['nome', 'cidade'], ['João', 'São Paulo']], truncated: false }]
    })
    const latin = file('l.csv', Buffer.from([0x4a, 0x6f, 0xe3, 0x6f, 0x2c, 0x41, 0xe7, 0xfa, 0x63, 0x61, 0x72, 0x0a]))
    const r = await readPreviewFile(latin)
    expect(r).toMatchObject({ ok: true, kind: 'table' })
    expect((r as { sheets: { rows: string[][] }[] }).sheets[0].rows).toEqual([['João', 'Açúcar']])
    expect(decodeDelimited(Buffer.from('ok', 'utf8'))).toBe('ok')
  })

  it('datas do xlsx saem em dd/mm/aaaa; formato próprio do arquivo fica', async () => {
    const ws = XLSX.utils.aoa_to_sheet([['Data', 'Mês'], [new Date(2026, 10, 2), new Date(2026, 10, 2)]], { cellDates: true })
    ws.B2.z = 'mmm/yy'
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'D')
    const p = file('datas.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer)
    const r = await readPreviewFile(p)
    expect((r as { sheets: { rows: string[][] }[] }).sheets[0].rows[1]).toEqual(['02/11/2026', 'Nov/26'])
  })

  it('tsv separa por tabulação', async () => {
    const tsv = file('t.tsv', 'a\tb\n1\t2\n')
    const r = await readPreviewFile(tsv)
    expect((r as { sheets: { rows: string[][] }[] }).sheets[0].rows).toEqual([['a', 'b'], ['1', '2']])
  })

  it('xlsx pula a aba oculta e tira linhas vazias do fim', async () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x', 'y'], [1, 2], ['', '']]), 'Visível')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['segredo']]), 'Oculta')
    wb.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }] }
    const xlsx = file('p.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer)
    const r = await readPreviewFile(xlsx)
    expect(r).toEqual({
      ok: true,
      kind: 'table',
      path: xlsx,
      sheets: [{ name: 'Visível', rows: [['x', 'y'], ['1', '2']], truncated: false }]
    })
  })

  /** dimension: troca o <dimension ref> no XML já gravado (o escritor do SheetJS percorreria a faixa toda). */
  const xlsxOf = (name: string, ws: XLSX.WorkSheet, dimension?: string): string => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'A')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
    if (!dimension) return file(name, buf)
    const zip = XLSX.CFB.read(buf, { type: 'buffer' })
    const entry = XLSX.CFB.find(zip, 'Root Entry/xl/worksheets/sheet1.xml')
    if (!entry?.content) throw new Error('sheet1.xml não encontrado no xlsx de teste')
    const xml = Buffer.from(entry.content as Uint8Array).toString('utf8')
    entry.content = Buffer.from(xml.replace(/<dimension ref="[^"]*"/, `<dimension ref="${dimension}"`))
    return file(name, Buffer.from(XLSX.CFB.write(zip, { type: 'buffer', fileType: 'zip' }) as Uint8Array))
  }
  type Sheets = { sheets: { rows: string[][]; truncated: boolean }[] }

  it('!ref enorme (A1:XFD300000) num arquivo de poucos KB não materializa a faixa', async () => {
    const p = xlsxOf('ref-enorme.xlsx', XLSX.utils.aoa_to_sheet([['a', 'b'], [1, 2]]), 'A1:XFD300000')
    const t0 = Date.now()
    const r = await readPreviewFile(p)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect((r as Sheets).sheets[0]).toEqual({ name: 'A', rows: [['a', 'b'], ['1', '2']], truncated: false })
  })

  it('linhas: exatamente tableRows não corta; uma a mais corta', async () => {
    const n = PREVIEW_LIMITS.tableRows
    const exact = await readPreviewFile(xlsxOf('exato.xlsx', XLSX.utils.aoa_to_sheet(Array.from({ length: n }, (_, i) => [i]))))
    expect((exact as Sheets).sheets[0].rows).toHaveLength(n)
    expect((exact as Sheets).sheets[0].truncated).toBe(false)
    const over = await readPreviewFile(xlsxOf('mais.xlsx', XLSX.utils.aoa_to_sheet(Array.from({ length: n + 3 }, (_, i) => [i]))))
    expect((over as Sheets).sheets[0].rows).toHaveLength(n)
    expect((over as Sheets).sheets[0].truncated).toBe(true)
    // csv/tsv passam pela mesma leitura (sheetRows).
    const csv = await readPreviewFile(file('mais.csv', Array.from({ length: n + 3 }, (_, i) => String(i)).join('\n')))
    expect((csv as Sheets).sheets[0].rows).toHaveLength(n)
    expect((csv as Sheets).sheets[0].truncated).toBe(true)
  })

  it('colunas: corta só se houver dado depois da última coluna mostrada', async () => {
    const cols = PREVIEW_LIMITS.tableCols
    const wide = XLSX.utils.aoa_to_sheet([['x']])
    XLSX.utils.sheet_add_aoa(wide, [['última']], { origin: { r: 0, c: cols - 1 } })
    XLSX.utils.sheet_add_aoa(wide, [['longe']], { origin: { r: 0, c: cols + 50 } })
    const r = await readPreviewFile(xlsxOf('larga.xlsx', wide))
    const row = (r as Sheets).sheets[0].rows[0]
    expect(row).toHaveLength(cols)
    expect(row[cols - 1]).toBe('última')
    expect((r as Sheets).sheets[0].truncated).toBe(true)
    // Exatamente tableCols colunas com dado: não corta.
    const exact = XLSX.utils.aoa_to_sheet([['x']])
    XLSX.utils.sheet_add_aoa(exact, [['última']], { origin: { r: 0, c: cols - 1 } })
    expect((await readPreviewFile(xlsxOf('exata.xlsx', exact)) as Sheets).sheets[0].truncated).toBe(false)
    // Só formatação larga no !ref, sem dado: não corta nem enche a linha de colunas vazias.
    const f = await readPreviewFile(xlsxOf('formatada.xlsx', XLSX.utils.aoa_to_sheet([['x', 'y'], ['', '']]), 'A1:XFD3'))
    expect((f as Sheets).sheets[0]).toMatchObject({ rows: [['x', 'y']], truncated: false })
  })

  it('planilha acima do limite vira too-big sem ser lida', async () => {
    const p = join(dir, 'enorme.xlsx')
    const fh = await open(p, 'w')
    await fh.truncate(PREVIEW_LIMITS.tableFileBytes + 1)
    await fh.close()
    expect(await readPreviewFile(p)).toMatchObject({ ok: false, reason: 'too-big', path: p })
  })

  it('arquivo corrompido vira error, sem lançar', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bad = file('quebrado.xlsx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))
    expect(await readPreviewFile(bad)).toMatchObject({ ok: false, reason: 'error' })
    spy.mockRestore()
  })
})

describe('readPreviewFile — html e mídia', () => {
  it('html devolve a URL com token da pasta (relativos resolvem) e registra a raiz', async () => {
    const html = file('index.html', '<img src="img/a.png">')
    const r = await readPreviewFile(html)
    expect(r).toMatchObject({ ok: true, kind: 'html', path: html })
    const url = (r as { url: string }).url
    expect(url).toMatch(/^agent-preview:\/\/[a-f0-9]{20}\/index\.html$/)
    const parsed = parsePreviewUrl(url)
    expect(parsed).toMatchObject({ kind: 'root', segments: ['index.html'] })
    // A raiz é a pasta REAL (no Windows o tmpdir pode vir no nome curto).
    expect(rootForToken((parsed as { token: string }).token)).toBe(realpathSync.native(dir))
    // O relativo que o Chromium montaria cai na mesma raiz.
    expect(parsePreviewUrl(new URL('img/a.png', url).href)).toMatchObject({ segments: ['img', 'a.png'] })
  })

  it('mídia devolve a URL do contrato (previewFileUrl) e registra o caminho aberto', async () => {
    const png = file('foto.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(isOpenedPreviewFile(png)).toBe(false)
    const r = await readPreviewFile(png)
    expect(r).toMatchObject({ ok: true, kind: 'media', path: png })
    expect(pathFromPreviewUrl((r as { url: string }).url)).toBe(png)
    expect(isOpenedPreviewFile(png)).toBe(true)
  })

  it('html que é link simbólico abre pela pasta REAL (o protocolo serve, sem 403)', async () => {
    const realDir = join(dir, 'real')
    const linkDir = join(dir, 'atalhos')
    mkdirSync(realDir, { recursive: true })
    mkdirSync(linkDir, { recursive: true })
    writeFileSync(join(realDir, 'pagina.html'), '<img src="a.png">')
    writeFileSync(join(realDir, 'a.png'), 'png')
    const link = join(linkDir, 'atalho.html')
    try {
      symlinkSync(join(realDir, 'pagina.html'), link, 'file')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return // Windows sem modo desenvolvedor/admin
      throw err
    }
    const r = await readPreviewFile(link)
    expect(r).toMatchObject({ ok: true, kind: 'html', path: link })
    const url = (r as { url: string }).url
    expect(await resolvePreviewRequest(url)).toMatchObject({ ok: true, mime: 'text/html; charset=utf-8' })
    expect(await resolvePreviewRequest(new URL('a.png', url).href)).toMatchObject({ ok: true, mime: 'image/png' })
  })
})

describe('readPreviewFile — apresentações', () => {
  it('pptx vira slides; .pptx que não é PowerPoint vira unsupported', async () => {
    const ns = 'xmlns:a="a" xmlns:r="r" xmlns:p="p"'
    const rel = (target: string): string =>
      `<Relationships><Relationship Id="rId1" Type="http://x/relationships/slide" Target="${target}"/></Relationships>`
    const cfb = XLSX.CFB as unknown as {
      utils: { cfb_new(o: object): object; cfb_add(c: object, p: string, b: Buffer): void }
      write(c: object, o: object): Buffer
    }
    const c = cfb.utils.cfb_new({ type: 'zip' })
    const parts: Record<string, string> = {
      '/ppt/presentation.xml': `<p:presentation ${ns}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
      '/ppt/_rels/presentation.xml.rels': rel('slides/slide1.xml'),
      '/ppt/slides/slide1.xml': `<p:sld ${ns}><p:cSld><p:spTree/></p:cSld></p:sld>`
    }
    for (const [k, v] of Object.entries(parts)) cfb.utils.cfb_add(c, k, Buffer.from(v))
    const p = file('deck.pptx', Buffer.from(cfb.write(c, { type: 'buffer', fileType: 'zip' })))
    expect(await readPreviewFile(p)).toMatchObject({ ok: true, kind: 'slides', path: p, width: 9144000, height: 6858000, slides: [{ shapes: [] }] })
    const fake = file('falso.pptx', 'não sou zip')
    expect(await readPreviewFile(fake)).toMatchObject({ ok: false, reason: 'unsupported' })
  })
})

describe('readPreviewFile — barreira', () => {
  it('não encontrado, sensível, relativo, pasta e extensão sem suporte', async () => {
    expect(await readPreviewFile(join(dir, 'nao-existe.txt'))).toMatchObject({ ok: false, reason: 'not-found' })
    const env = file('.env', 'TOKEN=1')
    expect(await readPreviewFile(env)).toMatchObject({ ok: false, reason: 'blocked' })
    expect(await readPreviewFile('relativo.txt')).toMatchObject({ ok: false, reason: 'error' })
    expect(await readPreviewFile('')).toMatchObject({ ok: false, reason: 'error' })
    expect(await readPreviewFile(dir)).toMatchObject({ ok: false, reason: 'unsupported' })
    const exe = file('app.exe', 'MZ')
    expect(await readPreviewFile(exe)).toMatchObject({ ok: false, reason: 'unsupported', message: expect.stringContaining('.exe') })
  })
})
