/**
 * Regras puras de soltar arquivo e colar imagem na Tela de Planejamento (sem
 * React, sem window.api): o que vira importação, onde o card nasce e como os
 * anexos entram num card que já existe.
 *
 * - Arquivo arrastado do Explorer tem caminho no disco (getPathForFile): vai
 *   por `{ path }` e o main copia — os bytes não passam pelo IPC.
 * - Imagem colada da área de transferência não tem caminho: vai em base64
 *   (`{ name, data }`), com um nome inventado se o navegador não der um.
 * - Soltar em área vazia cria card `midia` na coluna (etapa) e na posição do
 *   drop; soltar em cima de um card anexa a ele.
 */
import type { PlanningCardDto, PlanningImportFile, PlanMediaDto } from '@shared/ipc'
import { MAX_ANEXOS_POR_CARD, MAX_MEDIA_BYTES } from '@shared/planningMedia'
import { makeCardId } from './cardDraft'
import { CARD_W, COL_GAP, FIRST_CARD_Y, NO_STAGE_ID, type PlanLayout, type Point } from './layout'

/** Quantos arquivos uma importação aceita (o IPC recusa mais que isso). */
export const MAX_IMPORT_FILES = 20

/** O que o código lê de um File — os testes passam objetos simples. */
export interface DroppedFile {
  name: string
  type: string
  size: number
  arrayBuffer(): Promise<ArrayBuffer>
}

/** O que sobra de um DataTransfer (drop ou paste). */
export interface TransferLike {
  types?: ArrayLike<string> | readonly string[]
  files?: ArrayLike<DroppedFile> | null
  items?: ArrayLike<{ kind: string; type: string; getAsFile(): DroppedFile | null }> | null
}

/** Onde o drop caiu: num card (anexa) ou numa área vazia (cria card). */
export type DropTarget = { kind: 'card'; cardId: string } | { kind: 'empty'; etapa?: string; position: Point }

/** O arrasto traz arquivos? (texto ou link arrastado não conta) */
export function hasFiles(dt: TransferLike | null | undefined): boolean {
  return !!dt?.types && Array.from(dt.types).includes('Files')
}

/** Arquivos de um drop ou paste, sem repetir o mesmo File (files e items podem trazer os dois). */
export function transferFiles(dt: TransferLike | null | undefined): DroppedFile[] {
  if (!dt) return []
  const out: DroppedFile[] = []
  const seen = new Set<DroppedFile>()
  const add = (f: DroppedFile | null | undefined): void => {
    if (f && !seen.has(f)) {
      seen.add(f)
      out.push(f)
    }
  }
  for (const f of Array.from(dt.files ?? [])) add(f)
  if (!out.length) for (const it of Array.from(dt.items ?? [])) if (it.kind === 'file') add(it.getAsFile())
  return out
}

/** Colar numa caixa de texto é colar texto: o canvas não se mete. */
export function isTextTarget(el: unknown): boolean {
  const e = el as { tagName?: string; isContentEditable?: boolean; closest?: (s: string) => unknown } | null
  if (!e || typeof e !== 'object') return false
  if (e.isContentEditable) return true
  const tag = (e.tagName ?? '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!e.closest?.('[contenteditable="true"]')
}

/**
 * O Ctrl+V é do canvas? Só com o canvas na tela e o foco nele ou em lugar
 * nenhum (body): colar no chat, no editor de card ou num diálogo é deles.
 */
export function pasteAllowed(target: unknown, canvas: { contains(n: unknown): boolean } | null, visible: boolean): boolean {
  if (!canvas || !visible || isTextTarget(target)) return false
  const t = target as { tagName?: string; closest?: (s: string) => unknown } | null
  if (!t || typeof t !== 'object') return true
  const tag = (t.tagName ?? '').toUpperCase()
  if (tag === 'BODY' || tag === 'HTML') return true
  return canvas.contains(t) && !t.closest?.('[role="dialog"]')
}

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg'
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Nome para a imagem colada que veio sem nome (ou com o genérico "image.png"). */
export function pastedName(file: Pick<DroppedFile, 'name' | 'type'>, now = new Date()): string {
  const name = file.name?.trim()
  if (name && !/^image\.\w+$/i.test(name)) return name
  const ext = IMAGE_EXT[file.type] ?? (name?.split('.').pop() || 'png')
  const d = now
  return `colada-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`
}

/** Bytes em base64 (em blocos: String.fromCharCode estoura com arrays grandes). */
export function toBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(bin)
}

export interface ImportPlan {
  files: PlanningImportFile[]
  /** Por que algum arquivo ficou de fora (vai para o toast de aviso). */
  skipped: string[]
}

/**
 * O pedido de importação para estes arquivos. Com caminho no disco vai por
 * `{ path }`; sem caminho, só imagem é aceita (é o que se cola) e vai em
 * base64. Acima de MAX_IMPORT_FILES, o resto fica de fora com aviso.
 */
export async function buildImport(
  files: readonly DroppedFile[],
  pathOf: (f: DroppedFile) => string,
  now = new Date()
): Promise<ImportPlan> {
  const out: PlanningImportFile[] = []
  const skipped: string[] = []
  for (const f of files) {
    if (out.length >= MAX_IMPORT_FILES) {
      skipped.push(`${f.name || 'arquivo'}: no máximo ${MAX_IMPORT_FILES} arquivos por vez`)
      continue
    }
    let path = ''
    try {
      path = pathOf(f) || ''
    } catch {
      path = ''
    }
    if (path) {
      out.push({ path })
      continue
    }
    if (!f.type.startsWith('image/')) {
      skipped.push(`${f.name || 'arquivo'}: só dá para colar imagem — arraste o arquivo do Explorer`)
      continue
    }
    if (f.size > MAX_MEDIA_BYTES) {
      skipped.push(`${f.name || 'imagem'}: grande demais`)
      continue
    }
    out.push({ name: pastedName(f, now), data: toBase64(new Uint8Array(await f.arrayBuffer())) })
  }
  return { files: out, skipped }
}

/** Coluna do canvas que contém `x` (fora das colunas: a mais próxima). */
export function columnAt(layout: PlanLayout, x: number): string {
  const cols = layout.columns
  if (!cols.length) return NO_STAGE_ID
  let best = cols[0]
  for (const c of cols) if (x >= c.x - COL_GAP / 2) best = c
  return best.id
}

/** Onde o card de mídia nasce: centrado no ponto do drop, nunca por cima do cabeçalho. */
export function dropPosition(point: Point): Point {
  return { x: Math.round(point.x - CARD_W / 2), y: Math.round(Math.max(point.y - 20, FIRST_CARD_Y)) }
}

/** Alvo do drop: o card sob o ponteiro (id do nó) ou a área vazia na coluna do ponto. */
export function dropTargetOf(layout: PlanLayout, cardId: string | null | undefined, point: Point): DropTarget {
  if (cardId && Object.prototype.hasOwnProperty.call(layout.positions, cardId)) return { kind: 'card', cardId }
  const column = columnAt(layout, point.x)
  const position = dropPosition(point)
  return column === NO_STAGE_ID ? { kind: 'empty', position } : { kind: 'empty', etapa: column, position }
}

/** "a1b2c3-tela-de-login.png" → "Tela de login" (o título sugerido do card). */
export function mediaTitle(name: string): string {
  const stem = name.replace(/^[0-9a-f]{6}-/, '').replace(/\.[a-z0-9]{1,10}$/, '')
  const words = stem.replace(/[-_]+/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : 'Mídia'
}

/** Card `midia` novo com estes anexos (rev 0: ainda não existe em disco). */
export function mediaCard(media: readonly PlanMediaDto[], existingIds: Iterable<string>, etapa?: string): PlanningCardDto {
  const names = [...new Set(media.map((m) => m.name))].slice(0, MAX_ANEXOS_POR_CARD)
  const first = mediaTitle(names[0] ?? '')
  const titulo = names.length > 1 ? `${first} e mais ${names.length - 1}` : first
  const card: PlanningCardDto = { id: makeCardId(titulo, existingIds), tipo: 'midia', titulo, links: [], rev: 0, corpo: '', anexos: names }
  if (etapa) card.etapa = etapa
  return card
}

/** Extensões que o Windows EXECUTA ao "abrir" — dessas, abre-se a pasta, não o arquivo. */
const RUNNABLE_EXTS = new Set([
  'exe', 'bat', 'cmd', 'com', 'msi', 'msp', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta',
  'scr', 'pif', 'lnk', 'url', 'reg', 'cpl', 'jar', 'sh', 'msc', 'inf', 'scf', 'application', 'gadget'
])

/** O que "Abrir" abre no app padrão: o arquivo, ou a pasta dele quando abrir seria executar. */
export function openTarget(path: string): { path: string; folder: boolean } {
  const ext = /\.([a-z0-9-]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ''
  if (!RUNNABLE_EXTS.has(ext)) return { path, folder: false }
  return { path: path.replace(/[\\/][^\\/]*$/, '') || path, folder: true }
}

/** O card com os anexos novos no fim (sem repetir, até MAX_ANEXOS_POR_CARD). */
export function withAnexos(card: PlanningCardDto, names: readonly string[]): { card: PlanningCardDto; added: number; dropped: number } {
  const anexos = [...(card.anexos ?? [])]
  let added = 0
  let dropped = 0
  for (const n of names) {
    if (anexos.includes(n)) continue
    if (anexos.length >= MAX_ANEXOS_POR_CARD) dropped++
    else {
      anexos.push(n)
      added++
    }
  }
  return { card: { ...card, anexos }, added, dropped }
}
