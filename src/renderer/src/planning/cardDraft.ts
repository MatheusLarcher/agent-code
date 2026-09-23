/**
 * Salvamento automático do editor de card.
 *
 * - Cada alteração vai para um RASCUNHO no localStorage (por projeto + plano +
 *   id do card; card novo usa uma chave própria), com debounce curto. O
 *   rascunho sobrevive a fechar o app e é reaplicado ao abrir o mesmo card.
 * - O ARQUIVO só é gravado por `flush()` — o editor chama ao perder o foco, ao
 *   fechar, ao trocar de card e no unmount. Nada grava se nada mudou; card
 *   inválido não vai para o arquivo (o motivo fica em `erro`, o texto no rascunho).
 * - Conflito de rev (o Manager mexeu no card): merge POR CAMPO contra a última
 *   versão que o editor conhece — campo que só o Manager mudou fica com a dele,
 *   campo que o usuário mudou fica com a do usuário — e grava de novo sobre o
 *   rev atual, uma vez. Card apagado por fora: aviso, e o rascunho fica.
 * - Rascunho gravado com sucesso é descartado.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlanningCardDto, PlanningCardType } from '@shared/ipc'
import { isValidFonte } from '@shared/planningFonte'
import type { SaveCardOutcome } from './usePlanning'

export const DRAFT_DEBOUNCE_MS = 300
export const TITLE_MAX = 1000
export const MERGE_MSG = 'O Manager mudou este card enquanto você editava — juntei as duas versões'
export const GONE_MSG = 'Este card foi apagado fora do editor — seu texto ficou guardado no rascunho'
export const RETRY_MSG = 'O card mudou de novo enquanto eu gravava — seu texto ficou no rascunho'

const DRAFT_PREFIX = 'agentcode.planning.draft:'
const NEW_CARD_KEY = '__novo'

/** O que o editor edita. `etapa`/`fonte`/`status` vazios = ausentes. */
export interface CardFields {
  titulo: string
  tipo: PlanningCardType
  etapa: string
  fonte: string
  status: string
  corpo: string
}
const FIELD_KEYS = ['titulo', 'tipo', 'etapa', 'fonte', 'status', 'corpo'] as const

export interface CardDraft {
  v: 1
  fields: CardFields
  /** A versão em disco de onde o rascunho partiu (para o merge). */
  base: CardFields
  baseRev: number
  savedAt: number
}

export function fieldsOf(card: PlanningCardDto): CardFields {
  return {
    titulo: card.titulo,
    tipo: card.tipo,
    etapa: card.etapa ?? '',
    fonte: card.fonte ?? '',
    status: card.status ?? '',
    corpo: card.corpo
  }
}

export function sameFields(a: CardFields, b: CardFields): boolean {
  return FIELD_KEYS.every((k) => a[k] === b[k])
}

/** Campo que o usuário mudou (mine ≠ base) fica com o dele; o resto, com `theirs`. */
export function mergeFields(base: CardFields, mine: CardFields, theirs: CardFields): CardFields {
  const out: CardFields = { ...theirs }
  for (const k of FIELD_KEYS) if (mine[k] !== base[k]) (out as unknown as Record<string, string>)[k] = mine[k]
  return out
}

/** O card que os campos descrevem sobre `over` (links e rev vêm dele). Não valida. */
export function composeCard(fields: CardFields, over: PlanningCardDto, id = over.id): PlanningCardDto {
  const next: PlanningCardDto = { id, tipo: fields.tipo, titulo: fields.titulo.trim(), links: over.links, rev: over.rev, corpo: fields.corpo }
  if (fields.etapa) next.etapa = fields.etapa
  // Situação só existe em ambiguidade; nos outros tipos fica a que o card já tinha.
  if (fields.tipo === 'ambiguidade') next.status = fields.status === 'resolvida' ? 'resolvida' : 'aberta'
  else if (over.tipo !== 'ambiguidade' && over.status) next.status = over.status
  const fonte = fields.fonte.trim()
  if (fields.tipo === 'sugestao') {
    if (fonte) next.fonte = fonte
  } else if (over.fonte) next.fonte = over.fonte
  return next
}

/** Mesmo conteúdo em disco? (fora id, links e rev) */
export function sameContent(a: PlanningCardDto, b: PlanningCardDto): boolean {
  return (
    a.tipo === b.tipo &&
    a.titulo === b.titulo &&
    (a.etapa ?? '') === (b.etapa ?? '') &&
    (a.status ?? '') === (b.status ?? '') &&
    (a.fonte ?? '') === (b.fonte ?? '') &&
    a.corpo === b.corpo
  )
}

/** Por que este card não pode ir para o arquivo (as regras do main), ou null. */
export function cardProblem(card: PlanningCardDto): string | null {
  if (!card.titulo) return 'Dê um título ao card.'
  if (card.titulo.length > TITLE_MAX) return `Título longo demais (máximo ${TITLE_MAX} caracteres).`
  if (card.tipo === 'sugestao' && !card.fonte) {
    return 'Sugestão precisa de uma fonte: um link http(s) ou um arquivo do projeto (ex.: src/a.ts:12).'
  }
  if (card.fonte !== undefined && !isValidFonte(card.fonte)) {
    return 'Fonte inválida: use um link http(s) ou o caminho relativo de um arquivo do projeto, sem "..", com ":linha" opcional.'
  }
  return null
}

/** Id [a-z0-9-] a partir do título, único entre `existing`. */
export function makeCardId(titulo: string, existing: Iterable<string>): string {
  const taken = new Set(existing)
  const base =
    titulo
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'card'
  if (!taken.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const id = `${base}-${i}`
    if (!taken.has(id)) return id
  }
  return `${base}-${Date.now().toString(36)}`
}

// ---- rascunho no localStorage ----

function normCwd(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Chave do rascunho: projeto (sem ligar para barra/caixa) + plano + card ('' = card novo). */
export function draftKey(projectCwd: string, slug: string, cardId: string): string {
  return DRAFT_PREFIX + JSON.stringify([normCwd(projectCwd), slug, cardId || NEW_CARD_KEY])
}

function isFields(v: unknown): v is CardFields {
  const f = v as Record<string, unknown> | null
  return !!f && typeof f === 'object' && FIELD_KEYS.every((k) => typeof f[k] === 'string')
}

export function readDraft(key: string): CardDraft | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const d = JSON.parse(raw) as Partial<CardDraft>
    if (d?.v !== 1 || !isFields(d.fields) || !isFields(d.base) || !Number.isInteger(d.baseRev)) return null
    return d as CardDraft
  } catch {
    return null
  }
}

export function writeDraft(key: string, draft: CardDraft): void {
  try {
    localStorage.setItem(key, JSON.stringify(draft))
  } catch {
    // Cota cheia/sem storage: o rascunho é conveniência, a gravação continua.
  }
}

export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // idem
  }
}

/** Campos para abrir o card: os do rascunho, se houver um que ainda muda algo. */
export function restoreDraft(card: PlanningCardDto, key: string): { fields: CardFields; restored: boolean } {
  const own = fieldsOf(card)
  const draft = readDraft(key)
  if (!draft) return { fields: own, restored: false }
  // O card mudou no disco depois do rascunho: o mesmo merge por campo da gravação.
  const fields = draft.baseRev === card.rev ? draft.fields : mergeFields(draft.base, draft.fields, own)
  if (sameFields(fields, own)) {
    clearDraft(key)
    return { fields: own, restored: false }
  }
  return { fields, restored: true }
}

// ---- o hook ----

export type FlushResult = 'clean' | 'saved' | 'invalid' | 'failed' | 'gone' | 'skipped'
export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'invalid' | 'failed' | 'gone'

export interface CardAutosaveOptions {
  /** O card aberto; se o pai repassar a versão viva, ela é adotada quando não há edição pendente. */
  card: PlanningCardDto
  isNew: boolean
  existingIds: readonly string[]
  projectCwd: string
  slug: string
  onSave: (card: PlanningCardDto, expectedRev: number) => Promise<SaveCardOutcome>
  onSaved?: (card: PlanningCardDto) => void
  notify?: (tipo: 'aviso' | 'erro', msg: string) => void
}

export interface CardAutosave {
  fields: CardFields
  setField: <K extends keyof CardFields>(key: K, value: CardFields[K]) => void
  /** A última versão em disco que o editor conhece (a aberta ou a que ele gravou). */
  base: PlanningCardDto
  /** Já existe em disco (card novo só depois da primeira gravação). */
  persisted: boolean
  dirty: boolean
  status: AutosaveStatus
  erro: string | null
  /** O rascunho de uma sessão anterior foi reaplicado. */
  restored: boolean
  discardDraft: () => void
  /** Grava no arquivo se mudou e é válido (as chamadas entram em fila). */
  flush: () => Promise<FlushResult>
  /** Suspende a gravação (ex.: enquanto confirma o Apagar). */
  hold: (on: boolean) => void
  /** O card foi apagado: descarta o rascunho e não grava mais nada. */
  forget: () => void
}

export function useCardAutosave(opts: CardAutosaveOptions): CardAutosave {
  const optsRef = useRef(opts)
  optsRef.current = opts
  const keyFor = useCallback((id: string) => draftKey(optsRef.current.projectCwd, optsRef.current.slug, id), [])
  const [init] = useState(() => restoreDraft(opts.card, keyFor(opts.isNew ? '' : opts.card.id)))
  const [fields, setFieldsState] = useState(init.fields)
  const [base, setBaseState] = useState(opts.card)
  const [restored, setRestored] = useState(init.restored)
  const [status, setStatus] = useState<AutosaveStatus>('idle')
  const [erro, setErro] = useState<string | null>(null)
  const fieldsRef = useRef(init.fields)
  const baseRef = useRef(opts.card)
  const idRef = useRef(opts.isNew ? '' : opts.card.id)
  const queue = useRef<Promise<FlushResult>>(Promise.resolve('clean'))
  const busy = useRef(false)
  const held = useRef(false)
  const dead = useRef(false)
  const gone = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const setFields = useCallback((next: CardFields) => {
    fieldsRef.current = next
    setFieldsState(next)
  }, [])
  const setBase = useCallback((next: PlanningCardDto) => {
    baseRef.current = next
    setBaseState(next)
  }, [])

  const writeDraftNow = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (dead.current) return
    const b = baseRef.current
    const f = fieldsRef.current
    const key = keyFor(idRef.current)
    if (sameFields(f, fieldsOf(b))) clearDraft(key)
    else writeDraft(key, { v: 1, fields: f, base: fieldsOf(b), baseRev: b.rev, savedAt: Date.now() })
  }, [keyFor])

  const doFlush = useCallback(async (): Promise<FlushResult> => {
    if (dead.current || held.current || gone.current) return 'skipped'
    writeDraftNow() // antes de tudo: se a gravação falhar, nada se perde
    const b = baseRef.current
    const sent = fieldsRef.current
    if (sameFields(sent, fieldsOf(b))) return 'clean'
    const { existingIds, onSave, notify } = optsRef.current
    const isNew = !idRef.current
    const card = composeCard(sent, b, isNew ? makeCardId(sent.titulo.trim(), existingIds) : idRef.current)
    if (!isNew && sameContent(card, b)) return 'clean' // só espaço sobrando no título
    const problem = cardProblem(card)
    if (problem) {
      setErro(problem)
      setStatus('invalid')
      return 'invalid'
    }
    setErro(null)
    setStatus('saving')
    busy.current = true
    try {
      let out = await onSave(card, b.rev)
      if (!out.ok && out.conflict) {
        const theirs = out.current
        if (isNew) {
          // O id escolhido foi tomado no meio do caminho: outro id, uma vez.
          const id = makeCardId(card.titulo, [...existingIds, card.id, ...(theirs ? [theirs.id] : [])])
          out = await onSave({ ...card, id }, 0)
        } else if (!theirs) {
          gone.current = true
          setStatus('gone')
          notify?.('aviso', GONE_MSG)
          return 'gone'
        } else {
          const written = mergeFields(fieldsOf(b), sent, fieldsOf(theirs))
          const merged = composeCard(written, theirs)
          const mergedProblem = cardProblem(merged)
          if (mergedProblem) {
            setBase(theirs)
            setFields(mergeFields(sent, fieldsRef.current, written))
            setErro(mergedProblem)
            setStatus('invalid')
            return 'invalid'
          }
          if (sameContent(merged, theirs)) out = { ok: true, card: theirs } // nada nosso sobrou
          else {
            out = await onSave(merged, theirs.rev)
            if (out.ok) notify?.('aviso', MERGE_MSG)
          }
        }
      }
      if (!out.ok) {
        // Erro de disco (o toast já saiu), recusa do main ou 2º conflito: fica no rascunho.
        if (out.conflict) notify?.('aviso', out.current ? RETRY_MSG : GONE_MSG)
        setStatus('failed')
        return 'failed'
      }
      const saved = out.card
      const oldKey = keyFor(idRef.current)
      idRef.current = saved.id
      if (oldKey !== keyFor(saved.id)) clearDraft(oldKey) // card novo ganhou id
      setBase(saved)
      // O que foi digitado DURANTE a gravação (difere do que saiu) continua
      // pendente; o resto vem do disco — inclusive o que o merge trouxe do Manager.
      setFields(mergeFields(sent, fieldsRef.current, fieldsOf(saved)))
      writeDraftNow()
      setRestored(false)
      setStatus('saved')
      optsRef.current.onSaved?.(saved)
      return 'saved'
    } finally {
      busy.current = false
    }
  }, [keyFor, writeDraftNow, setBase, setFields])

  const flush = useCallback((): Promise<FlushResult> => {
    const run = queue.current.then(doFlush, doFlush)
    queue.current = run
    return run
  }, [doFlush])

  const setField = useCallback(
    <K extends keyof CardFields>(key: K, value: CardFields[K]) => setFields({ ...fieldsRef.current, [key]: value }),
    [setFields]
  )

  // Rascunho com debounce curto a cada mudança.
  useEffect(() => {
    if (dead.current) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(writeDraftNow, DRAFT_DEBOUNCE_MS)
  }, [fields, base, writeDraftNow])

  // Motivo de card inválido acompanha a digitação até o card ficar bom.
  useEffect(() => {
    if (status !== 'invalid') return
    const problem = cardProblem(composeCard(fields, baseRef.current, idRef.current || 'novo'))
    setErro(problem)
    if (!problem) setStatus('idle')
  }, [fields, status])

  // Versão nova vinda de fora (o Manager): adota se não há edição pendente.
  useEffect(() => {
    const live = opts.card
    const b = baseRef.current
    if (!idRef.current || live.id !== idRef.current || live.rev <= b.rev || busy.current) return
    if (!sameFields(fieldsRef.current, fieldsOf(b))) return // editando: o merge resolve ao gravar
    setBase(live)
    setFields(fieldsOf(live))
  }, [opts.card, setBase, setFields])

  // Fechar o app: o rascunho vai já. Unmount: rascunho e gravação. O adiamento
  // deixa o remount do StrictMode (dev) cancelar a gravação de mentira.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    const onHide = (): void => writeDraftNow()
    window.addEventListener('pagehide', onHide)
    window.addEventListener('beforeunload', onHide)
    return () => {
      alive.current = false
      window.removeEventListener('pagehide', onHide)
      window.removeEventListener('beforeunload', onHide)
      writeDraftNow()
      setTimeout(() => {
        if (!alive.current) void flush()
      }, 0)
    }
  }, [writeDraftNow, flush])

  const discardDraft = useCallback(() => {
    clearDraft(keyFor(idRef.current))
    setFields(fieldsOf(baseRef.current))
    setRestored(false)
    setErro(null)
    setStatus('idle')
  }, [keyFor, setFields])

  const hold = useCallback((on: boolean) => {
    held.current = on
  }, [])

  const forget = useCallback(() => {
    dead.current = true
    if (timer.current) clearTimeout(timer.current)
    clearDraft(keyFor(idRef.current))
  }, [keyFor])

  const dirty = !sameFields(fields, fieldsOf(base))
  return {
    fields,
    setField,
    base,
    persisted: !!idRef.current,
    dirty,
    status,
    erro,
    restored,
    discardDraft,
    flush,
    hold,
    forget
  }
}
