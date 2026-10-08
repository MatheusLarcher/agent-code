/**
 * Os planos na TV (req-planejamento-sala): as conversas de planejamento do
 * escritório, qual delas a TV mostra e o resumo de cada plano para a textura.
 *
 *   feed(feed, present, now)  os planos de quem está no escritório e a conversa ativa;
 *   current(keep)             o plano da TV: o escolhido (clique no Manager, aba
 *                             do foco), senão o da conversa ativa, senão o mais
 *                             recente — sempre dentro do filtro de projeto;
 *   all(keep)                 os planos para as abas do foco;
 *   peek(plan)                o resumo (título, etapas, cards, ambiguidades) lido
 *                             pelo main sem abrir a vigia; null enquanto não chega.
 *                             Relido quando o plano muda (planning:changed) ou a cada PEEK_MS.
 *
 * O cache dos resumos (PlanPeeks) é um por ponte (planPeeksFor): a TV e as telas
 * que numeram "Etapa N de M" pelo roteiro (o topo do chat, a aba Implantação —
 * usePlanRoteiro) leem o mesmo, sem pedir duas vezes.
 */
import type { PlanningChangedMsg, PlanningRef, PlanningResult } from '@shared/ipc'
import type { PlanningPeekDto } from '@shared/officeApi'
import type { PlanRoteiro } from '@shared/stepProgress'
import type { OfficeFeed } from '../office/adapter/feed'
import { principalKey } from '../office/adapter/model'
import { DEMO_PLAN_ID, demoPlanPeek } from './demoPlan'
import type { TvPlan } from './tvAgenda'

/** Releitura do resumo mesmo sem aviso de mudança. */
export const PEEK_MS = 60_000

export interface PeekApi {
  planningPeek?(req: PlanningRef): Promise<PlanningResult<{ plan: PlanningPeekDto }>>
  onPlanningChanged?(cb: (msg: PlanningChangedMsg) => void): () => void
}

export function appPeekApi(): PeekApi | null {
  return (globalThis as { window?: { api?: PeekApi } }).window?.api ?? null
}

/** Um plano no cache: a pasta do projeto e o slug. */
export interface PeekRef {
  cwd: string
  slug: string
}

const keyOf = (p: PeekRef): string => `${p.cwd.toLowerCase()}\u0000${p.slug}`

/**
 * Os resumos de uma ponte: um pedido por vez por plano, relido quando o plano
 * muda (planning:changed — quem assina é avisado, para reler) ou a cada PEEK_MS;
 * a chegada de um resumo avisa quem assina.
 */
export class PlanPeeks {
  private readonly peeks = new Map<string, { peek: PlanningPeekDto | null; at: number; loading: boolean }>()
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly api: PeekApi & Required<Pick<PeekApi, 'planningPeek'>>,
    private readonly clock: () => number = () => Date.now()
  ) {
    api.onPlanningChanged?.((m) => {
      const p = this.peeks.get(keyOf({ cwd: m.projectCwd, slug: m.slug }))
      if (!p) return
      p.at = -Infinity
      this.emit()
    })
  }

  /** O resumo em cache, sem pedir nada. */
  cached(ref: PeekRef): PlanningPeekDto | null {
    return this.peeks.get(keyOf(ref))?.peek ?? null
  }

  /** O resumo (pede ao main se faltar ou estiver velho); null enquanto não chega. */
  get(ref: PeekRef): PlanningPeekDto | null {
    const k = keyOf(ref)
    const cur = this.peeks.get(k)
    const now = this.clock()
    if (!cur?.loading && (!cur || now - cur.at >= PEEK_MS)) {
      const entry = { peek: cur?.peek ?? null, at: now, loading: true }
      this.peeks.set(k, entry)
      void Promise.resolve(this.api.planningPeek({ projectCwd: ref.cwd, slug: ref.slug }))
        .then((r) => {
          entry.loading = false
          if (!r?.ok) return
          entry.peek = r.plan
          this.emit()
        })
        .catch(() => {
          entry.loading = false
        })
    }
    return cur?.peek ?? null
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }

  private emit(): void {
    for (const cb of [...this.listeners]) cb()
  }
}

const byApi = new WeakMap<object, PlanPeeks>()

/** O cache da ponte (o mesmo para a TV e as telas do app); null sem planning:peek. */
export function planPeeksFor(api: PeekApi | null, clock?: () => number): PlanPeeks | null {
  if (!api || typeof api.planningPeek !== 'function') return null
  let cache = byApi.get(api)
  if (!cache) {
    cache = new PlanPeeks(api as PeekApi & Required<Pick<PeekApi, 'planningPeek'>>, clock)
    byApi.set(api, cache)
  }
  return cache
}

/** O roteiro do resumo (as etapas com id, na ordem); null sem resumo ou sem o id de alguma etapa (a demo). */
export function roteiroOfPeek(peek: PlanningPeekDto | null): PlanRoteiro | null {
  if (!peek) return null
  const out: { id: string; titulo: string }[] = []
  for (const e of peek.etapas) {
    if (!e.id) return null
    out.push({ id: e.id, titulo: e.titulo })
  }
  return out
}

export class TvPlans {
  private list: Array<TvPlan & { at: number }> = []
  private activeId: string | null = null
  private readonly peeks: PlanPeeks | null
  private readonly off: () => void
  /** O plano escolhido (a conversa); null = automático. */
  prefer: string | null = null
  /** Modo demonstração: o plano da demo tem o resumo falso (demoPlan.ts). */
  demo = false

  constructor(
    api: PeekApi | null,
    /** Resumo novo: a TV redesenha. */
    onReady: () => void,
    private readonly clock: () => number = () => Date.now()
  ) {
    this.peeks = planPeeksFor(api, clock)
    this.off = this.peeks?.subscribe(onReady) ?? (() => {})
  }

  feed(feed: OfficeFeed | null, present: ReadonlySet<string>): void {
    this.activeId = feed?.activeId ?? null
    this.list = (feed?.conversations ?? [])
      .filter((c) => c.mode === 'planning' && !!c.planningSlug && !!c.cwd && present.has(principalKey(c.id)))
      .map((c) => ({ convId: c.id, cwd: c.cwd, slug: c.planningSlug as string, title: c.title || c.planningSlug || 'Plano', at: c.updatedAt }))
  }

  all(keep: (convId: string) => boolean): TvPlan[] {
    return this.list.filter((p) => keep(p.convId)).sort((a, b) => b.at - a.at)
  }

  current(keep: (convId: string) => boolean): TvPlan | null {
    const list = this.all(keep)
    return list.find((p) => p.convId === this.prefer) ?? list.find((p) => p.convId === this.activeId) ?? list[0] ?? null
  }

  /** O resumo do plano (pede ao main se faltar ou estiver velho). */
  peek(plan: TvPlan): PlanningPeekDto | null {
    if (this.demo && plan.convId === DEMO_PLAN_ID) return demoPlanPeek(this.clock())
    return this.peeks?.get(plan) ?? null
  }

  dispose(): void {
    this.off()
  }
}
