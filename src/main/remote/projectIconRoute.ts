/**
 * `/api/project-icon?cwd=…`: a logo do projeto (a mesma da barra lateral do PC) para o
 * celular desenhar na lista de projetos e no cabeçalho da conversa. Só serve pastas que
 * o PC já mostra ao celular (cwd de conversa ou projeto conhecido) — não lê pasta
 * arbitrária. Sem logo: 404 e o celular fica com o ícone de pasta.
 */
import type { ServerResponse } from 'node:http'
import { findProjectIconFile } from '../projectIcon'

type IconFile = { mime: string; bytes: Buffer } | null

const cache = new Map<string, Promise<IconFile>>()
const key = (p: string): string => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()

export async function serveProjectIcon(
  url: URL,
  res: ServerResponse,
  knownRoots: readonly string[],
  find: (root: string) => Promise<IconFile> = findProjectIconFile
): Promise<void> {
  const cwd = (url.searchParams.get('cwd') ?? '').trim()
  const root = cwd ? knownRoots.find((r) => r && key(r) === key(cwd)) : undefined
  if (!root) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'projeto desconhecido' }))
    return
  }
  let pending = cache.get(key(root))
  if (!pending) {
    pending = find(root).catch(() => null)
    cache.set(key(root), pending)
  }
  const icon = await pending
  if (!icon) {
    // Sem logo hoje pode ter amanhã: não fica preso no cache.
    cache.delete(key(root))
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'sem logo' }))
    return
  }
  res.writeHead(200, { 'Content-Type': icon.mime, 'Content-Length': String(icon.bytes.length), 'Cache-Control': 'private, max-age=3600' })
  res.end(icon.bytes)
}
