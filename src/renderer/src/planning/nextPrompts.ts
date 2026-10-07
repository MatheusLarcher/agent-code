import type { HandoffProjectFolder, HandoffProjectSnapshot } from '@shared/handoffProject'
import { projectFolderKey } from '@shared/handoffProject'
import { CARD_ETAPA_PREFIX, type HandoffQueueItem } from '@shared/handoffTracking'

/**
 * A faixa "Próximos prompts" (regras puras, sem React): os prompts que esperam
 * no quadro, agrupados por PLANO — nunca um prompt de um plano entre os de
 * outro —, com o texto de cada item, o estado e as ações que cabem nele. Os
 * dados vêm do main (handoff:queueList e a foto da fila do projeto).
 */

export type NextPromptAction = 'editar' | 'tirar' | 'enviar' | 'cancelar'
export type NextPlanAction = 'comecar' | 'passar'

export interface NextPromptView {
  item: HandoffQueueItem
  /** "#2 · Prompt 2 de 3 — etapas: [x] Título, [y] Título · ~40 min". */
  text: string
  /** "esperando a vez", "parada: <motivo>", "segurada pelo PO: <motivo>"… */
  state: string
  stopped: boolean
  actions: NextPromptAction[]
}

export interface NextPlanView {
  loteId: string
  conversationId: string
  conversationTitle: string
  planTitulo: string
  /** "Plano X — 3 prompts · ~2 h · esperando o plano Y terminar". */
  header: string
  /** A avaliação do PO sobre este plano, quando há. */
  note: string | null
  registro: string | null
  actions: NextPlanAction[]
  /** De quem é a vez (o "Passar a vez" age nele). */
  holderConversationId: string | null
  holderTitulo: string | null
  prompts: NextPromptView[]
}

/** "~40 min", "~2 h", "~1 h 30". */
export function fmtMinutes(min: number | null): string | null {
  if (min === null || !(min > 0)) return null
  if (min < 60) return `~${Math.round(min)} min`
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return m === 0 ? `~${h} h` : `~${h} h ${String(m).padStart(2, '0')}`
}

export function promptText(item: HandoffQueueItem, position: number): string {
  // A rotina autorizada: o texto é fixo, montado pelo código (só o título do cartão entra).
  if (item.estado === 'rotina') return `#${position} · Rotina: ${item.conteudo}`
  // O "Pedido do PO" leva cartões (`card:<id>`), não etapas do roteiro: só os títulos.
  const cards = item.etapas.every((e) => e.id.startsWith(CARD_ETAPA_PREFIX))
  const etapas =
    item.etapas.length === 0
      ? ''
      : cards
        ? ` — tarefas: ${item.etapas.map((e) => e.titulo).join(', ')}`
        : ` — etapas: ${item.etapas.map((e) => `[${e.id}] ${e.titulo}`).join(', ')}`
  const time = fmtMinutes(item.estimativaTotal)
  return `#${position} · Prompt ${item.ordem} de ${Math.max(item.totalPrompts, item.ordem)}${etapas}${time ? ` · ${time}` : ''}`
}

/** O estado do item, como a faixa o mostra. */
export function promptState(item: HandoffQueueItem): string {
  if (item.estado === 'parada') return item.motivo ? `parada: ${item.motivo}` : 'parada'
  if (item.estado === 'segurada') return item.motivo ? `segurada pelo PO: ${item.motivo}` : 'segurada pelo PO'
  if (item.estado === 'rotina') return item.motivo ?? 'rotina autorizada'
  return 'esperando a vez'
}

function folderOf(snapshot: HandoffProjectSnapshot | null, cwd: string): HandoffProjectFolder | undefined {
  if (!snapshot) return undefined
  const key = projectFolderKey(cwd, snapshot.caseInsensitive)
  return snapshot.folders.find((f) => f.key === key)
}

const files = (n: number): string => (n === 1 ? '1 arquivo' : `${n} arquivos`)

/** O que a fila do projeto diz deste plano: o cabeçalho, a nota do PO e as ações. */
function planSituation(folder: HandoffProjectFolder | undefined, loteId: string) {
  const plans = folder?.plans ?? []
  const plan = plans.find((p) => p.loteId === loteId)
  const holder = plans[0] ?? null
  let state: string | null = null
  const actions: NextPlanAction[] = []
  if (plan && holder && plan.posicao > 1) {
    state = `esperando o plano "${holder.planTitulo}" terminar`
    if (holder.estado === 'parado') actions.push('passar')
  } else if (plan && !plan.comecou && plan.sujo) {
    state = `${files(plan.sujo)} sem commit nesta pasta`
    actions.push('comecar')
  } else if (plan && plans.some((p) => p.loteId !== loteId && p.estado === 'rodando')) {
    const running = plans.find((p) => p.loteId !== loteId && p.estado === 'rodando')
    state = `esperando o prompt atual do plano "${running?.planTitulo}" terminar`
  }
  let note: string | null = null
  const evaluation = folder?.avaliacao
  if (evaluation?.kind === 'vez' && evaluation.loteB === loteId) {
    if (evaluation.decisao === 'COMECAR') {
      const dirty = plan?.arquivosDoAnterior.length ?? 0
      note = `o PO começou este plano: ${evaluation.motivo}${dirty > 0 ? ` — com ${files(dirty)} do plano anterior sem commit` : ''}`
    } else note = `o PO avaliou: esperar você — ${evaluation.motivo}`
  } else if (folder?.avaliando === 'vez' && plan && plan.posicao === 2) {
    note = 'o PO está avaliando se este plano começa'
  }
  return {
    state,
    note,
    registro: note && evaluation?.registro ? evaluation.registro : null,
    actions,
    holderConversationId: holder && holder.loteId !== loteId ? holder.conversationId : null,
    holderTitulo: holder && holder.loteId !== loteId ? holder.planTitulo : null
  }
}

/**
 * Os planos da faixa, na ordem da fila do projeto (planos fora dela vêm
 * depois, pela ordem da lista). `conversationId` recorta "Esta conversa".
 */
export function nextPlans(
  items: readonly HandoffQueueItem[],
  snapshot: HandoffProjectSnapshot | null,
  opts: { conversationId?: string } = {}
): NextPlanView[] {
  const shown = opts.conversationId ? items.filter((i) => i.conversationId === opts.conversationId) : items
  const byLote = new Map<string, HandoffQueueItem[]>()
  for (const item of shown) byLote.set(item.loteId, [...(byLote.get(item.loteId) ?? []), item])
  const lotes = [...byLote.values()].map((list) => [...list].sort((a, b) => a.ordem - b.ordem))
  lotes.sort((a, b) => (a[0].planPosicao ?? Infinity) - (b[0].planPosicao ?? Infinity))
  let position = 0
  return lotes.map((list) => {
    const first = list[0]
    const situation = planSituation(folderOf(snapshot, first.projectCwd), first.loteId)
    const minutes = list.reduce<number | null>((sum, i) => (i.estimativaTotal === null ? sum : (sum ?? 0) + i.estimativaTotal), null)
    // A rotina autorizada não é prompt do plano.
    const count = list.filter((i) => i.estado !== 'rotina').length
    const header = [
      `Plano ${first.planTitulo} — ${count === 1 ? '1 prompt' : `${count} prompts`}${count < list.length ? ' + rotina' : ''}`,
      fmtMinutes(minutes),
      situation.state
    ]
      .filter(Boolean)
      .join(' · ')
    const prompts = list.map((item, index): NextPromptView => {
      position += 1
      const stopped = item.estado === 'parada' || item.estado === 'segurada'
      const actions: NextPromptAction[] =
        item.estado === 'rotina' ? ['cancelar'] : [...(index === 0 && stopped ? (['enviar'] as const) : []), 'editar', 'tirar']
      return { item, text: promptText(item, position), state: promptState(item), stopped, actions }
    })
    return {
      loteId: first.loteId,
      conversationId: first.conversationId,
      conversationTitle: first.conversationTitle,
      planTitulo: first.planTitulo,
      header,
      note: situation.note,
      registro: situation.registro,
      actions: situation.actions,
      holderConversationId: situation.holderConversationId,
      holderTitulo: situation.holderTitulo,
      prompts
    }
  })
}

/** Nova ordem depois de soltar `id` antes de `beforeId` (ou no fim, sem ele). */
export function moveBefore(ids: readonly string[], id: string, beforeId: string | null): string[] {
  const rest = ids.filter((x) => x !== id)
  const at = beforeId ? rest.indexOf(beforeId) : rest.length
  rest.splice(at < 0 ? rest.length : at, 0, id)
  return rest
}

/** O aviso no chat da implantação: quantos esperam e, se o primeiro parou, por quê. */
export function chatQueueNotice(
  items: readonly HandoffQueueItem[],
  conversationId: string
): { count: number; text: string; stopped: boolean } | null {
  const mine = items.filter((i) => i.conversationId === conversationId).sort((a, b) => a.ordem - b.ordem)
  if (mine.length === 0) return null
  const head = mine[0]
  const base = mine.length === 1 ? '1 prompt esperando no quadro' : `${mine.length} prompts esperando no quadro`
  const why = head.motivo ? `: ${head.motivo}` : ''
  if (head.estado === 'parada') return { count: mine.length, text: `${base} — o próximo parou${why}`, stopped: true }
  if (head.estado === 'segurada') return { count: mine.length, text: `${base} — o PO segurou o próximo${why}`, stopped: true }
  return { count: mine.length, text: base, stopped: false }
}
