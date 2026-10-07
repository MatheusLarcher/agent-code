import { createHash, randomUUID } from 'node:crypto'
import {
  HANDOFF_ENTREGA_STATUSES,
  HANDOFF_ENVIO_STATUSES,
  type HandoffEntrega,
  type HandoffEntregaStatus,
  type HandoffEnvio,
  type HandoffEnvioStatus
} from '../../shared/handoffTracking'
import type {
  HandoffEntregaPatch,
  HandoffEnvioCreate,
  HandoffEnvioPatch,
  HandoffEnvioQuery,
  HandoffTimeAdd
} from '../persistence/types'

/**
 * Regras puras do registro de envios de handoff — o que os dois repositórios
 * (SQLite e PostgreSQL) compartilham: colunas, linha↔objeto, ids, hash do
 * conteúdo, totais e a validação das entradas. Nada aqui toca banco: em duas
 * cópias, as regras divergiriam em silêncio (mesma lição do quadro).
 */

export const HANDOFF_ENVIO_COLUMNS = `
  id, plan_slug, plan_titulo, project_id, project_cwd, conversation_id, conversation_title, arquivo,
  ordem, lote_id, conteudo, conteudo_hash, status, motivo, estimativa_total, prazo_total, atrasado,
  tempo_ativo_ms, retrabalho_ms, criado_em, enviado_em, iniciado_em, concluido_em, updated_at
`

export const HANDOFF_ENTREGA_COLUMNS = `
  id, envio_id, etapa_id, etapa_titulo, ordem, estimativa_plano, estimativa_agente,
  estimativa_agente_motivo, estimativa_agente_em, status, atrasada, motivo, board_item_id, auditada,
  corrigido_por, corrigido_em, iniciada_em, concluida_em, tempo_ativo_ms, tempo_corrido_ms,
  retrabalho_ms, aviso_80_em, aviso_100_em, updated_at
`

/** Teto da estimativa de UMA etapa, em minutos (o mesmo do roteiro). */
export const HANDOFF_MAX_ESTIMATIVA_MIN = 10_000
/** Um prompt declara no máximo este tanto de etapas (`plan_handoff_write`). */
export const HANDOFF_MAX_ENTREGAS = 100
export const HANDOFF_LIST_DEFAULT_LIMIT = 200
export const HANDOFF_LIST_MAX_LIMIT = 1000

/** Inteiro do banco: SQLite devolve number (ou bigint); o `bigint` do pg vem como texto. */
type DbInt = number | bigint | string
/** Booleano do banco: 0/1 no SQLite, boolean no PostgreSQL. */
type DbBool = boolean | number | bigint

/** Linha já decodificada (texto plano, datas em ISO) — o PostgreSQL converte antes. */
export interface HandoffEnvioRow {
  id: string
  plan_slug: string
  plan_titulo: string
  project_id: string
  project_cwd: string
  conversation_id: string
  conversation_title: string
  arquivo: string
  ordem: DbInt
  lote_id: string
  conteudo: string
  conteudo_hash: string
  status: string
  motivo: string | null
  estimativa_total: DbInt | null
  prazo_total: DbInt | null
  atrasado: DbBool
  tempo_ativo_ms: DbInt
  retrabalho_ms: DbInt
  criado_em: string
  enviado_em: string | null
  iniciado_em: string | null
  concluido_em: string | null
  updated_at: string
}

export interface HandoffEntregaRow {
  id: string
  envio_id: string
  etapa_id: string
  etapa_titulo: string
  ordem: DbInt
  estimativa_plano: DbInt | null
  estimativa_agente: DbInt | null
  estimativa_agente_motivo: string | null
  estimativa_agente_em: string | null
  status: string
  atrasada: DbBool
  motivo: string | null
  board_item_id: string | null
  auditada: DbBool | null
  corrigido_por: string | null
  corrigido_em: string | null
  iniciada_em: string | null
  concluida_em: string | null
  tempo_ativo_ms: DbInt
  tempo_corrido_ms: DbInt | null
  retrabalho_ms: DbInt
  aviso_80_em: string | null
  aviso_100_em: string | null
  updated_at: string
}

export function isHandoffEnvioStatus(value: unknown): value is HandoffEnvioStatus {
  return typeof value === 'string' && (HANDOFF_ENVIO_STATUSES as readonly string[]).includes(value)
}

export function isHandoffEntregaStatus(value: unknown): value is HandoffEntregaStatus {
  return typeof value === 'string' && (HANDOFF_ENTREGA_STATUSES as readonly string[]).includes(value)
}

/** sha256 do texto normalizado (CRLF→LF, sem espaço nas pontas): o mesmo
 *  prompt colado no Windows ou vindo do arquivo dá o mesmo hash. */
export function handoffContentHash(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n').trim()).digest('hex')
}

/** Soma das estimativas do plano; `null` quando nenhuma entrega tem estimativa. */
export function handoffEstimativaTotal(entregas: ReadonlyArray<{ estimativaPlano: number | null }>): number | null {
  let total: number | null = null
  for (const entrega of entregas) {
    if (entrega.estimativaPlano !== null) total = (total ?? 0) + entrega.estimativaPlano
  }
  return total
}

export function clampHandoffLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return HANDOFF_LIST_DEFAULT_LIMIT
  return Math.min(HANDOFF_LIST_MAX_LIMIT, Math.max(1, Math.trunc(limit)))
}

function int(value: DbInt): number {
  return Number(value)
}

function nullableInt(value: DbInt | null): number | null {
  return value === null || value === undefined ? null : Number(value)
}

function bool(value: DbBool): boolean {
  return value === true || Number(value) === 1
}

export function handoffEntregaFromRow(row: HandoffEntregaRow): HandoffEntrega {
  return {
    id: String(row.id),
    envioId: String(row.envio_id),
    etapaId: String(row.etapa_id),
    etapaTitulo: String(row.etapa_titulo ?? ''),
    ordem: int(row.ordem),
    estimativaPlano: nullableInt(row.estimativa_plano),
    estimativaAgente: nullableInt(row.estimativa_agente),
    estimativaAgenteMotivo: row.estimativa_agente_motivo ?? null,
    estimativaAgenteEm: row.estimativa_agente_em ?? null,
    status: isHandoffEntregaStatus(row.status) ? row.status : 'pendente',
    atrasada: bool(row.atrasada),
    motivo: row.motivo ?? null,
    boardItemId: row.board_item_id ?? null,
    auditada: row.auditada === null || row.auditada === undefined ? null : bool(row.auditada),
    corrigidoPor: row.corrigido_por === 'usuario' ? 'usuario' : null,
    corrigidoEm: row.corrigido_em ?? null,
    iniciadaEm: row.iniciada_em ?? null,
    concluidaEm: row.concluida_em ?? null,
    tempoAtivoMs: int(row.tempo_ativo_ms),
    tempoCorridoMs: nullableInt(row.tempo_corrido_ms),
    retrabalhoMs: int(row.retrabalho_ms),
    aviso80Em: row.aviso_80_em ?? null,
    aviso100Em: row.aviso_100_em ?? null,
    updatedAt: String(row.updated_at)
  }
}

/** `entregas` são as do envio, em qualquer ordem: saem por `ordem`. */
export function handoffEnvioFromRow(row: HandoffEnvioRow, entregas: HandoffEntrega[]): HandoffEnvio {
  return {
    id: String(row.id),
    planSlug: String(row.plan_slug),
    planTitulo: String(row.plan_titulo ?? ''),
    projectId: String(row.project_id),
    projectCwd: String(row.project_cwd),
    conversationId: String(row.conversation_id),
    conversationTitle: String(row.conversation_title ?? ''),
    arquivo: String(row.arquivo),
    ordem: int(row.ordem),
    loteId: String(row.lote_id),
    conteudo: String(row.conteudo ?? ''),
    conteudoHash: String(row.conteudo_hash),
    status: isHandoffEnvioStatus(row.status) ? row.status : 'na_fila',
    motivo: row.motivo ?? null,
    estimativaTotal: nullableInt(row.estimativa_total),
    prazoTotal: nullableInt(row.prazo_total),
    atrasado: bool(row.atrasado),
    tempoAtivoMs: int(row.tempo_ativo_ms),
    retrabalhoMs: int(row.retrabalho_ms),
    criadoEm: String(row.criado_em),
    enviadoEm: row.enviado_em ?? null,
    iniciadoEm: row.iniciado_em ?? null,
    concluidoEm: row.concluido_em ?? null,
    updatedAt: String(row.updated_at),
    entregas: [...entregas].sort((a, b) => a.ordem - b.ordem || a.id.localeCompare(b.id))
  }
}

// ---------------------------------------------------------------------------
// Validação das entradas
// ---------------------------------------------------------------------------

function requireText(value: unknown, campo: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${campo} é obrigatório.`)
  return value
}

function requireString(value: unknown, campo: string): string {
  if (typeof value !== 'string') throw new TypeError(`${campo} precisa ser texto.`)
  return value
}

function minutos(value: unknown, campo: string): number | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > HANDOFF_MAX_ESTIMATIVA_MIN) {
    throw new TypeError(`${campo} precisa ser um inteiro de 1 a ${HANDOFF_MAX_ESTIMATIVA_MIN} (minutos).`)
  }
  return value as number
}

function milissegundos(value: unknown, campo: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${campo} precisa ser um inteiro >= 0 (ms).`)
  }
  return value as number
}

/** Envio pronto para INSERT, sem os carimbos (cada backend usa o próprio relógio). */
export interface PreparedHandoffEnvio {
  id: string
  planSlug: string
  planTitulo: string
  projectId: string
  projectCwd: string
  conversationId: string
  conversationTitle: string
  arquivo: string
  ordem: number
  loteId: string
  conteudo: string
  conteudoHash: string
  estimativaTotal: number | null
  prazoTotal: number | null
  entregas: { id: string; etapaId: string; etapaTitulo: string; ordem: number; estimativaPlano: number | null }[]
}

/** Valida um envio e gera ids, hash e totais. O status inicial é sempre `na_fila`. */
export function prepareHandoffEnvio(input: HandoffEnvioCreate): PreparedHandoffEnvio {
  if (!input || typeof input !== 'object') throw new TypeError('Envio de handoff inválido.')
  if (!Number.isSafeInteger(input.ordem) || input.ordem < 1) throw new TypeError('ordem precisa ser um inteiro >= 1.')
  if (!Array.isArray(input.entregas)) throw new TypeError('entregas precisa ser uma lista.')
  if (input.entregas.length > HANDOFF_MAX_ENTREGAS) {
    throw new TypeError(`Um envio tem no máximo ${HANDOFF_MAX_ENTREGAS} entregas.`)
  }
  const etapas = new Set<string>()
  const entregas = input.entregas.map((entrega, index) => {
    const etapaId = requireText(entrega?.etapaId, 'etapaId')
    if (etapas.has(etapaId)) throw new TypeError(`Etapa repetida no envio: ${etapaId}`)
    etapas.add(etapaId)
    return {
      id: `hn-${randomUUID()}`,
      etapaId,
      etapaTitulo: requireString(entrega.etapaTitulo, 'etapaTitulo'),
      ordem: index + 1,
      estimativaPlano: minutos(entrega.estimativaPlano ?? null, 'estimativaPlano')
    }
  })
  const conteudo = requireText(input.conteudo, 'conteudo')
  const total = handoffEstimativaTotal(entregas)
  return {
    id: `he-${randomUUID()}`,
    planSlug: requireText(input.planSlug, 'planSlug'),
    planTitulo: requireString(input.planTitulo, 'planTitulo'),
    projectId: requireText(input.projectId, 'projectId'),
    projectCwd: requireText(input.projectCwd, 'projectCwd'),
    conversationId: requireText(input.conversationId, 'conversationId'),
    conversationTitle: requireString(input.conversationTitle, 'conversationTitle'),
    arquivo: requireText(input.arquivo, 'arquivo'),
    ordem: input.ordem,
    loteId: requireText(input.loteId, 'loteId'),
    conteudo,
    conteudoHash: handoffContentHash(conteudo),
    estimativaTotal: total,
    prazoTotal: total,
    entregas
  }
}

/** Filtros validados; lista vazia num filtro = nenhum resultado (`empty`). */
export interface NormalizedHandoffQuery {
  empty: boolean
  ids?: string[]
  conversationId?: string
  projectIds?: string[]
  statuses?: HandoffEnvioStatus[]
  limit: number
}

function textList(value: unknown, campo: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${campo} precisa ser uma lista.`)
  return value.map((item) => requireText(item, campo))
}

export function normalizeHandoffQuery(query: HandoffEnvioQuery = {}): NormalizedHandoffQuery {
  const out: NormalizedHandoffQuery = { empty: false, limit: clampHandoffLimit(query.limit) }
  if (query.ids !== undefined) out.ids = textList(query.ids, 'ids')
  if (query.conversationId !== undefined) out.conversationId = requireText(query.conversationId, 'conversationId')
  if (query.projectIds !== undefined) out.projectIds = textList(query.projectIds, 'projectIds')
  if (query.statuses !== undefined) {
    if (!Array.isArray(query.statuses)) throw new TypeError('statuses precisa ser uma lista.')
    for (const status of query.statuses) {
      if (!isHandoffEnvioStatus(status)) throw new TypeError(`Status de envio inválido: ${String(status)}`)
    }
    out.statuses = [...query.statuses]
  }
  out.empty = out.ids?.length === 0 || out.projectIds?.length === 0 || out.statuses?.length === 0
  return out
}

// ---------------------------------------------------------------------------
// Patches: chave do objeto → coluna, já validada. `text` marca o texto livre
// (o PostgreSQL o escapa com encodePostgresText; ids e datas não passam por lá).
// ---------------------------------------------------------------------------

export interface HandoffColumnWrite {
  column: string
  value: string | number | boolean | null
  text: boolean
}

type PatchKind =
  | 'envioStatus'
  | 'entregaStatus'
  | 'title'
  | 'note'
  | 'time'
  | 'boolean'
  | 'nullableBoolean'
  | 'id'
  | 'corrigidoPor'
  | 'minutes'
  | 'ms'
  | 'ordem'
  | 'content'
  | 'hash'

/** O mesmo teto do conteúdo de um prompt registrado (handoffIpc). */
const MAX_CONTEUDO_CHARS = 1_000_000

const ENVIO_PATCH: Record<keyof HandoffEnvioPatch, [string, PatchKind]> = {
  status: ['status', 'envioStatus'],
  motivo: ['motivo', 'note'],
  enviadoEm: ['enviado_em', 'time'],
  iniciadoEm: ['iniciado_em', 'time'],
  concluidoEm: ['concluido_em', 'time'],
  atrasado: ['atrasado', 'boolean'],
  conversationTitle: ['conversation_title', 'title'],
  // A faixa "Próximos prompts": reordenar e editar o prompt que ainda não saiu.
  ordem: ['ordem', 'ordem'],
  conteudo: ['conteudo', 'content'],
  conteudoHash: ['conteudo_hash', 'hash']
}

const ENTREGA_PATCH: Record<keyof HandoffEntregaPatch, [string, PatchKind]> = {
  status: ['status', 'entregaStatus'],
  motivo: ['motivo', 'note'],
  atrasada: ['atrasada', 'boolean'],
  boardItemId: ['board_item_id', 'id'],
  auditada: ['auditada', 'nullableBoolean'],
  corrigidoPor: ['corrigido_por', 'corrigidoPor'],
  corrigidoEm: ['corrigido_em', 'time'],
  iniciadaEm: ['iniciada_em', 'time'],
  concluidaEm: ['concluida_em', 'time'],
  tempoCorridoMs: ['tempo_corrido_ms', 'ms'],
  estimativaAgente: ['estimativa_agente', 'minutes'],
  estimativaAgenteMotivo: ['estimativa_agente_motivo', 'note'],
  estimativaAgenteEm: ['estimativa_agente_em', 'time'],
  aviso80Em: ['aviso_80_em', 'time'],
  aviso100Em: ['aviso_100_em', 'time']
}

function patchValue(key: string, kind: PatchKind, value: unknown): HandoffColumnWrite['value'] {
  switch (kind) {
    case 'envioStatus':
      if (!isHandoffEnvioStatus(value)) throw new TypeError(`Status de envio inválido: ${String(value)}`)
      return value
    case 'entregaStatus':
      if (!isHandoffEntregaStatus(value)) throw new TypeError(`Status de entrega inválido: ${String(value)}`)
      return value
    case 'title':
      return requireString(value, key)
    case 'note': {
      // Texto vazio limpa o campo, como no quadro.
      if (value === null) return null
      const trimmed = requireString(value, key).trim()
      return trimmed ? trimmed : null
    }
    case 'time': {
      if (value === null) return null
      const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
      if (!Number.isFinite(parsed)) throw new TypeError(`${key} precisa ser uma data ISO.`)
      return new Date(parsed).toISOString()
    }
    case 'boolean':
      if (typeof value !== 'boolean') throw new TypeError(`${key} precisa ser booleano.`)
      return value
    case 'nullableBoolean':
      if (value !== null && typeof value !== 'boolean') throw new TypeError(`${key} precisa ser booleano ou null.`)
      return value
    case 'id':
      return value === null ? null : requireText(value, key)
    case 'corrigidoPor':
      if (value !== null && value !== 'usuario') throw new TypeError(`${key} só aceita 'usuario' ou null.`)
      return value
    case 'minutes':
      return minutos(value, key)
    case 'ms':
      return value === null ? null : milissegundos(value, key)
    case 'ordem':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new TypeError(`${key} precisa ser inteiro >= 1.`)
      return value
    case 'content': {
      const text = requireString(value, key)
      if (!text.trim() || text.length > MAX_CONTEUDO_CHARS) throw new TypeError(`${key} vazio ou grande demais.`)
      return text
    }
    case 'hash':
      if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new TypeError(`${key} precisa ser um sha256 hex.`)
      return value
  }
}

function patchWrites(patch: object, columns: Record<string, [string, PatchKind]>): HandoffColumnWrite[] {
  if (!patch || typeof patch !== 'object') throw new TypeError('Patch inválido.')
  const writes: HandoffColumnWrite[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const entry = Object.hasOwn(columns, key) ? columns[key] : undefined
    // Campo desconhecido é erro de quem chama (tempo, por exemplo, só entra por
    // addHandoffTime) — ignorar em silêncio esconderia o bug.
    if (!entry) throw new TypeError(`Campo não editável: ${key}`)
    const [column, kind] = entry
    writes.push({ column, value: patchValue(key, kind, value), text: kind === 'title' || kind === 'note' || kind === 'content' })
  }
  return writes
}

export function handoffEnvioPatchWrites(patch: HandoffEnvioPatch): HandoffColumnWrite[] {
  return patchWrites(patch, ENVIO_PATCH)
}

export function handoffEntregaPatchWrites(patch: HandoffEntregaPatch): HandoffColumnWrite[] {
  return patchWrites(patch, ENTREGA_PATCH)
}

export interface NormalizedHandoffTimeAdd {
  envioId: string
  ativoMs: number
  retrabalhoMs: number
  /** Só as entregas com algo a somar. */
  entregas: { id: string; ativoMs: number; retrabalhoMs: number }[]
}

/** Incremento validado. `null` = nada a somar (o repositório nem abre escrita). */
export function normalizeHandoffTimeAdd(input: HandoffTimeAdd): NormalizedHandoffTimeAdd | null {
  if (!input || typeof input !== 'object') throw new TypeError('Incremento de tempo inválido.')
  const envioId = requireText(input.envioId, 'envioId')
  const ativoMs = milissegundos(input.ativoMs ?? 0, 'ativoMs')
  const retrabalhoMs = milissegundos(input.retrabalhoMs ?? 0, 'retrabalhoMs')
  if (input.entregas !== undefined && !Array.isArray(input.entregas)) throw new TypeError('entregas precisa ser uma lista.')
  const entregas = (input.entregas ?? [])
    .map((entrega) => ({
      id: requireText(entrega?.id, 'id da entrega'),
      ativoMs: milissegundos(entrega.ativoMs ?? 0, 'ativoMs'),
      retrabalhoMs: milissegundos(entrega.retrabalhoMs ?? 0, 'retrabalhoMs')
    }))
    .filter((entrega) => entrega.ativoMs > 0 || entrega.retrabalhoMs > 0)
  if (ativoMs === 0 && retrabalhoMs === 0 && entregas.length === 0) return null
  return { envioId, ativoMs, retrabalhoMs, entregas }
}
