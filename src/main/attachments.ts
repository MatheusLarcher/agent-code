import { app } from 'electron'
import { constants, copyFileSync, createWriteStream, existsSync, renameSync, unlinkSync } from 'node:fs'
import { mkdir, writeFile, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import type { FileAttachment, ImageAttachment, ResolvedPastedRef } from '../shared/ipc'
import { extOf, isImageExt, mimeForExt } from '../shared/mime'
import { orderByMediaLabel, sanitizeMediaLabel } from '../shared/inlineMedia'

/** Strip directory separators / traversal from a user-supplied file name. */
function safeName(name: string): string {
  const base = (name || 'arquivo').split(/[\\/]+/).pop() || 'arquivo'
  return base.replace(/[<>:"|?* -]/g, '_').slice(0, 180) || 'arquivo'
}

/** Tests run outside the Electron runtime, where `app.getPath` throws. */
function userDataDir(): string {
  try {
    return app.getPath('userData')
  } catch {
    return join(tmpdir(), 'agent-code')
  }
}

const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 60_000

// `Date.now()` alone has 1ms resolution — two attachments resolved in the
// same tick (e.g. pasting two URLs with the same file name, resolved via
// Promise.all) could collide on the same target path and write to the same
// file concurrently. This counter guarantees a unique suffix per process.
let attachmentSeq = 0
function uniquePrefix(): string {
  return `${Date.now()}-${++attachmentSeq}`
}

/**
 * Compose the "arquivos anexados" note appended to the user's text, from
 * whatever got saved to disk (blob attachments + pasted-by-reference paths).
 * No Electron dependency. Roda em todo envio (agent:send e "agora"): a cópia
 * do rascunho que ainda estiver em `rascunho/` é movida AQUI para a pasta do
 * envio (ver promoteDraftCopy), e a nota leva o caminho de lá.
 */
export function buildAttachmentNote(
  text: string,
  refItems: Array<{ name: string; path: string; label?: string }>
): string {
  if (refItems.length === 0) return text
  // Anexo posto no texto sai na ordem N e com o rótulo que liga ao {{midia:N}}.
  const refs = orderByMediaLabel(refItems)
    .map((s) => `- ${sanitizeMediaLabel(s.label) ?? s.name}: ${typeof s.path === 'string' ? promoteDraftCopy(s.path) : s.path}`)
    .join('\n')
  const note = `Arquivos anexados pelo usuário (abra-os com suas ferramentas, ex.: Read, se forem relevantes):\n${refs}`
  return text ? `${text}\n\n${note}` : note
}

/**
 * Pasted/attached images as files, so they can also be saved to disk and
 * referenced by path (the Agent Manager imports them into the plan with
 * plan_midia_importar — inline image blocks have no path). Pure/testable.
 */
export function imagesAsFiles(images: ImageAttachment[]): FileAttachment[] {
  return images.map((img, i) => {
    const sub = (img.mediaType.split('/')[1] || 'png').split('+')[0].toLowerCase()
    const ext = sub === 'jpeg' ? 'jpg' : sub.replace(/[^a-z0-9]/g, '') || 'png'
    const size = Buffer.byteLength(img.data, 'base64')
    const label = sanitizeMediaLabel(img.label)
    return { name: `imagem-colada-${i + 1}.${ext}`, mediaType: img.mediaType, data: img.data, size, ...(label ? { label } : {}) }
  })
}

/** Caminho vindo do renderer (fronteira de IPC): absoluto, uma linha, com teto. Só vai para o texto. */
function validImagePath(p: unknown): p is string {
  // eslint-disable-next-line no-control-regex
  return typeof p === 'string' && p.length <= 4000 && isAbsolute(p) && !/[\u0000-\u001f\u007f]/.test(p)
}

/**
 * Imagens da mensagem -> nota de caminhos. Com o caminho original conhecido
 * (arquivo escolhido, arrastado ou colado por caminho), a nota leva ele; sem
 * (print colado), a imagem vira arquivo e é gravada para ganhar um caminho.
 */
export function splitImagesForNote(images: ImageAttachment[] | undefined): {
  refs: Array<{ name: string; path: string; label?: string }>
  toSave: FileAttachment[]
} {
  const list = Array.isArray(images) ? images : []
  const refs: Array<{ name: string; path: string; label?: string }> = []
  const noPath: ImageAttachment[] = []
  for (const img of list) {
    if (!validImagePath(img?.path)) {
      noPath.push(img)
      continue
    }
    const label = sanitizeMediaLabel(img.label)
    refs.push({ name: safeName(basename(img.path)), path: img.path, ...(label ? { label } : {}) })
  }
  return { refs, toSave: imagesAsFiles(noPath) }
}

/**
 * Persist non-image attachments to disk so the agent can open them by path with
 * its own tools. Files land under `<userData>/attachments/<convId>/` and a
 * timestamp prefix keeps same-named files from clobbering each other.
 * Returns the absolute path saved for each input file (skips ones that fail).
 */
export async function saveAttachments(
  convId: string,
  files: FileAttachment[]
): Promise<Array<{ name: string; path: string; label?: string }>> {
  const dir = join(userDataDir(), 'attachments', safeName(convId))
  await mkdir(dir, { recursive: true })
  const out: Array<{ name: string; path: string; label?: string }> = []
  for (const f of files) {
    try {
      const name = safeName(f.name)
      const target = join(dir, `${uniquePrefix()}-${name}`)
      await writeFile(target, Buffer.from(f.data, 'base64'))
      const label = sanitizeMediaLabel(f.label)
      out.push({ name, path: target, ...(label ? { label } : {}) })
    } catch {
      // Best-effort: a single bad file shouldn't drop the whole message.
    }
  }
  return out
}

/** Teto do anexo guardado para o rascunho: o mesmo da leitura de imagem (50 MB), em base64. */
const MAX_DRAFT_BASE64 = Math.ceil((50 * 1024 * 1024 * 4) / 3) + 4

/**
 * Formato real dos ids de conversa (`c<base36>`, `c-<hex>` das tarefas MCP,
 * `<id>-conflict-<hash>`, UUID). Sem ponto, barra nem nada que o sistema de
 * arquivos interprete: o id vira o nome de uma pasta.
 */
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/

/** Extensões que o Windows executa (ou que mudam o sistema) ao abrir: não entram como anexo do rascunho. */
const FORBIDDEN_EXT = new Set(['exe', 'bat', 'cmd', 'com', 'scr', 'msi', 'lnk', 'ps1', 'vbs', 'vbe', 'hta', 'dll', 'cpl', 'reg', 'pif'])
/** Nomes reservados do Windows, com ou sem extensão (CON, NUL, COM1, LPT1.txt…). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\.|$)/i
/** Teto do nome saneado (sem o prefixo `<ts>-<seq>-`), em caracteres. */
const MAX_DRAFT_NAME = 120
/** Nome da cópia do rascunho: `<ts>-<seq>-<nome original saneado>` (ver draftFileName). */
const DRAFT_FILE = /^\d+-\d+-[^\\/:*?"<>|]+$/
const IMAGE_EXT: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' }

/** Caixa não conta no Windows: é assim que os caminhos são comparados aqui. */
const fold = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
/** Chave de comparação de um caminho: absoluto (path.resolve) e, no win32, em minúsculas. */
const pathKey = (p: string): string => fold(resolve(p))

const attachmentsRoot = (): string => resolve(userDataDir(), 'attachments')

/**
 * Pasta das cópias do rascunho: `<userData>/attachments/<conversa>/rascunho/`,
 * conferida DENTRO de attachments/. O envio MOVE a cópia daqui para
 * `<conversa>/` (promoteDraftCopy): o que saiu numa mensagem nunca fica aqui.
 */
function draftDir(convId: unknown): string | null {
  if (typeof convId !== 'string' || !CONVERSATION_ID.test(convId)) return null
  const root = attachmentsRoot()
  const dir = resolve(root, convId, 'rascunho')
  const rel = relative(root, dir)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel !== join(convId, 'rascunho')) return null
  return dir
}

/**
 * Nome ORIGINAL do anexo, saneado, com a extensão original: só o basename, sem
 * caracteres de controle/bidi nem reservados do Windows, sem ponto ou espaço no
 * fim e com teto de tamanho. Recusa extensão proibida, nome começando com ponto
 * (.htaccess) e nome reservado do Windows. Imagem sem extensão ganha a do tipo.
 */
export function draftFileName(name: string, mediaType = ''): { ok: true; name: string } | { ok: false; error: string } {
  const last = (String(name).split(/[\\/]+/).pop() ?? '').normalize('NFC')
  const clean = (s: string): string => s.replace(/[. ]+$/, '')
  // Controle e bidi saem; ponto/espaço do fim saem ANTES de trocar espaço por '_' ('a.exe .' é a.exe).
  let base = clean(clean(last.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '')).replace(/[<>:"|?*\s]/g, '_'))
  if (base.startsWith('.')) return { ok: false, error: 'Nome de arquivo não aceito (começa com ponto).' }
  if (!base) base = 'anexo'
  const extOfName = (s: string): string => (s.lastIndexOf('.') > 0 ? s.slice(s.lastIndexOf('.') + 1).toLowerCase() : '')
  if (!extOfName(base) && IMAGE_EXT[mediaType]) base = `${base}.${IMAGE_EXT[mediaType]}`
  const chars = [...base]
  if (chars.length > MAX_DRAFT_NAME) {
    const ext = extOfName(base)
    base = ext && ext.length <= 16 ? `${chars.slice(0, MAX_DRAFT_NAME - ext.length - 1).join('')}.${ext}` : clean(chars.slice(0, MAX_DRAFT_NAME).join(''))
  }
  if (WINDOWS_RESERVED.test(base)) return { ok: false, error: 'Nome de arquivo reservado do Windows.' }
  const ext = extOfName(base) // conferida no nome FINAL (depois do corte)
  if (FORBIDDEN_EXT.has(ext)) return { ok: false, error: `Tipo de arquivo não aceito: .${ext}` }
  return { ok: true, name: `${uniquePrefix()}-${base}` }
}

/**
 * Rascunho com anexo: os bytes vão para `attachments/<conversa>/rascunho/` com o
 * nome original saneado e o rascunho guarda só o caminho. Assim o payload da
 * conversa não cresce com o tamanho do arquivo. Entrada do renderer validada:
 * id no formato real, pasta dentro de attachments/, tamanho e nome (draftFileName).
 */
export async function stashDraftAttachment(
  convId: unknown,
  file: unknown
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const dir = draftDir(convId)
  if (!dir) return { ok: false, error: 'Conversa inválida.' }
  const f = file as { name?: unknown; mediaType?: unknown; data?: unknown } | null
  if (!f || typeof f.name !== 'string' || typeof f.mediaType !== 'string' || typeof f.data !== 'string') {
    return { ok: false, error: 'Anexo inválido.' }
  }
  const named = draftFileName(f.name, f.mediaType)
  if (!named.ok) return named
  if (f.data.length > MAX_DRAFT_BASE64) return { ok: false, error: 'Anexo grande demais para o rascunho.' }
  try {
    await mkdir(dir, { recursive: true })
    const target = join(dir, named.name)
    const rel = relative(dir, target)
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep)) return { ok: false, error: 'Anexo inválido.' }
    await writeFile(target, Buffer.from(f.data, 'base64'), { flag: 'wx' })
    return { ok: true, path: target }
  } catch {
    return { ok: false, error: 'Não consegui gravar o anexo em disco.' }
  }
}

/**
 * Cópia do rascunho <-> lugar dela no envio. `attachments/<c>/rascunho/<n>` e
 * `attachments/<c>/<n>` formam o par (o envio fica com o MESMO nome, um nível
 * acima). Qualquer outro caminho: null.
 */
function draftPair(p: string): { from: string; to: string } | null {
  const root = attachmentsRoot()
  const abs = resolve(p)
  const rel = relative(root, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  const parts = rel.split(sep)
  const name = parts[parts.length - 1]
  if (!CONVERSATION_ID.test(parts[0]) || !DRAFT_FILE.test(name)) return null
  if (parts.length === 3 && fold(parts[1]) === 'rascunho') return { from: abs, to: join(root, parts[0], name) }
  if (parts.length === 2) return { from: join(root, parts[0], 'rascunho', name), to: abs }
  return null
}

/**
 * No envio: a cópia do rascunho é MOVIDA para a pasta do envio (rename; se não
 * der, cópia + remoção) e o caminho de lá é devolvido. Idempotente: já movida,
 * devolve o destino; caminho que não é cópia do rascunho volta igual. Síncrono
 * de propósito: roda inteiro antes de qualquer outro IPC (sem corrida com o descarte).
 */
export function promoteDraftCopy(p: string): string {
  const pair = draftPair(p)
  if (!pair) return p
  if (existsSync(pair.to)) return pair.to
  if (!existsSync(pair.from)) return p
  try {
    renameSync(pair.from, pair.to)
  } catch {
    try {
      copyFileSync(pair.from, pair.to, constants.COPYFILE_EXCL)
      unlinkSync(pair.from)
    } catch {
      return existsSync(pair.to) ? pair.to : pair.from
    }
  }
  return pair.to
}

/** IPC do envio: move as cópias do rascunho da conversa (só dela) para a pasta do envio. */
export function promoteDraftAttachments(convId: unknown, paths: unknown): string[] {
  const dir = draftDir(convId)
  if (!dir || !Array.isArray(paths)) return []
  const out: string[] = []
  for (const p of paths.slice(0, 200)) {
    if (typeof p !== 'string' || p.length > 4000) continue
    const pair = draftPair(p)
    if (pair && pathKey(dirname(pair.from)) === pathKey(dir)) out.push(promoteDraftCopy(p))
  }
  return out
}

/**
 * Apaga cópias que eram SÓ do rascunho (item removido, campo limpo, conversa
 * apagada). Só age em arquivo com o nome das cópias, DIRETO na pasta
 * `rascunho/` da conversa (caminhos comparados por pathKey). O que foi enviado
 * já saiu de lá (promoteDraftCopy): não há o que proteger.
 */
export async function discardDraftAttachments(convId: unknown, paths: unknown): Promise<number> {
  const dir = draftDir(convId)
  if (!dir || !Array.isArray(paths)) return 0
  let removed = 0
  for (const p of paths.slice(0, 200)) {
    if (typeof p !== 'string' || p.length > 4000) continue
    const target = resolve(p)
    if (pathKey(dirname(target)) !== pathKey(dir) || !DRAFT_FILE.test(basename(target))) continue
    try {
      await unlink(target) // link simbólico: sai só o link
      removed++
    } catch {
      // já não existe: nada a fazer
    }
  }
  return removed
}

/**
 * Resolve a pasted line that looks like a local file path. Only stats the
 * path — never reads its bytes — so there's no size cap: the agent opens the
 * ORIGINAL path itself with its own tools.
 */
export async function resolvePastedPath(rawPath: string): Promise<ResolvedPastedRef> {
  const p = rawPath.trim()
  try {
    const s = await stat(p)
    if (!s.isFile()) return { ok: false, error: 'O caminho não é um arquivo.' }
    const name = p.split(/[\\/]+/).pop() || p
    const ext = extOf(name)
    return { ok: true, name, path: p, mediaType: mimeForExt(ext), size: s.size, isImage: isImageExt(ext) }
  } catch {
    return { ok: false, error: 'Arquivo não encontrado nesse caminho.' }
  }
}

/**
 * Download a pasted http(s) file URL to disk, streaming straight to a file
 * (never buffering the whole body in memory) so large files are safe. Capped
 * at MAX_DOWNLOAD_BYTES / DOWNLOAD_TIMEOUT_MS to avoid an accidental huge or
 * hanging download; the target path is what gets sent to the agent.
 */
export async function downloadPastedUrl(url: string, convId: string): Promise<ResolvedPastedRef> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, error: 'URL inválida.' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Apenas links http(s) são suportados.' }
  }

  const name = safeName(decodeURIComponent(parsed.pathname.split('/').pop() || 'arquivo'))
  const dir = join(userDataDir(), 'attachments', safeName(convId))
  await mkdir(dir, { recursive: true })
  const target = join(dir, `${uniquePrefix()}-${name}`)

  // Best-effort cleanup of a partial download (size cap hit, timeout, or
  // stream error) — the caller only ever gets a fully-written file or none.
  const cleanup = async (): Promise<void> => {
    try {
      await unlink(target)
    } catch {
      // Nothing was written yet, or already gone — fine either way.
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal })
    if (!res.ok || !res.body) return { ok: false, error: `Falha ao baixar: HTTP ${res.status}` }
    const declaredLength = Number(res.headers.get('content-length') || 0)
    if (declaredLength > MAX_DOWNLOAD_BYTES) {
      return { ok: false, error: 'Arquivo maior que o limite de 200 MB.' }
    }

    let received = 0
    const file = createWriteStream(target)
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      if (received > MAX_DOWNLOAD_BYTES) {
        file.destroy()
        controller.abort()
        await cleanup()
        return { ok: false, error: 'Arquivo maior que o limite de 200 MB.' }
      }
      file.write(value)
    }
    await new Promise<void>((resolve) => file.end(resolve))

    const ext = extOf(name)
    return {
      ok: true,
      name,
      path: target,
      mediaType: res.headers.get('content-type')?.split(';')[0] || mimeForExt(ext),
      size: received,
      isImage: isImageExt(ext)
    }
  } catch (err) {
    await cleanup()
    const timedOut = controller.signal.aborted
    return { ok: false, error: timedOut ? 'Tempo esgotado ao baixar o arquivo.' : `Falha ao baixar: ${String(err)}` }
  } finally {
    clearTimeout(timeout)
  }
}
