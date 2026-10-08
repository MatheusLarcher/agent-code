/**
 * Mescla da Central entre os dois PCs. A Central é UMA linha no banco (id fixo),
 * gravada pelos dois; cada entrada tem um único dono — o PC que a criou — e só ele
 * a muda ou apaga. Puro e compartilhado: a fila de gravação (main) mescla na
 * gravação e no conflito de revisão; a tela, no feed de mudanças.
 */
import { MAX_CENTRAL_ENTRIES, type CentralEntry, type CentralState } from './central'

/** O mínimo de uma conversa que a mescla lê. */
export interface CentralCarrier {
  updatedAt: number
  central?: CentralState
}

/* ---- validação do payload (o banco pode ter escrita de outra versão) ---- */

const REQUEST_STATES: ReadonlySet<string> = new Set(['routing', 'asking', 'delivered', 'failed'])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

/** Só o que a tela lê de cada tipo; campos opcionais novos passam como vierem. */
function isCentralEntry(v: unknown): v is CentralEntry {
  if (!isRecord(v) || typeof v.id !== 'string' || !v.id || typeof v.ts !== 'number' || !Number.isFinite(v.ts)) {
    return false
  }
  switch (v.kind) {
    case 'request':
      return (
        typeof v.text === 'string' &&
        typeof v.state === 'string' &&
        REQUEST_STATES.has(v.state) &&
        (v.attachments === undefined || isStringList(v.attachments))
      )
    case 'reply':
      return (
        typeof v.requestId === 'string' &&
        isRecord(v.anchor) &&
        typeof v.anchor.convId === 'string' &&
        typeof v.anchor.msgId === 'string' &&
        isStringList(v.notes) &&
        isRecord(v.activity) &&
        typeof v.done === 'boolean'
      )
    case 'question':
      return typeof v.convId === 'string' && typeof v.question === 'string' && typeof v.answer === 'string'
    default:
      return false
  }
}

/** Estado da Central vindo do banco: entrada torta sai (uma não derruba a tela), e vale o teto. */
export function normalizeCentralState(value: unknown): CentralState {
  if (!isRecord(value) || !Array.isArray(value.entries)) return { entries: [] }
  return { entries: value.entries.filter(isCentralEntry).slice(-MAX_CENTRAL_ENTRIES) }
}

/* ---- mescla ---- */

/** O `device` da entrada (installationId de quem a criou). */
function deviceOf(entry: CentralEntry | undefined): string | undefined {
  const device = (entry as { device?: unknown } | undefined)?.device
  return typeof device === 'string' && device ? device : undefined
}

function entriesOf(conv: CentralCarrier): CentralEntry[] {
  return Array.isArray(conv.central?.entries) ? conv.central.entries : []
}

/** Por id; a primeira ocorrência vale. */
function byId(entries: CentralEntry[]): Map<string, CentralEntry> {
  const map = new Map<string, CentralEntry>()
  for (const entry of entries) if (!map.has(entry.id)) map.set(entry.id, entry)
  return map
}

/** O mais novo dos dois `updatedAt` (um inválido não vence). */
function newest(local: number, remote: number): number {
  if (!Number.isFinite(remote)) return local
  if (!Number.isFinite(local)) return remote
  return Math.max(local, remote)
}

/**
 * Junta a Central local (a da tela, ou o payload que vai ser gravado) com a remota
 * (a do banco), por dono da entrada:
 * - deste PC (`self`): exatamente as locais — a que falta aqui foi apagada ou
 *   cortada aqui, e continua fora;
 * - de outro PC: exatamente as remotas — ele é o único que as escreve (a que falta
 *   lá ele apagou);
 * - sem dono (legado, ou `self` desconhecido): união por id, a versão local vence.
 * Dono = `device` da entrada; a resposta sem `device` herda o do seu pedido. Nas
 * duas versões de um mesmo id, decide a local, senão a remota — um id nunca some
 * nem duplica. Resultado em ordem de `ts` (empate: a ordem local, depois a remota),
 * cortado nas MAX_CENTRAL_ENTRIES mais novas; o resto da conversa vem da local, com
 * o `updatedAt` mais novo dos dois. Não muda as entradas; nada a mudar = a própria
 * local.
 */
export function mergeCentralConversation<T extends CentralCarrier>(
  local: T,
  remote: CentralCarrier,
  self: string | null | undefined
): T {
  const mine = entriesOf(local)
  const theirs = entriesOf(remote)
  const localById = byId(mine)
  const remoteById = byId(theirs)
  // Dono de cada pedido, para a resposta sem `device` (o pedido pode estar de um lado só).
  const requestOwner = new Map<string, string>()
  for (const entry of [...theirs, ...mine]) {
    const device = deviceOf(entry)
    if (entry.kind === 'request' && device) requestOwner.set(entry.id, device)
  }
  const ownerOf = (entry: CentralEntry | undefined): string | undefined =>
    deviceOf(entry) ?? (entry?.kind === 'reply' ? requestOwner.get(entry.requestId) : undefined)
  const pick = (id: string): CentralEntry | undefined => {
    const here = localById.get(id)
    const there = remoteById.get(id)
    const owner = self ? ownerOf(here) ?? ownerOf(there) : undefined
    if (!owner) return here ?? there
    return owner === self ? here : there
  }
  const entries = [...new Set([...localById.keys(), ...remoteById.keys()])]
    .map(pick)
    .filter((entry): entry is CentralEntry => entry !== undefined)
    .sort((a, b) => a.ts - b.ts)
    .slice(-MAX_CENTRAL_ENTRIES)
  const updatedAt = newest(local.updatedAt, remote.updatedAt)
  const unchanged =
    updatedAt === local.updatedAt && entries.length === mine.length && entries.every((e, i) => e === mine[i])
  return unchanged ? local : { ...local, updatedAt, central: { ...local.central, entries } }
}
