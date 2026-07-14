import { app } from 'electron'
import { createWriteStream } from 'node:fs'
import { mkdir, writeFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { FileAttachment, ResolvedPastedRef } from '../shared/ipc'
import { extOf, isImageExt, mimeForExt } from '../shared/mime'

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
 * Pure/testable: no disk or Electron dependency.
 */
export function buildAttachmentNote(
  text: string,
  refItems: Array<{ name: string; path: string }>
): string {
  if (refItems.length === 0) return text
  const refs = refItems.map((s) => `- ${s.name}: ${s.path}`).join('\n')
  const note = `Arquivos anexados pelo usuário (abra-os com suas ferramentas, ex.: Read, se forem relevantes):\n${refs}`
  return text ? `${text}\n\n${note}` : note
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
): Promise<Array<{ name: string; path: string }>> {
  const dir = join(userDataDir(), 'attachments', safeName(convId))
  await mkdir(dir, { recursive: true })
  const out: Array<{ name: string; path: string }> = []
  for (const f of files) {
    try {
      const name = safeName(f.name)
      const target = join(dir, `${uniquePrefix()}-${name}`)
      await writeFile(target, Buffer.from(f.data, 'base64'))
      out.push({ name, path: target })
    } catch {
      // Best-effort: a single bad file shouldn't drop the whole message.
    }
  }
  return out
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
