import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import type {
  ContextBlock,
  ContextBlockRef,
  ContextSecretMask,
  ContextTurnDetail,
  ContextTurnModel,
  ContextTurnSummary,
  ContextUsageSnapshot
} from '../../shared/contextSnapshot'
import { StorageError, type ContextTurnWrite } from './types'

/**
 * Parte comum às duas pontas do histórico do contexto (`context_turn` +
 * `context_blob`): o que vai para o banco e como volta. O SQL de cada dialeto
 * mora em sqliteContextHistory.ts / postgresContextHistory.ts.
 *
 * Os textos já chegam MASCARADOS (ver `ContextTurnWrite`); aqui eles só são
 * comprimidos e endereçados pelo conteúdo, nunca inspecionados.
 */

const PROVIDERS: ReadonlySet<ContextTurnSummary['provider']> = new Set(['claude', 'gpt', 'ollama'])

/** Blob a gravar uma vez só (chave = `hash`). */
export interface ContextBlobInsert {
  hash: string
  gz: Buffer
  bytes: number
}

/** O turno pronto para gravar: referências sem texto + blobs distintos. */
export interface PreparedContextTurn {
  write: ContextTurnWrite
  blocksJson: string
  memoriesJson: string
  secretsJson: string
  modelsJson: string
  usageJson: string | null
  blobs: ContextBlobInsert[]
}

/** Só as entradas bem formadas: lista vinda do banco (ou de um chamador) não é confiável. */
export function contextTurnModels(value: unknown): ContextTurnModel[] {
  if (!Array.isArray(value)) return []
  const out: ContextTurnModel[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const { model, calls, node } = entry as Record<string, unknown>
    if (typeof model !== 'string' || !model.trim()) continue
    if (typeof calls !== 'number' || !Number.isSafeInteger(calls) || calls < 1) continue
    if (node !== null && (typeof node !== 'string' || !node)) continue
    out.push({ model, calls, node })
  }
  return out
}

/** sha256 hex do texto (sem prefixo), o mesmo de `ContextBlockRef.hash`. */
export function contextTextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new StorageError('INVALID_PERSISTED_DATA', `${label} inválido no histórico do contexto.`)
  }
  return value
}

export function assertContextIds(convId: unknown, turnId?: unknown): void {
  requireId(convId, 'convId')
  if (turnId !== undefined) requireId(turnId, 'turnId')
}

export function clampContextLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new StorageError('INVALID_PERSISTED_DATA', 'limit inválido no histórico do contexto.')
  }
  return limit
}

/** Valida a escrita e separa texto (blobs comprimidos) de referência. */
export function prepareContextTurn(write: ContextTurnWrite): PreparedContextTurn {
  assertContextIds(write.convId, write.turnId)
  if (!PROVIDERS.has(write.provider)) {
    throw new StorageError('INVALID_PERSISTED_DATA', `Provedor desconhecido no histórico do contexto: ${String(write.provider)}.`)
  }
  if (!Number.isFinite(write.startedAt)) {
    throw new StorageError('INVALID_PERSISTED_DATA', 'startedAt inválido no histórico do contexto.')
  }
  if (!Array.isArray(write.blocks)) {
    throw new StorageError('INVALID_PERSISTED_DATA', 'blocks inválido no histórico do contexto.')
  }
  const blobs = new Map<string, ContextBlobInsert>()
  const refs: ContextBlockRef[] = write.blocks.map((block) => {
    if (!block || typeof block.text !== 'string' || !Number.isFinite(block.at)) {
      throw new StorageError('INVALID_PERSISTED_DATA', 'Bloco inválido no histórico do contexto.')
    }
    const text = block.text
    // O hash do chamador é confiado (ele já o calculou sobre o texto
    // mascarado); só um hash vazio é recalculado aqui.
    const hash = typeof block.hash === 'string' && block.hash ? block.hash : contextTextHash(text)
    const bytes = Buffer.byteLength(text, 'utf8')
    if (!blobs.has(hash)) blobs.set(hash, { hash, gz: gzipSync(Buffer.from(text, 'utf8')), bytes })
    return { kind: block.kind, label: block.label, source: block.source, hash, bytes, at: block.at }
  })
  return {
    write,
    blocksJson: JSON.stringify(refs),
    memoriesJson: JSON.stringify(write.memoriesSent ?? []),
    secretsJson: JSON.stringify((write.secrets ?? []).map((secret) => ({ name: secret.name, length: secret.length }))),
    modelsJson: JSON.stringify(contextTurnModels(write.models)),
    usageJson: write.usage ? JSON.stringify(write.usage) : null,
    blobs: [...blobs.values()]
  }
}

/** Linha de `context_turn` já com os JSON decodificados (cada ponta faz o parse). */
export interface ContextTurnRecord {
  convId: string
  turnId: string
  pc: string
  startedAt: number
  model: string
  provider: string
  request: string
  complete: boolean
  usage: unknown
  blocks: unknown
  memories: unknown
  secrets: unknown
  models: unknown
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function blockRefs(value: unknown): ContextBlockRef[] {
  return asArray(value).filter(
    (entry): entry is ContextBlockRef =>
      !!entry && typeof entry === 'object' && typeof (entry as ContextBlockRef).hash === 'string'
  )
}

export function contextTurnSummary(record: ContextTurnRecord): ContextTurnSummary {
  const refs = blockRefs(record.blocks)
  return {
    convId: record.convId,
    turnId: record.turnId,
    pc: record.pc,
    startedAt: Number(record.startedAt),
    model: record.model,
    models: contextTurnModels(record.models),
    provider: record.provider as ContextTurnSummary['provider'],
    request: record.request,
    blockCount: refs.length,
    totalBytes: refs.reduce((sum, ref) => sum + (Number(ref.bytes) || 0), 0),
    memoriesSent: asArray(record.memories).filter((name): name is string => typeof name === 'string'),
    complete: Boolean(record.complete)
  }
}

/** Hashes distintos que o turno referencia (para buscar só esses blobs). */
export function contextTurnHashes(record: ContextTurnRecord): string[] {
  return [...new Set(blockRefs(record.blocks).map((ref) => ref.hash))]
}

export function inflateContextBlob(gz: Uint8Array): string {
  return gunzipSync(gz).toString('utf8')
}

/**
 * Turno inteiro com os textos. Um blob ausente (não deveria acontecer: a poda
 * só leva órfãos) vira texto vazio em vez de derrubar a tela inteira.
 */
export function contextTurnDetail(record: ContextTurnRecord, texts: ReadonlyMap<string, string>): ContextTurnDetail {
  const blocks: ContextBlock[] = blockRefs(record.blocks).map((ref) => ({
    kind: ref.kind,
    label: ref.label,
    source: ref.source,
    hash: ref.hash,
    bytes: Number(ref.bytes) || 0,
    at: Number(ref.at) || 0,
    text: texts.get(ref.hash) ?? ''
  }))
  const secrets: ContextSecretMask[] = asArray(record.secrets)
    .filter((entry): entry is ContextSecretMask => !!entry && typeof (entry as ContextSecretMask).name === 'string')
    .map((entry) => ({ name: entry.name, length: Number(entry.length) || 0 }))
  const usage = record.usage && typeof record.usage === 'object' ? (record.usage as ContextUsageSnapshot) : null
  return { ...contextTurnSummary(record), blocks, usage, secrets }
}
