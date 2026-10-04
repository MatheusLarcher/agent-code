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
 */
import type { PlanningChangedMsg, PlanningRef, PlanningResult } from '@shared/ipc'
import type { PlanningPeekDto } from '@shared/officeApi'
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

const keyOf = (p: { cwd: string; slug: string }): string => `${p.cwd.toLowerCase()}\u0000${p.slug}`

export class TvPlans {
  private list: Array<TvPlan & { at: number }> = []
  private activeId: string | null = null
  private readonly peeks = new Map<string, { peek: PlanningPeekDto | null; at: number; loading: boolean }>()
  private readonly off: () => void
  private disposed = false
  /** O plano escolhido (a conversa); null = automático. */
  prefer: string | null = null
  /** Modo demonstração: o plano da demo tem o resumo falso (demoPlan.ts). */
  demo = false

  constructor(
    private readonly api: PeekApi | null,
    /** Resumo novo: a TV redesenha. */
    private readonly onReady: () => void,
    private readonly clock: () => number = () => Date.now()
  ) {
    this.off =
      api?.onPlanningChanged?.((m) => {
        const k = keyOf({ cwd: m.projectCwd, slug: m.slug })
        const p = this.peeks.get(k)
        if (p) p.at = -Infinity
      }) ?? (() => {})
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
    const k = keyOf(plan)
    const cur = this.peeks.get(k)
    const now = this.clock()
    if (this.api?.planningPeek && !cur?.loading && (!cur || now - cur.at >= PEEK_MS)) {
      const entry = { peek: cur?.peek ?? null, at: now, loading: true }
      this.peeks.set(k, entry)
      void this.api
        .planningPeek({ projectCwd: plan.cwd, slug: plan.slug })
        .then((r) => {
          entry.loading = false
          if (this.disposed || !r.ok) return
          entry.peek = r.plan
          this.onReady()
        })
        .catch(() => {
          entry.loading = false
        })
    }
    return cur?.peek ?? null
  }

  dispose(): void {
    this.disposed = true
    this.off()
  }
}
