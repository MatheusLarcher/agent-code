import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolvePastedPath, downloadPastedUrl, buildAttachmentNote } from './attachments'

describe('buildAttachmentNote — nota de anexos anexada ao texto do usuário', () => {
  it('retorna o texto original quando não há anexos', () => {
    expect(buildAttachmentNote('oi', [])).toBe('oi')
  })

  it('agrega blob-attachments e fileRefs (pasted-by-reference) na mesma nota', () => {
    const note = buildAttachmentNote('confira os arquivos', [
      { name: 'relatorio.xlsx', path: 'C:\\attachments\\relatorio.xlsx' },
      { name: 'manual.pdf', path: 'C:\\attachments\\manual.pdf' }
    ])
    expect(note).toContain('confira os arquivos')
    expect(note).toContain('- relatorio.xlsx: C:\\attachments\\relatorio.xlsx')
    expect(note).toContain('- manual.pdf: C:\\attachments\\manual.pdf')
  })

  it('funciona sem texto (mensagem só com anexo)', () => {
    const note = buildAttachmentNote('', [{ name: 'a.txt', path: 'C:\\a.txt' }])
    expect(note.startsWith('Arquivos anexados')).toBe(true)
    expect(note).toContain('- a.txt: C:\\a.txt')
  })
})

// resolvePastedPath: pure stat, no HTTP needed.
describe('resolvePastedPath — caminho local colado como texto', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-code-paste-'))
  const filePath = join(dir, 'relatorio.pdf')
  writeFileSync(filePath, 'conteudo de teste')

  it('resolve um arquivo existente sem ler o conteúdo (só metadados)', async () => {
    const r = await resolvePastedPath(filePath)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.path).toBe(filePath)
    expect(r.name).toBe('relatorio.pdf')
    expect(r.mediaType).toBe('application/pdf')
    expect(r.size).toBeGreaterThan(0)
    expect(r.isImage).toBe(false)
  })

  it('reconhece extensão de imagem', async () => {
    const imgPath = join(dir, 'foto.png')
    writeFileSync(imgPath, 'fake-png-bytes')
    const r = await resolvePastedPath(imgPath)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.isImage).toBe(true)
  })

  it('falha com ok:false quando o arquivo não existe', async () => {
    const r = await resolvePastedPath(join(dir, 'nao-existe.pdf'))
    expect(r.ok).toBe(false)
  })

  it('falha quando o caminho é uma pasta, não um arquivo', async () => {
    const r = await resolvePastedPath(dir)
    expect(r.ok).toBe(false)
  })
})

// downloadPastedUrl: drive a real local HTTP server (node:http), same pattern
// as remoteServer.test.ts, so the fetch()-based streaming path is exercised
// end-to-end instead of mocked.
describe('downloadPastedUrl — link http(s) colado como texto', () => {
  let server: Server
  let base = ''
  const smallBody = 'x'.repeat(1000)
  const bigBody = 'y'.repeat(2000)

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/manual.pdf') {
        res.writeHead(200, { 'Content-Type': 'application/pdf' })
        res.end(smallBody)
      } else if (req.url === '/sem-content-length.pdf') {
        // Chunked response (no Content-Length) — exercises the streaming cap
        // that only checks bytes actually received, not the declared header.
        res.writeHead(200, { 'Content-Type': 'application/pdf' })
        res.end(bigBody)
      } else if (req.url === '/declara-grande.pdf') {
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': String(500 * 1024 * 1024) })
        res.end(smallBody)
      } else if (req.url === '/nao-encontrado.pdf') {
        res.writeHead(404)
        res.end('not found')
      } else if (req.url === '/conexao-quebrada.pdf') {
        // Send a partial body then abruptly kill the connection — simulates a
        // network failure mid-download, exercising the catch → cleanup() path
        // (the partial file on disk must not survive).
        res.writeHead(200, { 'Content-Type': 'application/pdf' })
        res.write('metade dos dados')
        res.socket?.destroy()
      } else if (req.url === '/a/relatorio.pdf') {
        res.writeHead(200, { 'Content-Type': 'application/pdf' })
        res.end('conteudo do site A')
      } else if (req.url === '/b/relatorio.pdf') {
        res.writeHead(200, { 'Content-Type': 'application/pdf' })
        res.end('conteudo do site B, bem diferente do A')
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('baixa um arquivo pequeno e devolve o caminho salvo com os bytes corretos', async () => {
    const r = await downloadPastedUrl(`${base}/manual.pdf`, 'conv-teste-1')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.name).toBe('manual.pdf')
    expect(r.mediaType).toBe('application/pdf')
    expect(r.size).toBe(smallBody.length)
    expect(r.isImage).toBe(false)
    expect(existsSync(r.path)).toBe(true)
    expect(readFileSync(r.path, 'utf8')).toBe(smallBody)
  })

  it('duas URLs com o mesmo nome-base resolvidas em paralelo não colidem no mesmo arquivo', async () => {
    // Same base name ("relatorio.pdf"), same conv — before the unique-suffix
    // fix, Date.now() alone (1ms resolution) could give both the same target
    // path, and the second createWriteStream would corrupt the first's data.
    const [a, b] = await Promise.all([
      downloadPastedUrl(`${base}/a/relatorio.pdf`, 'conv-colisao'),
      downloadPastedUrl(`${base}/b/relatorio.pdf`, 'conv-colisao')
    ])
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.path).not.toBe(b.path)
    expect(readFileSync(a.path, 'utf8')).toBe('conteudo do site A')
    expect(readFileSync(b.path, 'utf8')).toBe('conteudo do site B, bem diferente do A')
  })

  it('rejeita quando o Content-Length declarado passa do teto de 200 MB', async () => {
    const r = await downloadPastedUrl(`${base}/declara-grande.pdf`, 'conv-teste-2')
    expect(r.ok).toBe(false)
  })

  it('baixa normalmente uma resposta sem Content-Length (chunked)', async () => {
    const r = await downloadPastedUrl(`${base}/sem-content-length.pdf`, 'conv-teste-2b')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.size).toBe(bigBody.length)
    expect(readFileSync(r.path, 'utf8')).toBe(bigBody)
  })

  it('rejeita URL com protocolo não-http(s)', async () => {
    const r = await downloadPastedUrl('ftp://exemplo.com/arquivo.pdf', 'conv-teste-3')
    expect(r.ok).toBe(false)
  })

  it('rejeita URL malformada', async () => {
    const r = await downloadPastedUrl('não é uma url', 'conv-teste-4')
    expect(r.ok).toBe(false)
  })

  it('propaga falha HTTP (404) como erro', async () => {
    const r = await downloadPastedUrl(`${base}/nao-encontrado.pdf`, 'conv-teste-5')
    expect(r.ok).toBe(false)
  })

  it('limpa o arquivo parcial do disco quando a conexão cai no meio do download', async () => {
    const r = await downloadPastedUrl(`${base}/conexao-quebrada.pdf`, 'conv-teste-6')
    expect(r.ok).toBe(false)
    // Nenhum arquivo parcial deve sobrar em <userData>/attachments/conv-teste-6/.
    const dir = join(tmpdir(), 'agent-code', 'attachments', 'conv-teste-6')
    if (existsSync(dir)) {
      const { readdirSync } = await import('node:fs')
      expect(readdirSync(dir)).toHaveLength(0)
    }
  })
})
