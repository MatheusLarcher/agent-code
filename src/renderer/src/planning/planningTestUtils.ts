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
  PlanningRoteiroDto
} from '@shared/ipc'

export const CWD = 'C:\\proj\\app'
export const SLUG = 'plano'

export function makeCard(id: string, over: Partial<PlanningCardDto> = {}): PlanningCardDto {
  return { id, tipo: 'requisito', titulo: `Card ${id}`, links: [], rev: 1, corpo: '', ...over }
}

export function makePlan(over: Partial<OpenedPlanningDto> = {}): OpenedPlanningDto {
  return {
    slug: SLUG,
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
    ...over
  }
}

export function mockPlanningApi(initial: OpenedPlanningDto = makePlan()) {
  let plan = initial
  const listeners = new Set<(msg: PlanningChangedMsg) => void>()
  /** O _handoff/ do plano, em ordem de gravação. */
  const handoffs: PlanningHandoffDto[] = []
  const addHandoff = (content: string, createdAt = Date.now()): string => {
    const name = `2026-09-22-${String(handoffs.length + 1).padStart(2, '0')}.md`
    handoffs.push({ name, createdAt, content })
    return name
  }
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
    planningListHandoffs: vi.fn(async () => ({ ok: true as const, handoffs: structuredClone(handoffs) })),
    /** Como o main: numera e grava; devolve o nome do arquivo novo. */
    planningWriteHandoff: vi.fn(async (req: { conteudo: string }) => ({ ok: true as const, name: addHandoff(req.conteudo) })),
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
