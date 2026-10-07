/**
 * window.api falso para os testes da Tela de Planejamento. Não é teste (não
 * casa com *.test.*): só o que os testes de planning/ importam.
 */
import { vi } from 'vitest'
import type {
  OpenedPlanningDto,
  PlanningCardDto,
  PlanningChangedMsg,
  PlanningHandoffDto,
  PlanningHandoffListDto,
  PlanningHandoffSentDto,
  PlanningHandoffSentMark,
  PlanningResult,
  PlanningRoteiroDto,
  PlanMediaDto
} from '@shared/ipc'

export const CWD = 'C:\\proj\\app'
export const SLUG = 'plano'
/** Pasta do plano como o main a devolve (na pasta de dados do app, fora do projeto). */
export const PLAN_DIR = 'D:\\dados\\agent-code\\planning\\app\\plano'
export const SANDBOX_DIR = 'C:\\proj\\app\\docs\\spec\\plano\\_sandbox'

export function makeCard(id: string, over: Partial<PlanningCardDto> = {}): PlanningCardDto {
  return { id, tipo: 'requisito', titulo: `Card ${id}`, links: [], rev: 1, corpo: '', ...over }
}

export function makePlan(over: Partial<OpenedPlanningDto> = {}): OpenedPlanningDto {
  return {
    slug: SLUG,
    dir: PLAN_DIR,
    sandboxDir: SANDBOX_DIR,
    roteiro: {
      titulo: 'Plano de teste',
      rev: 3,
      etapas: [
        { id: 'requisitos', titulo: 'Levantar requisitos', status: 'concluida' },
        { id: 'desenho', titulo: 'Desenhar a solução', status: 'pendente' },
        { id: 'entrega', titulo: 'Entregar', status: 'em_andamento' }
      ]
    },
    cards: [
      makeCard('login', { etapa: 'requisitos', titulo: 'Login com SSO', rev: 4, corpo: 'Primeira linha\nSegunda' }),
      makeCard('banco', { tipo: 'decisao', etapa: 'desenho', titulo: 'Usar Postgres', rev: 2 })
    ],
    layout: { positions: {} },
    invalid: [],
    media: [],
    ...over
  }
}

export function mockPlanningApi(initial: OpenedPlanningDto = makePlan()) {
  let plan = initial
  const listeners = new Set<(msg: PlanningChangedMsg) => void>()
  /** O _handoff/ do plano, em ordem de gravação. */
  const handoffs: PlanningHandoffDto[] = []
  /** O _handoff/enviados.json do plano. */
  const sent: PlanningHandoffSentDto[] = []
  /** Os prompts ANTIGOS (gravados antes da última mudança do plano), por nome. */
  const stale = new Set<string>()
  /** O que o "Descartar os antigos" moveu para _handoff/_descartados/. */
  const discarded: string[] = []
  const addHandoff = (content: string, createdAt = Date.now()): string => {
    const name = `2026-09-22-${String(handoffs.length + discarded.length + 1).padStart(2, '0')}.md`
    handoffs.push({ name, createdAt, content })
    return name
  }
  const sentNames = (): Set<string> => new Set(sent.map((e) => e.nome))
  const api = {
    planningOpen: vi.fn(async () => ({ ok: true as const, plan: structuredClone(plan) })),
    planningClose: vi.fn(async () => ({ ok: true as const })),
    planningSaveCard: vi.fn(async (req: { card: PlanningCardDto; expectedRev: number }) => ({
      ok: true as const,
      card: { ...req.card, rev: req.expectedRev + 1 }
    })),
    planningDeleteCard: vi.fn(async () => ({ ok: true as const })),
    /** Como o main: devolve o roteiro gravado com rev = expectedRev + 1. */
    planningSaveRoteiro: vi.fn(async (req: { roteiro: Omit<PlanningRoteiroDto, 'rev'>; expectedRev: number }) => ({
      ok: true as const,
      roteiro: { ...req.roteiro, rev: req.expectedRev + 1 } as PlanningRoteiroDto
    })),
    planningSaveLayout: vi.fn(async () => ({ ok: true as const })),
    planningListHandoffs: vi.fn(
      async (): Promise<PlanningResult<PlanningHandoffListDto>> => ({
        ok: true as const,
        handoffs: structuredClone(handoffs),
        sent: structuredClone(sent),
        // Como o main: só os antigos ainda NÃO enviados.
        ...(stale.size > 0 ? { stale: handoffs.map((h) => h.name).filter((n) => stale.has(n) && !sentNames().has(n)) } : {})
      })
    ),
    /** Como o main: move os antigos não enviados (todos, ou só `names`). */
    planningDiscardHandoffs: vi.fn(async (req: { names?: string[] }) => {
      const moved = handoffs
        .map((h) => h.name)
        .filter((n) => stale.has(n) && !sentNames().has(n) && (!req.names || req.names.includes(n)))
      for (const name of moved) {
        handoffs.splice(handoffs.findIndex((h) => h.name === name), 1)
        stale.delete(name)
        discarded.push(name)
      }
      return { ok: true as const, discarded: moved }
    }),
    /** Como o main: numera e grava; devolve o nome do arquivo novo. */
    planningWriteHandoff: vi.fn(async (req: { conteudo: string }) => ({ ok: true as const, name: addHandoff(req.conteudo) })),
    /** Como o main: upsert por nome, carimba a hora, devolve todos. */
    planningMarkHandoffsSent: vi.fn(
      async (req: { entries: PlanningHandoffSentMark[] }): Promise<PlanningResult<{ sent: PlanningHandoffSentDto[] }>> => {
        for (const m of req.entries) {
          const i = sent.findIndex((e) => e.nome === m.nome)
          if (i >= 0) sent.splice(i, 1)
          sent.push({ ...m, enviadoEm: '2026-09-25T12:00:00.000Z' })
        }
        return { ok: true as const, sent: structuredClone(sent) }
      }
    ),
    /** Sem disco: nenhuma mídia nova; os testes da tela trocam a implementação. */
    planningImportMedia: vi.fn(async () => ({ ok: true as const, media: [] as PlanMediaDto[] })),
    planningReadMedia: vi.fn(async () => ({ ok: false as const, code: 'not_found' as const, message: 'mídia não encontrada' })),
    onPlanningChanged: vi.fn((cb: (msg: PlanningChangedMsg) => void) => {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    })
  }
  ;(window as unknown as { api: unknown }).api = api
  return {
    api,
    /** O que está em _handoff/ agora. */
    handoffs,
    /** O que está em _handoff/enviados.json agora. */
    sent,
    /** Os nomes marcados como antigos (o main os acha pela data). */
    stale,
    /** O que foi para _handoff/_descartados/. */
    discarded,
    /** Um arquivo novo em _handoff/ gravado "por fora" (ex.: o Manager). */
    addHandoff,
    /** Troca o que o próximo planningOpen devolve (o "disco"). */
    setPlan(next: OpenedPlanningDto): void {
      plan = next
    },
    emitChanged(msg: PlanningChangedMsg): void {
      for (const cb of [...listeners]) cb(msg)
    },
    listenerCount: (): number => listeners.size
  }
}

/** React Flow mede os nós com ResizeObserver, que o jsdom não tem. */
export function stubResizeObserver(): void {
  const g = globalThis as unknown as { ResizeObserver?: unknown }
  if (g.ResizeObserver) return
  g.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
}
