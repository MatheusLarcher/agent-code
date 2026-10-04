/**
 * Os arquivos do protocolo `agent-mockup` (o HTML do agente na TV) — sem Electron.
 *
 *   MockupFiles.urlFor(req)   o endereço do HTML: `agent-mockup://<token>/<relativo>`,
 *                             só para .html/.htm que existe dentro do cwd da conversa;
 *   MockupFiles.serve(url)    a resposta do protocolo (o arquivo, 403 ou 404), sempre
 *                             com a CSP do mockup;
 *   checkMockupFile(cwd, p)   a mesma regra, para a ferramenta app_chamar_usuario
 *                             (null = ok, senão o motivo).
 *
 * A regra de caminho é a do editor do monitor (shared/pathGuard): absoluto,
 * dentro do cwd e sem nome sensível. Além dela, o caminho REAL (junction,
 * symlink) tem de continuar dentro do cwd real. O token (aleatório, por cwd)
 * é o "host" da URL: a página só alcança o que está na pasta da própria
 * conversa, e outra página não adivinha o token de outra pasta.
 */
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { MOCKUP_CSP, MOCKUP_SCHEME, type MockupRequest, type MockupUrlResult } from '../../shared/officeMockup'
import { diskReadVerdict, normalizePath } from '../../shared/pathGuard'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
}

/** Cabeçalhos de toda resposta (não afrouxar a CSP: é o "sem sair" escolhido). */
function headers(type: string): Record<string, string> {
  return { 'content-type': type, 'content-security-policy': MOCKUP_CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }
}

const fail = (status: number, text: string): Response => new Response(text, { status, headers: headers('text/plain; charset=utf-8') })

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** O arquivo existe e o caminho real fica dentro do cwd real. */
async function realInside(file: string, cwd: string): Promise<boolean> {
  try {
    const [rf, rc] = await Promise.all([fs.realpath(file), fs.realpath(cwd)])
    return inside(rc, rf) && (await fs.stat(rf)).isFile()
  } catch {
    return false
  }
}

/** O HTML pode ir para a TV? null = sim; senão o motivo (legível pelo modelo). */
export async function checkMockupFile(cwd: string, file: string): Promise<string | null> {
  if (!/\.html?$/i.test(file)) return 'não é .html/.htm'
  const verdict = diskReadVerdict(file, cwd)
  if (verdict !== 'ok') return verdict === 'sensitive' ? 'arquivo sensível' : 'fora da pasta da conversa'
  return (await realInside(file, cwd)) ? null : 'o arquivo não existe dentro da pasta da conversa'
}

export class MockupFiles {
  /** cwd normalizado → token, e token → cwd (como veio). */
  private readonly tokens = new Map<string, string>()
  private readonly cwds = new Map<string, string>()

  private tokenFor(cwd: string): string {
    const key = normalizePath(cwd)
    let t = this.tokens.get(key)
    if (!t) {
      t = randomBytes(16).toString('hex')
      this.tokens.set(key, t)
      this.cwds.set(t, cwd)
    }
    return t
  }

  /** O endereço do HTML no protocolo, ou por que não. */
  async urlFor(req: MockupRequest): Promise<MockupUrlResult> {
    const { cwd, path: file } = req
    const error = await checkMockupFile(cwd, file)
    if (error) return { ok: false, error }
    const rel = path.relative(cwd, file).split(/[\\/]+/).map(encodeURIComponent).join('/')
    return { ok: true, url: `${MOCKUP_SCHEME}://${this.tokenFor(cwd)}/${rel}` }
  }

  /** O arquivo pedido pela página (ou 403/404), dentro do cwd do token. */
  async serve(url: string): Promise<Response> {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return fail(400, 'endereço inválido')
    }
    const cwd = u.protocol === `${MOCKUP_SCHEME}:` ? this.cwds.get(u.hostname) : undefined
    if (!cwd) return fail(404, 'não encontrado')
    let parts: string[]
    try {
      parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    } catch {
      return fail(400, 'endereço inválido')
    }
    if (parts.some((p) => p === '..' || /[\\/\0]/.test(p))) return fail(403, 'fora da pasta da conversa')
    const file = path.join(cwd, ...parts)
    if (diskReadVerdict(file, cwd) !== 'ok' || !(await realInside(file, cwd))) return fail(404, 'não encontrado')
    try {
      const body = await fs.readFile(file)
      return new Response(new Uint8Array(body), { status: 200, headers: headers(MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream') })
    } catch {
      return fail(404, 'não encontrado')
    }
  }
}
