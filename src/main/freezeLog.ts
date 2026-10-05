// Log persistente das travadas da tela: uma linha JSON por registro em
// <userData>/logs/travadas.log. Os registros vêm em lote do renderer
// (renderer/perf/freezeWatch.ts) — quadros longos, trechos cronometrados e
// trocas lentas — e é com eles que se descobre, depois, o que congelou a UI.
//
// Mesmas regras do sessionLog.ts: nunca lança, não bloqueia o main (escrita
// assíncrona, em fila) e só grava o que passa pela sanitização abaixo — o lote
// chega pela fronteira IPC, então nada dele é confiável. Nunca texto de
// mensagem, título nem caminho completo. Sem `initFreezeLog`, é no-op.
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Acima disto o arquivo vira `travadas.1.log` (o anterior é sobrescrito). */
export const FREEZE_LOG_MAX_BYTES = 2 * 1024 * 1024
/** Registros aproveitados por lote; o resto é descartado. */
export const FREEZE_LOG_MAX_BATCH = 50

const MAX_STRING = 120
const MAX_FUNCTION = 80
const MAX_SCRIPTS = 3
const KINDS = new Set(['quadro', 'trecho', 'troca'])
const LABELS = new Set(['salvamento', 'celular', 'escritorio'])
const TARGETS = new Set(['conversa', 'aba', 'painel'])

type Raw = Record<string, unknown>

const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const text = (value: unknown, max = MAX_STRING): string | undefined =>
  typeof value === 'string' && value ? value.slice(0, max) : undefined
/** Só o nome do arquivo: corta query/hash e qualquer pasta (/ ou \). */
const fileName = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  return text(value.split(/[?#]/)[0].split(/[\\/]/).pop())
}
const round1 = (n: number): number => Math.round(n * 10) / 10
/** Linha/coluna: inteiro finito ≥ 0. */
const position = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0

function sanitizeScript(raw: unknown): Raw | null {
  if (!isObject(raw) || !finite(raw.ms) || raw.ms < 0) return null
  const out: Raw = {}
  const invoker = text(raw.invoker)
  if (invoker) out.invoker = invoker
  const invokerType = text(raw.invokerType)
  if (invokerType) out.invokerType = invokerType
  const fn = text(raw.sourceFunctionName, MAX_FUNCTION)
  if (fn) out.sourceFunctionName = fn
  const file = fileName(raw.sourceFile)
  if (file) out.sourceFile = file
  if (finite(raw.sourceCharPosition)) out.sourceCharPosition = Math.round(raw.sourceCharPosition)
  if (position(raw.sourceLine)) out.sourceLine = raw.sourceLine
  if (position(raw.sourceColumn)) out.sourceColumn = raw.sourceColumn
  const stack = text(raw.stack)
  if (stack) out.stack = stack
  out.ms = Math.round(raw.ms)
  return out
}

function sanitizeContext(raw: unknown): Raw | undefined {
  if (!isObject(raw)) return undefined
  const out: Raw = {}
  const tab = text(raw.tab)
  if (tab) out.tab = tab
  const convId = text(raw.convId)
  if (convId) out.convId = convId
  if (finite(raw.busy)) out.busy = Math.max(0, Math.round(raw.busy))
  if (typeof raw.office === 'boolean') out.office = raw.office
  if (typeof raw.remote === 'boolean') out.remote = raw.remote
  return out
}

/** Um registro do lote: só campos conhecidos, tipos certos, tamanhos limitados.
 *  Sem `kind` conhecido ou sem `ms` finito, o registro é descartado (null). */
export function sanitizeFreezeRecord(raw: unknown): Raw | null {
  if (!isObject(raw) || typeof raw.kind !== 'string' || !KINDS.has(raw.kind)) return null
  if (!finite(raw.ms) || raw.ms < 0) return null
  const at = finite(raw.at) && raw.at > 0 ? new Date(raw.at) : new Date()
  const out: Raw = { at: Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString(), kind: raw.kind, ms: Math.round(raw.ms) }
  if (raw.kind === 'trecho') {
    if (typeof raw.label !== 'string' || !LABELS.has(raw.label)) return null
    out.label = raw.label
    if (finite(raw.conversations)) out.conversations = Math.max(0, Math.round(raw.conversations))
    if (finite(raw.mb)) out.mb = Math.max(0, Math.round(raw.mb * 100) / 100)
  } else if (raw.kind === 'troca') {
    if (typeof raw.target !== 'string' || !TARGETS.has(raw.target)) return null
    out.target = raw.target
  } else {
    if (finite(raw.blockingMs)) out.blockingMs = Math.max(0, round1(raw.blockingMs))
    if (finite(raw.jsMs) && raw.jsMs >= 0) out.jsMs = Math.round(raw.jsMs)
    if (finite(raw.layoutMs) && raw.layoutMs >= 0) out.layoutMs = Math.round(raw.layoutMs)
    if (Array.isArray(raw.scripts)) {
      const scripts = raw.scripts.slice(0, MAX_SCRIPTS).map(sanitizeScript).filter((s): s is Raw => s !== null)
      if (scripts.length) out.scripts = scripts
    }
  }
  const ctx = sanitizeContext(raw.ctx)
  if (ctx) out.ctx = ctx
  return out
}

/** O lote inteiro: não-array vira vazio; no máximo `FREEZE_LOG_MAX_BATCH`. */
export function sanitizeFreezeBatch(batch: unknown): Raw[] {
  if (!Array.isArray(batch)) return []
  return batch
    .slice(0, FREEZE_LOG_MAX_BATCH)
    .map(sanitizeFreezeRecord)
    .filter((record): record is Raw => record !== null)
}

let target: { dir: string; file: string; rotated: string; maxBytes: number } | null = null
let queue: Promise<void> = Promise.resolve()
let warned = false

/** Liga o log em `<userDataDir>/logs/travadas.log`. Chamado uma vez no boot. */
export function initFreezeLog(userDataDir: string, options: { maxBytes?: number } = {}): void {
  try {
    const dir = join(userDataDir, 'logs')
    target = {
      dir,
      file: join(dir, 'travadas.log'),
      rotated: join(dir, 'travadas.1.log'),
      maxBytes: options.maxBytes ?? FREEZE_LOG_MAX_BYTES
    }
  } catch {
    target = null
  }
}

async function write(to: NonNullable<typeof target>, chunk: string): Promise<void> {
  await mkdir(to.dir, { recursive: true })
  const size = await stat(to.file).then((info) => info.size, () => 0)
  if (size > 0 && size + Buffer.byteLength(chunk) > to.maxBytes) await rename(to.file, to.rotated)
  await appendFile(to.file, chunk, 'utf8')
}

/** Grava um lote vindo do renderer. Nunca lança; a escrita acontece em fila. */
export function logFreezes(batch: unknown): void {
  const to = target
  if (!to) return
  try {
    const records = sanitizeFreezeBatch(batch)
    if (!records.length) return
    const chunk = records.map((record) => `${JSON.stringify(record)}\n`).join('')
    queue = queue.then(() => write(to, chunk)).catch((error: unknown) => {
      if (warned) return
      warned = true
      console.warn('[freeze-log] falha ao gravar (as próximas falhas ficam caladas):', error)
    })
  } catch {
    /* nunca lança */
  }
}

/** Espera as escritas em fila (testes e encerramento). */
export function flushFreezeLog(): Promise<void> {
  return queue
}
