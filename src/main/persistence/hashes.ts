import { createHash } from 'node:crypto'

export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export function normalizeJson(value: unknown): JsonValue {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('Valor não pode ser persistido como JSON.')
  return JSON.parse(serialized) as JsonValue
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError('JSON canônico não aceita números não finitos.')
  return Object.is(value, -0) ? '0' : JSON.stringify(value)
}

export function canonicalJson(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') return canonicalNumber(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`

  const fields = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
  return `{${fields.join(',')}}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function hashJson(value: JsonValue): string {
  return sha256(`json\0${canonicalJson(value)}`)
}

export function hashText(value: string): string {
  return sha256(`text\0${value}`)
}

export interface HashItem {
  entity: string
  id: string
  contentHash: string
}

export function hashAggregate(items: HashItem[]): string {
  const canonical = [...items]
    .sort((left, right) => {
      const byEntity = left.entity.localeCompare(right.entity)
      return byEntity || left.id.localeCompare(right.id) || left.contentHash.localeCompare(right.contentHash)
    })
    .map((item) => `${item.entity}\0${item.id}\0${item.contentHash}`)
    .join('\n')
  return sha256(`aggregate\0${canonical}`)
}
