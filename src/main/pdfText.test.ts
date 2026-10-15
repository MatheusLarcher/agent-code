import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDF_NO_TEXT, parsePageRange, readPdfText } from './pdfText'

/** PDF mínimo válido: uma página por item, com o texto (ou nada, como um escaneado). */
function buildPdf(pages: Array<string | null>): Buffer {
  const objs: string[] = []
  const pageIds = pages.map((_, i) => 4 + i * 2)
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  pages.forEach((t, i) => {
    const stream = t === null ? '' : `BT /F1 18 Tf 72 720 Td (${t}) Tj ET`
    objs[pageIds[i]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`
    objs[pageIds[i] + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = out.length
    out += `${id} 0 obj\n${objs[id]}\nendobj\n`
  }
  const xref = out.length
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objs.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

let dir = ''
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pdftext-'))
  await writeFile(join(dir, 'tres.pdf'), buildPdf(['Pagina um', 'Pagina dois', 'Pagina tres']))
  await writeFile(join(dir, 'escaneado.pdf'), buildPdf([null, null]))
  await writeFile(join(dir, 'longo.pdf'), buildPdf(Array.from({ length: 25 }, (_, i) => `Folha ${i + 1}`)))
  await writeFile(join(dir, 'quebrado.pdf'), 'isto nao e um pdf')
})
afterAll(async () => rm(dir, { recursive: true, force: true }))

describe('parsePageRange', () => {
  it('aceita "3" e "1-5"; recusa o resto', () => {
    expect(parsePageRange('3')).toEqual([3, 3])
    expect(parsePageRange(' 1 - 5 ')).toEqual([1, 5])
    for (const bad of ['0', '5-2', 'a', '1,3', '-2', '']) expect(parsePageRange(bad), bad).toBeNull()
  })
})

describe('readPdfText', () => {
  it('lê todas as páginas, com caminho relativo ao cwd', async () => {
    const r = await readPdfText(dir, 'tres.pdf')
    expect(r.ok).toBe(true)
    expect(r.text).toContain('3 página(s); lidas 1-3')
    expect(r.text).toMatch(/--- Página 1 ---\nPagina um/)
    expect(r.text).toContain('Pagina tres')
  })

  it('pages escolhe a página ou o intervalo', async () => {
    const one = await readPdfText(dir, join(dir, 'tres.pdf'), '2')
    expect(one.text).toContain('Pagina dois')
    expect(one.text).not.toContain('Pagina um')
    const range = await readPdfText(dir, 'tres.pdf', '2-9')
    expect(range.text).toContain('lidas 2-3')
  })

  it('PDF sem camada de texto diz que é escaneado', async () => {
    expect(await readPdfText(dir, 'escaneado.pdf')).toEqual({ ok: true, text: PDF_NO_TEXT })
  })

  it('para no teto por chamada e diz como pedir o resto', async () => {
    const r = await readPdfText(dir, 'longo.pdf')
    expect(r.text).toContain('25 página(s); lidas 1-20')
    expect(r.text).not.toContain('Folha 21')
    expect(r.text).toContain('pages="21-25"')
  })

  it('erros viram resposta, não exceção', async () => {
    expect((await readPdfText(dir, 'sumiu.pdf')).ok).toBe(false)
    expect((await readPdfText(dir, 'tres.txt')).text).toMatch(/Não é um \.pdf/)
    expect((await readPdfText(dir, 'tres.pdf', 'x')).text).toMatch(/pages inválido/)
    expect((await readPdfText(dir, 'tres.pdf', '7')).text).toMatch(/fora/)
    expect((await readPdfText(dir, 'quebrado.pdf')).text).toMatch(/Não consegui abrir/)
  })
})
