import { createServer, get, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { serveProjectIcon } from './projectIconRoute'

let server: Server | null = null
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())))

async function call(roots: string[], cwd: string, find: Parameters<typeof serveProjectIcon>[3]): Promise<{ status: number; type: string; body: Buffer }> {
  server = createServer((req, res) => void serveProjectIcon(new URL(req.url ?? '/', 'http://x'), res, roots, find))
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return new Promise((resolve) => {
    get(`http://127.0.0.1:${port}/api/project-icon?cwd=${encodeURIComponent(cwd)}`, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body: Buffer.concat(chunks) }))
    })
  })
}

describe('/api/project-icon', () => {
  it('serve os bytes da logo de um projeto conhecido (caminho comparado sem caixa/barra)', async () => {
    const find = vi.fn(async () => ({ mime: 'image/png', bytes: Buffer.from('PNG') }))
    const r = await call(['C:\\GitHub\\Alpha'], 'c:/github/alpha/', find)
    expect(r.status).toBe(200)
    expect(r.type).toBe('image/png')
    expect(r.body.toString()).toBe('PNG')
    expect(find).toHaveBeenCalledWith('C:\\GitHub\\Alpha')
  })

  it('pasta que o PC não mostra ao celular: 403, sem ler o disco', async () => {
    const find = vi.fn(async () => null)
    const r = await call(['C:\\GitHub\\Alpha'], 'C:\\Windows', find)
    expect(r.status).toBe(403)
    expect(find).not.toHaveBeenCalled()
  })

  it('projeto sem logo: 404', async () => {
    const r = await call(['C:\\GitHub\\Beta'], 'C:\\GitHub\\Beta', async () => null)
    expect(r.status).toBe(404)
  })
})
