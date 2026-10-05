/**
 * Parakeet's files in the voice cache: `<cacheDir>/<repo>/<file>`. Downloaded
 * on first use (or from Settings › Voz) from the pinned Hugging Face revision,
 * streamed to `<file>.part`, checked (size + sha256) and only then renamed, so
 * an interrupted download is never mistaken for a model.
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { PARAKEET_FILES, PARAKEET_MODEL, PARAKEET_REVISION, type ModelFile, type VoiceProgress } from './protocol'

export function parakeetDir(cacheDir: string): string {
  return join(cacheDir, ...PARAKEET_MODEL.split('/'))
}

const FILES: ModelFile[] = Object.values(PARAKEET_FILES)

/** Total download, for the notice and Settings (≈ 638 MB). */
export const PARAKEET_DOWNLOAD_BYTES = FILES.reduce((n, f) => n + f.size, 0)

function complete(dir: string, f: ModelFile): boolean {
  const p = join(dir, f.name)
  try {
    return existsSync(p) && statSync(p).size === f.size
  } catch {
    return false
  }
}

/** Every file is in the cache with its expected size. */
export function parakeetInstalled(cacheDir: string): boolean {
  const dir = parakeetDir(cacheDir)
  return FILES.every((f) => complete(dir, f))
}

export function fileUrl(name: string): string {
  return `https://huggingface.co/${PARAKEET_MODEL}/resolve/${PARAKEET_REVISION}/${name}`
}

async function download(dir: string, f: ModelFile, onProgress: (p: VoiceProgress) => void): Promise<void> {
  const target = join(dir, f.name)
  const part = `${target}.part`
  const res = await fetch(fileUrl(f.name), { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`download de ${f.name} falhou: HTTP ${res.status}`)
  const hash = createHash('sha256')
  let loaded = 0
  let lastPct = -1
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>)
  body.on('data', (chunk: Buffer) => {
    hash.update(chunk)
    loaded += chunk.length
    const pct = Math.floor((loaded / f.size) * 100)
    if (pct !== lastPct) {
      lastPct = pct
      onProgress({ phase: 'download', model: PARAKEET_MODEL, file: f.name, loaded, total: f.size, progress: loaded / f.size })
    }
  })
  try {
    await pipeline(body, createWriteStream(part))
    if (loaded !== f.size) throw new Error(`download de ${f.name} incompleto (${loaded} de ${f.size} bytes)`)
    const sum = hash.digest('hex')
    if (f.sha256 && sum !== f.sha256) throw new Error(`download de ${f.name} corrompido (sha256 ${sum.slice(0, 12)}…)`)
    renameSync(part, target)
  } catch (err) {
    rmSync(part, { force: true })
    throw err
  }
}

/** Downloads what is missing; returns the model folder. */
export async function ensureParakeetFiles(cacheDir: string, onProgress: (p: VoiceProgress) => void): Promise<string> {
  const dir = parakeetDir(cacheDir)
  mkdirSync(dir, { recursive: true })
  const missing = FILES.filter((f) => !complete(dir, f))
  if (missing.length === 0) return dir
  // Announce every file up front (the ones already here as done), so the bar
  // covers the whole model from the first byte instead of growing per file.
  for (const f of FILES) {
    const loaded = missing.includes(f) ? 0 : f.size
    onProgress({ phase: 'download', model: PARAKEET_MODEL, file: f.name, loaded, total: f.size, progress: loaded / f.size })
  }
  for (const f of missing) await download(dir, f, onProgress)
  onProgress({ phase: 'ready', model: PARAKEET_MODEL })
  return dir
}
