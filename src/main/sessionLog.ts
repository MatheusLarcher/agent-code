// Log persistente do ciclo de vida das sessões do agente: uma linha JSON por
// evento em <userData>/logs/sessions.log. É o que permite reconstruir, depois,
// por que uma sessão sumiu (trocada pelo Automático, descartada, travada, lease
// perdido) — o console do main não sobrevive ao fechamento do app.
//
// Regras: nunca lança (um log com defeito não pode derrubar sessão nenhuma),
// nunca grava texto de mensagem nem segredo (só os campos de `SessionLogFields`,
// conferidos em tempo de execução) e não bloqueia o main (escrita assíncrona,
// em fila). Sem `initSessionLog` (testes, antes do app pronto), é no-op.
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Acima disto o arquivo vira `sessions.1.log` (o anterior é sobrescrito). */
export const SESSION_LOG_MAX_BYTES = 5 * 1024 * 1024

export type SessionLogEvent =
  | 'session-start'
  /** A sessão viva foi trocada por outra (o motivo vai em `reason`). */
  | 'session-replaced'
  /** A sessão foi descartada sem substituta (agent:dispose, lease perdido). */
  | 'session-disposed'
  /** O agent:start manteve a sessão viva porque havia trabalho em background. */
  | 'session-kept'
  | 'session-stop'
  | 'stall-warn'
  | 'stall-abort'
  /** O stream do SDK acabou com o turno aberto (lançando ou não). */
  | 'stream-ended'
  | 'turn-error'
  | 'lease-lost'

export type SessionLogReason =
  | 'auto-pair'
  | 'config'
  | 'dead'
  | 'mcp-model'
  | 'failover'
  | 'background'
  | 'stop'
  | 'dispose'
  | 'lease-lost'

/** Tudo o que pode ir para o arquivo. Nenhum campo de texto livre. */
export interface SessionLogFields {
  convId?: string
  reason?: SessionLogReason
  model?: string
  effort?: string
  account?: string
  resume?: boolean
  background?: boolean
  incomplete?: boolean
  retryable?: boolean
  usageExhausted?: boolean
  threw?: boolean
  toolInFlight?: boolean
  /** agent:start manteve a sessão (background) com pasta / config MCP diferentes. */
  cwdChanged?: boolean
  mcpChanged?: boolean
  idleMs?: number
  turnIds?: readonly string[]
}

const STRING_KEYS = ['convId', 'reason', 'model', 'effort', 'account'] as const
const BOOLEAN_KEYS = ['resume', 'background', 'incomplete', 'retryable', 'usageExhausted', 'threw', 'toolInFlight', 'cwdChanged', 'mcpChanged'] as const
const MAX_STRING = 120
const MAX_IDS = 16

/** Só os campos conhecidos, com o tipo certo e tamanho limitado. */
export function sanitizeSessionLogFields(fields: SessionLogFields): Record<string, unknown> {
  const raw = fields as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of STRING_KEYS) {
    if (typeof raw[key] === 'string') out[key] = (raw[key] as string).slice(0, MAX_STRING)
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key]
  }
  if (typeof raw.idleMs === 'number' && Number.isFinite(raw.idleMs)) out.idleMs = Math.round(raw.idleMs)
  if (Array.isArray(raw.turnIds)) {
    out.turnIds = raw.turnIds
      .filter((id): id is string => typeof id === 'string')
      .slice(-MAX_IDS)
      .map((id) => id.slice(0, 64))
  }
  return out
}

let target: { dir: string; file: string; rotated: string; maxBytes: number } | null = null
let queue: Promise<void> = Promise.resolve()
let warned = false

/** Liga o log em `<userDataDir>/logs/sessions.log`. Chamado uma vez no boot. */
export function initSessionLog(userDataDir: string, options: { maxBytes?: number } = {}): void {
  try {
    const dir = join(userDataDir, 'logs')
    target = {
      dir,
      file: join(dir, 'sessions.log'),
      rotated: join(dir, 'sessions.1.log'),
      maxBytes: options.maxBytes ?? SESSION_LOG_MAX_BYTES
    }
  } catch {
    target = null
  }
}

async function write(to: NonNullable<typeof target>, line: string): Promise<void> {
  await mkdir(to.dir, { recursive: true })
  const size = await stat(to.file).then((info) => info.size, () => 0)
  if (size > 0 && size + Buffer.byteLength(line) > to.maxBytes) await rename(to.file, to.rotated)
  await appendFile(to.file, line, 'utf8')
}

/** Registra um evento. Nunca lança; a escrita acontece em fila, fora deste tick. */
export function logSession(event: SessionLogEvent, fields: SessionLogFields = {}): void {
  const to = target
  if (!to) return
  try {
    const line = `${JSON.stringify({ at: new Date().toISOString(), event, ...sanitizeSessionLogFields(fields) })}\n`
    queue = queue.then(() => write(to, line)).catch((error: unknown) => {
      if (warned) return
      warned = true
      console.warn('[session-log] falha ao gravar (as próximas falhas ficam caladas):', error)
    })
  } catch {
    /* nunca lança */
  }
}

/** Espera as escritas em fila (testes e encerramento). */
export function flushSessionLog(): Promise<void> {
  return queue
}
