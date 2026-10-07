/**
 * Estado da aba Planos, fora dos componentes (sobrevive à troca de aba): as listas
 * por projeto, o plano aberto (Etapas | Chat), o card na folha de baixo e o texto
 * que "Comentar no chat" põe no campo. Só leitura do plano: quem mexe nos cards é
 * o Agent Manager. Ao vivo: o aviso `planning-changed` do SSE relê SÓ o plano
 * aberto (com um debounce curto — o Manager grava vários cards seguidos).
 */
import { refLabel } from '@renderer/planning/cardRefs'
import { client, openConversation, toast } from '../app/runtime'
import type { ComposerDraft } from '../composer/Composer'
import { CENTRAL_CONV_ID } from '../core/client'
import { createPlan, getPlan, listPlans, planningChange, toPlanningError, type PlanningError } from '../core/planning'
import { createStore } from '../core/store'
import type { BridgeEvent, ConvSummary, PlanningChangedEvent, RemotePlan, RemotePlanSummary } from '../core/types'

export interface PlanRef {
  cwd: string
  slug: string
}

export interface ProjectPlans {
  plans: RemotePlanSummary[] | null
  loading: boolean
  error: string | null
  /** Pasta do projeto que não existe mais neste PC (not_found) ou que a ponte não conhece: o grupo some da lista. */
  hidden?: boolean
}

export type PlanTabView = 'etapas' | 'chat'

export interface PlanningUi {
  /** Planos de cada projeto (cwd → lista). */
  lists: Record<string, ProjectPlans>
  /** Projetos abertos na lista (tudo começa recolhido). */
  expanded: Record<string, boolean>
  /** O PC não tem as rotas /api/planning: "atualize o app do PC". */
  oldPc: boolean
  open: PlanRef | null
  plan: RemotePlan | null
  planLoading: boolean
  planError: string | null
  view: PlanTabView
  /** Id do card na folha de baixo. */
  card: string | null
  /** Texto a pôr no campo do Chat ("Comentar no chat"). */
  draft: ComposerDraft | null
  /** Coluna (etapa) visível. */
  stage: number
  /** Folha "+ Novo planejamento" aberta (com o projeto já escolhido, se veio do "+" do grupo). */
  creating: { cwd: string } | null
}

export const RELOAD_DEBOUNCE_MS = 350

const INITIAL: PlanningUi = {
  lists: {}, expanded: {}, oldPc: false, open: null, plan: null, planLoading: false, planError: null,
  view: 'etapas', card: null, draft: null, stage: 0, creating: null
}

export const planUi = createStore<PlanningUi>({ ...INITIAL })

/** Para testes. */
export function resetPlanUi(): void {
  planReq++
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = null
  planUi.set({ ...INITIAL })
}

/** Os projetos que o PC conhece (os mesmos que a ponte aceita): os do retrato e os das conversas. */
export function knownProjects(projects: string[], conversations: ConvSummary[]): string[] {
  const out: string[] = []
  for (const p of [...projects, ...conversations.filter((c) => c.id !== CENTRAL_CONV_ID).map((c) => c.cwd)]) {
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

/** A conversa do Agent Manager do plano (a mais recente, se houver mais de uma). */
export function managerConv(conversations: ConvSummary[], ref: PlanRef | null): ConvSummary | null {
  if (!ref) return null
  let best: ConvSummary | null = null
  for (const c of conversations) {
    if (c.mode !== 'planning' || c.planningSlug !== ref.slug || c.cwd !== ref.cwd) continue
    if (!best || c.updatedAt > best.updatedAt) best = c
  }
  return best
}

function setList(cwd: string, patch: Partial<ProjectPlans>): void {
  const empty: ProjectPlans = { plans: null, loading: false, error: null }
  planUi.set((s) => ({ lists: { ...s.lists, [cwd]: { ...empty, ...s.lists[cwd], ...patch } } }))
}

function noteError(err: PlanningError): string {
  if (err.kind === 'old-pc') planUi.set({ oldPc: true })
  return err.message
}

/** Lê a lista de cada projeto (em paralelo; a tela mostra o que já chegou). */
export async function loadLists(cwds: string[]): Promise<void> {
  await Promise.all(
    cwds.map(async (cwd) => {
      setList(cwd, { loading: true })
      try {
        const plans = await listPlans(client, cwd)
        setList(cwd, { plans, loading: false, error: null, hidden: false })
      } catch (e) {
        const err = toPlanningError(e)
        const hidden = err.kind === 'failure' && (err.code === 'not_found' || err.code === 'unknown_project')
        setList(cwd, { loading: false, error: noteError(err), hidden })
      }
    })
  )
}

export function toggleProject(cwd: string): void {
  planUi.set((s) => ({ expanded: { ...s.expanded, [cwd]: !s.expanded[cwd] } }))
}

// ---- plano aberto ------------------------------------------------------------------

let planReq = 0
let reloadTimer: ReturnType<typeof setTimeout> | null = null

export function openPlan(ref: PlanRef): void {
  planUi.set({ open: ref, plan: null, planError: null, view: 'etapas', card: null, draft: null, stage: 0 })
  void loadPlan(false)
}

export function closePlan(): void {
  planReq++
  planUi.set({ open: null, plan: null, planError: null, planLoading: false, card: null, draft: null })
}

/** Relê o plano aberto. `silent`: atualização ao vivo, sem tirar a tela. Plano apagado: volta à lista com aviso. */
export async function loadPlan(silent = true): Promise<void> {
  const ref = planUi.get().open
  if (!ref) return
  const req = ++planReq
  if (!silent) planUi.set({ planLoading: true })
  try {
    const plan = await getPlan(client, ref.cwd, ref.slug)
    if (req !== planReq) return
    const card = planUi.get().card
    planUi.set({ plan, planLoading: false, planError: null, card: card && plan.cards.some((c) => c.id === card) ? card : null })
  } catch (e) {
    if (req !== planReq) return
    const err = toPlanningError(e)
    if (err.kind === 'failure' && err.code === 'not_found') {
      closePlan()
      toast('Este plano não existe mais no PC.', 'aviso')
      void loadLists([ref.cwd])
      return
    }
    // Falha de rede numa releitura silenciosa: fica com o que já está na tela.
    if (silent && planUi.get().plan) return
    planUi.set({ planLoading: false, planError: noteError(err) })
  }
}

/** Aviso do PC: um plano mudou. Relê só se for o aberto (debounce: o Manager grava em rajada). */
export function onPlanningChanged(ev: PlanningChangedEvent): void {
  const open = planUi.get().open
  if (!open || open.cwd !== ev.projectCwd || open.slug !== ev.slug) return
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    reloadTimer = null
    void loadPlan(true)
  }, RELOAD_DEBOUNCE_MS)
}

/** Assina o SSE da ponte (client.eventTaps). Devolve o desligar. */
export function watchPlanningEvents(): () => void {
  const tap = (msg: BridgeEvent): void => {
    const ev = planningChange(msg)
    if (ev) onPlanningChanged(ev)
  }
  client.eventTaps.add(tap)
  return () => {
    client.eventTaps.delete(tap)
  }
}

// ---- card, chat e novo planejamento ---------------------------------------------------

export function openCard(id: string): void {
  planUi.set({ card: id })
}

export function closeCard(): void {
  planUi.set({ card: null })
}

export function setView(view: PlanTabView): void {
  planUi.set({ view })
}

/** "Comentar no chat": fecha a folha e abre o Chat com `[[Título]] ` no campo. */
export function commentOnCard(id: string): void {
  const plan = planUi.get().plan
  const card = plan?.cards.find((c) => c.id === id)
  if (!plan || !card) return
  planUi.set({ card: null, view: 'chat', draft: { text: `[[${refLabel(card, plan.cards)}]] `, nonce: ++draftSeq } })
}

let draftSeq = 0

/** O Composer do Chat já pôs o texto no campo: não entra de novo ao remontar. */
export function clearDraft(): void {
  if (planUi.get().draft) planUi.set({ draft: null })
}

export function startCreate(cwd = ''): void {
  planUi.set({ creating: { cwd } })
}

export function cancelCreate(): void {
  planUi.set({ creating: null })
}

/** POST create → a conversa do Manager (otimista até o próximo /api/state) → abre o chat dela. */
export async function submitCreate(cwd: string, pedido: string): Promise<void> {
  const convId = await createPlan(client, cwd, pedido)
  planUi.set({ creating: null })
  if (!client.state.conversations.some((c) => c.id === convId)) {
    const optimistic: ConvSummary = { id: convId, title: 'Novo planejamento', cwd, busy: !!pedido.trim(), connected: false, updatedAt: Date.now(), queued: [], mode: 'planning' }
    client.store.set((s) => ({ conversations: [optimistic, ...s.conversations] }))
  }
  toast('Planejamento criado: abrindo a conversa do Agent Manager.', 'sucesso')
  openConversation(convId)
  setTimeout(() => void client.fetchState().catch(() => undefined), 800)
}
