/**
 * Regras puras da Tela de Planejamento: formato em disco dos cards
 * (frontmatter + markdown), do roteiro (_roteiro.md) e validação de nomes.
 *
 * Nada aqui toca disco — o planningStore usa estas funções. O frontmatter é
 * um subconjunto de YAML feito à mão: cada valor é gravado como JSON (que
 * também é YAML válido), então o round-trip é exato sem dependência nova.
 */

export const CARD_TYPES = ['etapa', 'requisito', 'decisao', 'sugestao', 'ambiguidade', 'nota'] as const
export type CardType = (typeof CARD_TYPES)[number]

export const AMBIGUITY_STATUSES = ['aberta', 'resolvida'] as const
export type AmbiguityStatus = (typeof AMBIGUITY_STATUSES)[number]

export const STAGE_STATUSES = ['pendente', 'em_andamento', 'concluida'] as const
export type StageStatus = (typeof STAGE_STATUSES)[number]

export interface PlanCard {
  id: string
  tipo: CardType
  titulo: string
  etapa?: string
  status?: string
  links: string[]
  fonte?: string
  rev: number
  corpo: string
}

export interface RoteiroStage {
  id: string
  titulo: string
  status: StageStatus
}

export interface Roteiro {
  titulo: string
  /** Revisão otimista, como a dos cards: gravar exige o rev em disco.
   *  0 = roteiro gravado antes do rev existir (sem a linha de metadado). */
  rev: number
  etapas: RoteiroStage[]
}

export class PlanningValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanningValidationError'
  }
}

const NAME_RE = /^[a-z0-9-]{1,64}$/

/** Slug de planejamento e id de card: [a-z0-9-], 1..64. Sem '.', '/', '\\'. */
export function isValidName(value: unknown): value is string {
  return typeof value === 'string' && NAME_RE.test(value)
}

export function assertValidName(value: unknown, what: string): asserts value is string {
  if (!isValidName(value)) {
    throw new PlanningValidationError(`${what} inválido: use [a-z0-9-], de 1 a 64 caracteres`)
  }
}

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Ids referenciados por [[id]] no corpo, sem repetição e na ordem em que aparecem. */
export function extractLinks(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(/\[\[([a-z0-9-]{1,64})\]\]/g)) {
    if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}

/** Recusa card inconsistente com erro descritivo; devolve o próprio card se ok. */
export function validateCard(card: PlanCard): PlanCard {
  assertValidName(card.id, 'id do card')
  if (!(CARD_TYPES as readonly string[]).includes(card.tipo)) {
    throw new PlanningValidationError(`tipo de card desconhecido: ${String(card.tipo)}`)
  }
  if (typeof card.titulo !== 'string' || !card.titulo.trim()) {
    throw new PlanningValidationError('card sem título')
  }
  if (!Number.isInteger(card.rev) || card.rev < 0) {
    throw new PlanningValidationError('rev deve ser inteiro >= 0')
  }
  if (!Array.isArray(card.links) || !card.links.every(isValidName)) {
    throw new PlanningValidationError('links devem ser ids válidos')
  }
  if (card.etapa !== undefined) assertValidName(card.etapa, 'etapa do card')
  if (card.fonte !== undefined && !isHttpUrl(card.fonte)) {
    throw new PlanningValidationError('fonte deve ser URL http/https')
  }
  if (card.tipo === 'sugestao' && !card.fonte) {
    throw new PlanningValidationError('card de sugestão exige fonte (URL http/https)')
  }
  if (card.tipo === 'ambiguidade') {
    if (!(AMBIGUITY_STATUSES as readonly string[]).includes(card.status ?? '')) {
      throw new PlanningValidationError("ambiguidade exige status 'aberta' ou 'resolvida'")
    }
  }
  if (typeof card.corpo !== 'string') throw new PlanningValidationError('corpo deve ser texto')
  return card
}

const FM_KEYS = ['id', 'tipo', 'titulo', 'etapa', 'status', 'links', 'fonte', 'rev'] as const

export function serializeCard(card: PlanCard): string {
  validateCard(card)
  const lines = ['---']
  for (const key of FM_KEYS) {
    const value = card[key]
    if (value === undefined) continue
    lines.push(`${key}: ${JSON.stringify(value)}`)
  }
  lines.push('---', '')
  return lines.join('\n') + card.corpo
}

function parseFmValue(raw: string): unknown {
  const text = raw.trim()
  try {
    return JSON.parse(text)
  } catch {
    // Aceita escrita à mão: valor sem aspas vira string; [a, b] vira lista.
    if (text.startsWith('[') && text.endsWith(']')) {
      return text
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    }
    return text.replace(/^["']|["']$/g, '')
  }
}

export function parseCard(text: string): PlanCard {
  const src = text.replace(/^﻿/, '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src)
  if (!m) throw new PlanningValidationError('card sem frontmatter')
  const fm: Record<string, unknown> = {}
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx <= 0) throw new PlanningValidationError(`linha de frontmatter inválida: ${line}`)
    fm[line.slice(0, idx).trim()] = parseFmValue(line.slice(idx + 1))
  }
  let corpo = src.slice(m[0].length)
  if (corpo.startsWith('\r\n')) corpo = corpo.slice(2)
  else if (corpo.startsWith('\n')) corpo = corpo.slice(1)
  const rev = typeof fm.rev === 'string' ? Number(fm.rev) : fm.rev
  const card: PlanCard = {
    id: fm.id as string,
    tipo: fm.tipo as CardType,
    titulo: typeof fm.titulo === 'string' ? fm.titulo : String(fm.titulo ?? ''),
    links: Array.isArray(fm.links) ? (fm.links as string[]) : [],
    rev: (rev ?? 0) as number,
    corpo
  }
  if (fm.etapa !== undefined) card.etapa = String(fm.etapa)
  if (fm.status !== undefined) card.status = String(fm.status)
  if (fm.fonte !== undefined) card.fonte = String(fm.fonte)
  return validateCard(card)
}

const STAGE_LINE = /^\s*-\s*\[([a-z_]+)\]\s+([a-z0-9-]{1,64}):\s*(.*)$/
/** Metadado de revisão: comentário HTML, invisível no markdown renderizado. */
const REV_LINE = /^\s*<!--\s*rev:\s*(\d{1,15})\s*-->\s*$/

/**
 * _roteiro.md: título em '# ', o rev na linha seguinte e uma etapa por linha,
 * na ordem:
 *   # Checkout novo
 *   <!-- rev: 3 -->
 *
 *   - [pendente] etapa-1: Levantar requisitos
 */
export function serializeRoteiro(roteiro: Roteiro): string {
  if (!Number.isSafeInteger(roteiro.rev) || roteiro.rev < 0) {
    throw new PlanningValidationError('rev do roteiro deve ser inteiro >= 0')
  }
  // Título em UMA linha, como o das etapas: uma quebra nele forjaria a linha do
  // rev ou uma etapa na próxima leitura.
  const tituloRoteiro = oneLine(roteiro.titulo)
  const lines = [`# ${tituloRoteiro}`, `<!-- rev: ${roteiro.rev} -->`, '']
  const seen = new Set<string>()
  for (const e of roteiro.etapas) {
    assertValidName(e.id, 'id da etapa')
    if (seen.has(e.id)) throw new PlanningValidationError(`etapa repetida: ${e.id}`)
    seen.add(e.id)
    if (!(STAGE_STATUSES as readonly string[]).includes(e.status)) {
      throw new PlanningValidationError(`status de etapa inválido: ${String(e.status)}`)
    }
    lines.push(`- [${e.status}] ${e.id}: ${oneLine(e.titulo)}`)
  }
  return lines.join('\n') + '\n'
}

/** Texto numa linha só: CR/LF (inclusive CR solto) viram espaço. */
function oneLine(text: unknown): string {
  return String(text ?? '').replace(/\r\n|\r|\n/g, ' ').trim()
}

/** Sem a linha `<!-- rev: N -->` (roteiro anterior ao rev), o rev é 0. */
export function parseRoteiro(text: string): Roteiro {
  let titulo = ''
  let rev: number | null = null
  const etapas: RoteiroStage[] = []
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (!titulo && line.startsWith('# ')) {
      titulo = line.slice(2).trim()
      continue
    }
    const r: RegExpExecArray | null = rev === null ? REV_LINE.exec(line) : null
    if (r) {
      rev = Number(r[1])
      continue
    }
    const m = STAGE_LINE.exec(line)
    if (!m) continue
    if (!(STAGE_STATUSES as readonly string[]).includes(m[1])) {
      throw new PlanningValidationError(`status de etapa inválido: ${m[1]}`)
    }
    etapas.push({ id: m[2], titulo: m[3].trim(), status: m[1] as StageStatus })
  }
  return { titulo, rev: rev ?? 0, etapas }
}
