/**
 * Dados da Tela de Planejamento, via IPC (window.api.planning*).
 *
 * - Abre com planningOpen e fecha com planningClose no unmount ou quando o
 *   plano (projectCwd + slug) muda — é isso que liga e desliga a vigia da pasta.
 * - Recarrega em onPlanningChanged SÓ do mesmo plano: o evento é global.
 * - Toda gravação de card leva o expectedRev; 'rev_conflict' recarrega e avisa
 *   (com quietConflict só recarrega: o editor de card mescla e avisa ele mesmo).
 *   Qualquer outra falha vira toast de erro. Nada aqui lança.
 * - O roteiro também: toggleEtapa manda o rev carregado e, em
 *   'roteiro_conflict', reaplica UMA vez sobre o roteiro atual que veio junto.
 * - saveLayout é otimista e com debounce: arrastar não grava a cada pixel.
 *   saveViewport (pan/zoom) entra no mesmo debounce e na mesma gravação.
 * - `born`: os cards que a recarga trouxe e a tela não tinha — o Manager os
 *   criou. É o que a CardBirthFlow anima saindo do chat.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  OpenedPlanningDto,
  PlanningCardDto,
  PlanningChangedMsg,
  PlanningFailure,
  PlanningResult,
  PlanningRoteiroDto,
  PlanningStageStatus
} from '@shared/ipc'
import { useUI } from '../ui/UiProvider'
import type { Point } from './layout'

export const LAYOUT_DEBOUNCE_MS = 400
export const CONFLICT_MSG = 'O card mudou enquanto você editava — carreguei a versão atual'
export const ROTEIRO_CONFLICT_MSG = 'O roteiro mudou enquanto você mexia — carreguei a versão atual'

export type PlanningStatus = 'loading' | 'ready' | 'error'
export type PlanningViewport = { x: number; y: number; zoom: number }

/** Cards que apareceram numa recarga vinda de fora (o Agent Manager os criou).
 *  `seq` muda a cada leva: é o que dispara a animação de nascimento. */
export interface CardBirth {
  seq: number
  cards: { id: string; tipo: PlanningCardDto['tipo'] }[]
}

export type SaveCardOutcome =
  | { ok: true; card: PlanningCardDto }
  /** `current` é o card em disco agora (null = não existe mais). */
  | { ok: false; conflict: true; current: PlanningCardDto | null }
  | { ok: false; conflict: false }

export interface SaveCardOptions {
  quietConflict?: boolean
}

export interface PlanningController {
  status: PlanningStatus
  plan: OpenedPlanningDto | null
  /** Motivo da falha ao abrir (status 'error'). */
  error: string | null
  /** A última leva de cards criados por fora (o Manager). Card criado aqui na
   *  tela já está no estado quando a recarga chega — não conta. */
  born: CardBirth | null
  reload: () => Promise<void>
  /** `quietConflict`: no 'rev_conflict' recarrega sem toast — quem chamou avisa
   *  (o editor de card faz merge e dá um aviso só). */
  saveCard: (card: PlanningCardDto, expectedRev: number, opts?: SaveCardOptions) => Promise<SaveCardOutcome>
  deleteCard: (id: string, expectedRev: number) => Promise<boolean>
  /** Otimista; grava depois de LAYOUT_DEBOUNCE_MS sem novas chamadas. */
  saveLayout: (positions: Record<string, Point>) => void
  /** Pan/zoom do canvas: vai para _canvas.json junto das posições (mesmo debounce). */
  saveViewport: (viewport: PlanningViewport) => void
  /** Sem `status`, avança pendente → em_andamento → concluida → pendente. */
  toggleEtapa: (id: string, status?: PlanningStageStatus) => Promise<boolean>
}

const NEXT_STATUS: Record<PlanningStageStatus, PlanningStageStatus> = {
  pendente: 'em_andamento',
  em_andamento: 'concluida',
  concluida: 'pendente'
}

export function nextStageStatus(status: PlanningStageStatus): PlanningStageStatus {
  return NEXT_STATUS[status] ?? 'pendente'
}

function normPath(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** O evento é deste plano? (caminho comparado sem ligar para barra nem caixa) */
export function isSamePlan(msg: PlanningChangedMsg, projectCwd: string, slug: string): boolean {
  return !!msg && msg.slug === slug && typeof msg.projectCwd === 'string' && normPath(msg.projectCwd) === normPath(projectCwd)
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** IPC que rejeita (canal ausente, janela fechando) vira falha 'io', não exceção. */
async function safe<T extends object>(call: () => Promise<PlanningResult<T>>): Promise<PlanningResult<T>> {
  try {
    const res = await call()
    if (res && typeof res === 'object' && 'ok' in res) return res
    return { ok: false, code: 'io', message: 'resposta inválida do processo principal' }
  } catch (err) {
    return { ok: false, code: 'io', message: errText(err) }
  }
}

function failureText(f: PlanningFailure): string {
  if (f.code === 'rev_conflict') return CONFLICT_MSG
  return f.code === 'roteiro_conflict' ? ROTEIRO_CONFLICT_MSG : f.message
}

/** Só os campos do contrato, sem chave undefined: o IPC valida com strictObject. */
export function toCardDto(card: PlanningCardDto): PlanningCardDto {
  const out: PlanningCardDto = {
    id: card.id,
    tipo: card.tipo,
    titulo: card.titulo,
    links: [...new Set(card.links)],
    rev: card.rev,
    corpo: card.corpo
  }
  if (card.etapa) out.etapa = card.etapa
  if (card.status) out.status = card.status
  if (card.fonte) out.fonte = card.fonte
  return out
}

/** O que planningSaveRoteiro aceita: sem rev (vai em expectedRev) nem chave extra. */
function cleanRoteiro(r: PlanningRoteiroDto): Omit<PlanningRoteiroDto, 'rev'> {
  return { titulo: r.titulo, etapas: r.etapas.map(({ id, titulo, status }) => ({ id, titulo, status })) }
}

/** O roteiro com a etapa `id` em `status`; null se a etapa não existe nele. */
function withStage(r: PlanningRoteiroDto, id: string, status: PlanningStageStatus): PlanningRoteiroDto | null {
  if (!r.etapas.some((e) => e.id === id)) return null
  return { ...r, etapas: r.etapas.map((e) => (e.id === id ? { ...e, status } : e)) }
}

export function usePlanning(projectCwd: string, slug: string): PlanningController {
  const { notify } = useUI()
  const [status, setStatus] = useState<PlanningStatus>('loading')
  const [plan, setPlan] = useState<OpenedPlanningDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [born, setBorn] = useState<CardBirth | null>(null)
  const bornSeq = useRef(0)
  // Espelho síncrono do plano: o flush do layout e o toggle leem daqui.
  const planRef = useRef<OpenedPlanningDto | null>(null)
  // Cada load pega um número; resposta de load velho (ou de plano trocado) é descartada.
  const loadSeq = useRef(0)
  // Gravação que volta depois de trocar de plano não pode mexer no estado novo.
  const activeKey = useRef('')
  const myKey = `${projectCwd}\u0000${slug}`
  const layoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const layoutDirty = useRef(false)
  // Último pan/zoom do usuário neste plano. Fica fora do estado: mexer no
  // canvas não pode re-renderizar a tela inteira.
  const viewportRef = useRef<PlanningViewport | null>(null)

  const commit = useCallback((next: OpenedPlanningDto | null): void => {
    planRef.current = next
    setPlan(next)
  }, [])

  const updatePlan = useCallback(
    (key: string, fn: (p: OpenedPlanningDto) => OpenedPlanningDto): void => {
      if (activeKey.current !== key || !planRef.current) return
      commit(fn(planRef.current))
    },
    [commit]
  )

  const load = useCallback(
    async (mode: 'initial' | 'reload'): Promise<void> => {
      const seq = ++loadSeq.current
      const res = await safe(() => window.api.planningOpen({ projectCwd, slug }))
      if (seq !== loadSeq.current) return
      if (res.ok) {
        let next = res.plan
        const local = planRef.current
        // Posição arrastada e ainda não gravada não pode voltar atrás no reload.
        if (layoutDirty.current && local) {
          next = { ...next, layout: { ...next.layout, positions: { ...next.layout.positions, ...local.layout.positions } } }
        }
        // Só na recarga (o evento de fora): o que não estava na tela nasceu agora.
        // Vai no mesmo render do plano novo, para o card já nascer escondido.
        if (mode === 'reload' && local) {
          const before = new Set(local.cards.map((c) => c.id))
          const fresh = next.cards.filter((c) => !before.has(c.id))
          if (fresh.length) setBorn({ seq: ++bornSeq.current, cards: fresh.map(({ id, tipo }) => ({ id, tipo })) })
        }
        commit(next)
        setError(null)
        setStatus('ready')
      } else if (mode === 'reload' && planRef.current) {
        notify('erro', `Não consegui recarregar o planejamento: ${failureText(res)}`)
      } else {
        commit(null)
        setError(failureText(res))
        setStatus('error')
      }
    },
    [projectCwd, slug, commit, notify]
  )

  const flushLayout = useCallback((): void => {
    if (layoutTimer.current) {
      clearTimeout(layoutTimer.current)
      layoutTimer.current = null
    }
    if (!layoutDirty.current) return
    layoutDirty.current = false
    const current = planRef.current
    if (!current) return
    const viewport = viewportRef.current ?? current.layout.viewport
    const layout = viewport ? { positions: current.layout.positions, viewport } : { positions: current.layout.positions }
    void safe(() => window.api.planningSaveLayout({ projectCwd, slug, layout })).then((res) => {
      if (!res.ok) notify('erro', `Não consegui salvar a posição dos cards: ${failureText(res)}`)
    })
  }, [projectCwd, slug, notify])

  useEffect(() => {
    activeKey.current = `${projectCwd}\u0000${slug}`
    viewportRef.current = null // o do plano anterior já foi gravado no cleanup
    commit(null)
    setBorn(null)
    setError(null)
    setStatus('loading')
    void load('initial')
    return () => {
      loadSeq.current++ // descarta o que ainda estiver em voo
      flushLayout() // arrasto recente não se perde ao fechar/trocar de plano
      activeKey.current = ''
      void safe(() => window.api.planningClose({ projectCwd, slug }))
    }
  }, [projectCwd, slug, load, flushLayout, commit])

  useEffect(
    () =>
      window.api.onPlanningChanged((msg) => {
        if (isSamePlan(msg, projectCwd, slug)) void load('reload')
      }),
    [projectCwd, slug, load]
  )

  const fail = useCallback(
    (res: PlanningFailure, what: string): void => {
      if (res.code === 'rev_conflict' || res.code === 'roteiro_conflict') {
        notify('aviso', failureText(res))
        void load('reload')
      } else {
        notify('erro', `${what}: ${res.message}`)
      }
    },
    [notify, load]
  )

  const reload = useCallback(() => load(planRef.current ? 'reload' : 'initial'), [load])

  const saveCard = useCallback(
    async (card: PlanningCardDto, expectedRev: number, opts?: SaveCardOptions): Promise<SaveCardOutcome> => {
      const dto = toCardDto(card)
      const res = await safe(() => window.api.planningSaveCard({ projectCwd, slug, card: dto, expectedRev }))
      if (res.ok) {
        const saved = res.card
        updatePlan(myKey, (p) => {
          const exists = p.cards.some((c) => c.id === saved.id)
          const cards = exists ? p.cards.map((c) => (c.id === saved.id ? saved : c)) : [...p.cards, saved]
          return { ...p, cards }
        })
        return { ok: true, card: saved }
      }
      if (res.code === 'rev_conflict' && opts?.quietConflict) void load('reload')
      else fail(res, 'Não consegui salvar o card')
      return res.code === 'rev_conflict' ? { ok: false, conflict: true, current: res.current } : { ok: false, conflict: false }
    },
    [projectCwd, slug, myKey, updatePlan, fail, load]
  )

  const deleteCard = useCallback(
    async (id: string, expectedRev: number): Promise<boolean> => {
      const res = await safe(() => window.api.planningDeleteCard({ projectCwd, slug, id, expectedRev }))
      if (res.ok) {
        updatePlan(myKey, (p) => {
          const positions = { ...p.layout.positions }
          delete positions[id]
          return { ...p, cards: p.cards.filter((c) => c.id !== id), layout: { ...p.layout, positions } }
        })
        return true
      }
      fail(res, 'Não consegui apagar o card')
      return false
    },
    [projectCwd, slug, myKey, updatePlan, fail]
  )

  const saveLayout = useCallback(
    (positions: Record<string, Point>): void => {
      const rounded: Record<string, Point> = {}
      for (const [id, p] of Object.entries(positions)) {
        if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) rounded[id] = { x: Math.round(p.x), y: Math.round(p.y) }
      }
      if (!Object.keys(rounded).length || !planRef.current) return
      updatePlan(myKey, (p) => ({ ...p, layout: { ...p.layout, positions: { ...p.layout.positions, ...rounded } } }))
      layoutDirty.current = true
      if (layoutTimer.current) clearTimeout(layoutTimer.current)
      layoutTimer.current = setTimeout(flushLayout, LAYOUT_DEBOUNCE_MS)
    },
    [myKey, updatePlan, flushLayout]
  )

  const saveViewport = useCallback(
    (v: PlanningViewport): void => {
      if (!planRef.current || !Number.isFinite(v?.x) || !Number.isFinite(v?.y) || !(v?.zoom > 0)) return
      viewportRef.current = { x: Math.round(v.x), y: Math.round(v.y), zoom: Math.round(v.zoom * 1000) / 1000 }
      layoutDirty.current = true
      if (layoutTimer.current) clearTimeout(layoutTimer.current)
      layoutTimer.current = setTimeout(flushLayout, LAYOUT_DEBOUNCE_MS)
    },
    [flushLayout]
  )

  const toggleEtapa = useCallback(
    async (id: string, next?: PlanningStageStatus): Promise<boolean> => {
      const current = planRef.current
      const etapa = current?.roteiro.etapas.find((e) => e.id === id)
      if (!current || !etapa) return false
      const target = next ?? nextStageStatus(etapa.status)
      if (target === etapa.status) return true
      const save = (base: PlanningRoteiroDto, changed: PlanningRoteiroDto) =>
        safe(() =>
          window.api.planningSaveRoteiro({ projectCwd, slug, roteiro: cleanRoteiro(changed), expectedRev: base.rev ?? 0 })
        )
      const optimistic = withStage(current.roteiro, id, target)
      if (!optimistic) return false
      updatePlan(myKey, (p) => ({ ...p, roteiro: optimistic })) // o clique responde na hora
      let res = await save(current.roteiro, optimistic)
      if (!res.ok && res.code === 'roteiro_conflict') {
        // Outra gravação (o Manager?) mexeu no roteiro: reaplica UMA vez sobre
        // o atual, que veio junto do conflito — se a etapa ainda existir.
        const fresh = res.current
        if (fresh.etapas.find((e) => e.id === id)?.status === target) {
          updatePlan(myKey, (p) => ({ ...p, roteiro: fresh })) // já está como o usuário quis
          return true
        }
        const retry = withStage(fresh, id, target)
        if (retry) {
          updatePlan(myKey, (p) => ({ ...p, roteiro: retry }))
          res = await save(fresh, retry)
        }
      }
      if (res.ok) {
        const saved = res.roteiro
        if (saved) updatePlan(myKey, (p) => ({ ...p, roteiro: saved })) // traz o rev novo
        return true
      }
      if (res.code === 'roteiro_conflict') {
        const latest = res.current
        updatePlan(myKey, (p) => ({ ...p, roteiro: latest })) // desfaz o otimista já
      } else {
        void load('reload') // desfaz o otimista
      }
      fail(res, 'Não consegui mudar o status da etapa') // conflito: toast 'aviso' e recarrega
      return false
    },
    [projectCwd, slug, myKey, updatePlan, fail, load]
  )

  return { status, plan, error, born, reload, saveCard, deleteCard, saveLayout, saveViewport, toggleEtapa }
}
