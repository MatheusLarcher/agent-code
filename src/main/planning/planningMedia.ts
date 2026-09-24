import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { extOf, mimeForExt } from '../../shared/mime'
import {
  isValidMediaName,
  MAX_MEDIA_BYTES,
  MAX_MEDIA_PREVIEW_BYTES,
  MEDIA_DIR,
  mediaFileName,
  mediaKindOf,
  type PlanMediaDto
} from '../../shared/planningMedia'
import { PlanningValidationError } from './planningModel'
import { atomicWrite, PlanNotFoundError, resolvePlanPath } from './planningStore'
import { forgetOwnWrite, recordOwnWriteHash } from './planningWrites'

/**
 * Mídia do plano: arquivos em <plano>/midia/<nome saneado>. Os cards citam
 * esses nomes em `anexos`; o card do tipo 'midia' é feito só deles.
 *
 * - Todo caminho passa por resolvePlanPath (nome inválido, symlink para fora e
 *   slug inválido são recusados).
 * - Importar grava de forma atômica (tmp + rename) e registra a gravação como
 *   própria (planningWrites), então o vigia não recarrega a tela pelo eco. A
 *   pasta midia/ NÃO é ignorada pelo vigia: mídia que chega por fora recarrega.
 * - Nada aqui apaga arquivo: mídia órfã fica até alguém removê-la à mão.
 */

/** Origem de uma importação: bytes (imagem colada) ou arquivo em disco (arrastado). */
export type MediaSource = { name: string; data: Uint8Array } | { path: string; name?: string }

export interface ImportMediaOptions {
  /** Prefixo de 6 hex do nome; injetável para testar colisão. */
  randomPrefix?: () => string
  /** Teto da importação (padrão MAX_MEDIA_BYTES); só testes mudam. */
  maxBytes?: number
}

export interface MediaContent {
  mediaType: string
  base64: string
  size: number
}

const MAX_NAME_ATTEMPTS = 8

function defaultPrefix(): string {
  return randomBytes(3).toString('hex')
}

function toDto(name: string, file: string, size: number): PlanMediaDto {
  return { name, path: file, kind: mediaKindOf(name), size, mediaType: mimeForExt(extOf(name)) }
}

function tooBig(size: number, max: number): PlanningValidationError {
  const mb = (n: number): string => `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`
  return new PlanningValidationError(`arquivo grande demais: ${mb(size)} (máximo ${mb(max)})`)
}

async function assertPlanExists(projectCwd: string, slug: string): Promise<void> {
  const roteiro = await resolvePlanPath(projectCwd, slug, '_roteiro.md')
  try {
    await fs.access(roteiro)
  } catch {
    // Sem isso, importar criaria uma pasta de plano solta.
    throw new PlanNotFoundError(slug)
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/** Caminho livre em midia/ para `original`: sorteia outro prefixo se o nome já existe. */
async function freeTarget(
  projectCwd: string,
  slug: string,
  original: string,
  prefix: () => string
): Promise<{ name: string; file: string }> {
  for (let i = 0; i < MAX_NAME_ATTEMPTS; i++) {
    const name = mediaFileName(original, prefix())
    const file = await resolvePlanPath(projectCwd, slug, MEDIA_DIR, name)
    if (!(await exists(file))) return { name, file }
  }
  throw new Error('não foi possível escolher um nome livre para a mídia')
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Copia `src` para `file` via tmp + rename, sem carregar o arquivo inteiro na memória. */
async function atomicCopy(src: string, file: string, maxBytes: number): Promise<number> {
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.copyFile(src, tmp)
    // A origem pode ter crescido entre o stat e a cópia.
    const { size } = await fs.stat(tmp)
    if (size > maxBytes) throw tooBig(size, maxBytes)
    recordOwnWriteHash(file, await hashFile(tmp))
    await fs.rename(tmp, file)
    return size
  } catch (err) {
    forgetOwnWrite(file)
    await fs.rm(tmp, { force: true })
    throw err
  }
}

/**
 * Importa um arquivo para <plano>/midia/ com nome saneado (mediaFileName) e
 * devolve o DTO. A origem por caminho tem de ser absoluta e arquivo comum; as
 * duas origens respeitam MAX_MEDIA_BYTES.
 */
export async function importMedia(
  projectCwd: string,
  slug: string,
  src: MediaSource,
  opts: ImportMediaOptions = {}
): Promise<PlanMediaDto> {
  const maxBytes = opts.maxBytes ?? MAX_MEDIA_BYTES
  const prefix = opts.randomPrefix ?? defaultPrefix
  await assertPlanExists(projectCwd, slug)
  let original: string
  if ('data' in src) {
    if (!(src.data instanceof Uint8Array)) throw new PlanningValidationError('dados da mídia inválidos')
    if (src.data.byteLength > maxBytes) throw tooBig(src.data.byteLength, maxBytes)
    original = String(src.name ?? '')
  } else {
    if (typeof src.path !== 'string' || !path.isAbsolute(src.path)) {
      throw new PlanningValidationError('caminho da mídia deve ser absoluto')
    }
    const stat = await fs.stat(src.path)
    if (!stat.isFile()) throw new PlanningValidationError(`não é um arquivo comum: ${src.path}`)
    if (stat.size > maxBytes) throw tooBig(stat.size, maxBytes)
    original = src.name ?? path.basename(src.path)
  }
  await fs.mkdir(await resolvePlanPath(projectCwd, slug, MEDIA_DIR), { recursive: true })
  const { name, file } = await freeTarget(projectCwd, slug, original, prefix)
  if ('data' in src) {
    await atomicWrite(file, src.data)
    return toDto(name, file, src.data.byteLength)
  }
  return toDto(name, file, await atomicCopy(src.path, file, maxBytes))
}

/** As mídias de <plano>/midia/: só arquivos comuns com nome válido, em ordem de nome. */
export async function listMedia(projectCwd: string, slug: string): Promise<PlanMediaDto[]> {
  const dir = await resolvePlanPath(projectCwd, slug, MEDIA_DIR)
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: PlanMediaDto[] = []
  for (const e of entries) {
    if (!e.isFile() || !isValidMediaName(e.name)) continue
    const file = await resolvePlanPath(projectCwd, slug, MEDIA_DIR, e.name)
    try {
      out.push(toDto(e.name, file, (await fs.stat(file)).size))
    } catch (err) {
      // Apagado entre o readdir e o stat: não entra.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** Bytes de uma mídia em base64 (pré-visualização), até MAX_MEDIA_PREVIEW_BYTES. */
export async function readMedia(projectCwd: string, slug: string, name: string): Promise<MediaContent> {
  if (!isValidMediaName(name)) throw new PlanningValidationError(`nome de mídia inválido: ${String(name)}`)
  const file = await resolvePlanPath(projectCwd, slug, MEDIA_DIR, name)
  const stat = await fs.lstat(file)
  if (!stat.isFile()) throw new PlanningValidationError(`não é um arquivo comum: ${name}`)
  if (stat.size > MAX_MEDIA_PREVIEW_BYTES) throw tooBig(stat.size, MAX_MEDIA_PREVIEW_BYTES)
  const bytes = await fs.readFile(file)
  return { mediaType: mimeForExt(extOf(name)), base64: bytes.toString('base64'), size: bytes.length }
}
