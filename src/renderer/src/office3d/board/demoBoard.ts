/**
 * O Quadro falso do modo demonstração do 3D (Ctrl+Alt+Shift+D, só DEV) — PURO
 * e determinístico pelo relógio, no mesmo laço de DEMO_LOOP_MS do demoFeed.
 * Cada sala da demo (pelo nome da pasta do projeto) mostra um caso:
 *
 *   agent-code      quadro vivo: a cada ~8 s uma mudança de um tipo e de um
 *                   autor (agente, PO com motivo, sistema, você), com a linha do tempo —
 *                   o roteiro da coreografia: o agente fecha uma e abre outra na
 *                   MESMA ida (s 8), uma conversa fora do escritório (s 20: selo)
 *                   e todos os tipos (novo, mover, concluir, renomear, justificar,
 *                   dispensar, restaurar);
 *   loja-virtual    22 cartões (pilhas "+K");
 *   erp-itp         o mesmo roteiro do agent-code, deslocado;
 *   portal-aluno    quadro vazio;
 *   api-pagamentos  quadro indisponível (banco fora).
 *
 * Arrastar na demo grava por cima do roteiro até o laço recomeçar; mover para
 * "Fazendo" é recusado com a mesma mensagem do main sem sessão viva.
 */
import type { BoardItem, BoardItemEvent, BoardItemEventActor, BoardItemStatus, ProjectBoard } from '@shared/ipc'
import { boardTurnEndReason } from '@shared/ipc'
import { DEMO_LOOP_MS } from '../demoTimeline'
import type { BoardApi } from './boardSync'

type Change =
  | { s: number; id: string; kind: 'created'; actor: BoardItemEventActor; title: string; status: BoardItemStatus; conv: number; po?: boolean; note?: string }
  | { s: number; id: string; kind: 'status_changed'; actor: BoardItemEventActor; status: BoardItemStatus; note?: string; turnEnd?: boolean }
  | { s: number; id: string; kind: 'retitled' | 'justified' | 'dismissed' | 'restored'; actor: BoardItemEventActor; title?: string; note?: string }
  | { s: number; id: string; kind: 'vanished' }

/** O roteiro do quadro vivo (s = segundos no laço). */
const SCRIPT: Change[] = [
  { s: -90, id: 'k1', kind: 'created', actor: 'agent', title: 'Mapear como o quadro chega ao 3D', status: 'completed', conv: 0 },
  { s: -80, id: 'k2', kind: 'created', actor: 'agent', title: 'Desenhar o kanban na parede do fundo', status: 'in_progress', conv: 0 },
  { s: -70, id: 'k3', kind: 'created', actor: 'agent', title: 'Trocar o lazer do post-it por ler o quadro', status: 'pending', conv: 1 },
  { s: -60, id: 'k4', kind: 'created', actor: 'agent', title: 'Cartão grande no clique', status: 'pending', conv: 2 },
  { s: -50, id: 'k5', kind: 'created', actor: 'agent', title: 'Arrastar o papel no 3D para mudar de coluna', status: 'pending', conv: 3 },
  // Uma ida só: o mesmo agente conclui a 2 e anota a 7 no mesmo retrato.
  { s: 8, id: 'k2', kind: 'status_changed', actor: 'agent', status: 'completed' },
  { s: 8, id: 'k7', kind: 'created', actor: 'agent', title: 'Coreografia: o autor leva o papel ao quadro', status: 'in_progress', conv: 0 },
  { s: 16, id: 'k3', kind: 'status_changed', actor: 'agent', status: 'in_progress' },
  // Conversa fora do escritório (sem personagem): o papel desliza com o selo.
  { s: 20, id: 'k8', kind: 'created', actor: 'agent', title: 'Tarefa de uma conversa parada há dias', status: 'pending', conv: 99 },
  { s: 24, id: 'k6', kind: 'created', actor: 'po', title: 'Conferir a sombra do papel no apagão', status: 'pending', conv: 0, po: true, note: 'o agente não testou o quadro com a luz apagada' },
  { s: 32, id: 'k4', kind: 'retitled', actor: 'po', title: 'Abrir o cartão grande ao clicar no papel', note: 'título mais claro para quem lê o quadro' },
  { s: 40, id: 'k5', kind: 'status_changed', actor: 'user', status: 'in_progress', note: 'o usuário moveu o cartão para "Fazendo" pelo quadro' },
  { s: 48, id: 'k1', kind: 'dismissed', actor: 'system', note: 'concluído há mais de 5 dias' },
  { s: 56, id: 'k3', kind: 'status_changed', actor: 'po', status: 'completed', note: 'conferido no app rodando: ninguém prende papel falso' },
  { s: 64, id: 'k1', kind: 'restored', actor: 'user' },
  { s: 72, id: 'k5', kind: 'justified', actor: 'po', note: 'falta testar a recusa sem sessão viva' },
  { s: 80, id: 'k4', kind: 'status_changed', actor: 'system', status: 'pending', turnEnd: true, note: 'o turno terminou sem concluir esta tarefa' },
  { s: 88, id: 'k6', kind: 'vanished' },
  { s: 96, id: 'k8', kind: 'vanished' }
]

interface DemoState {
  items: Map<string, BoardItem>
  events: Map<string, BoardItemEvent[]>
  /** Quantas mudanças do roteiro já valeram (muda → o quadro avisa). */
  step: number
}

const iso = (ms: number): string => new Date(ms).toISOString()

/** O quadro vivo no instante `now` (o roteiro aplicado até ali, deslocado `shift` s). */
function live(now: number, cwd: string, prefix: string, shift: number): DemoState {
  const t = (((now - shift * 1000) % DEMO_LOOP_MS) + DEMO_LOOP_MS) % DEMO_LOOP_MS
  const start = now - t
  const items = new Map<string, BoardItem>()
  const events = new Map<string, BoardItemEvent[]>()
  let step = 0
  let n = 0
  for (const c of SCRIPT) {
    if (c.s * 1000 > t) break
    step++
    const at = iso(start + c.s * 1000)
    const id = `${prefix}${c.id}`
    if (c.kind === 'vanished') {
      items.delete(id)
      continue
    }
    const log = (e: Omit<BoardItemEvent, 'id' | 'boardItemId' | 'at'>): void => {
      const list = events.get(id) ?? []
      list.push({ id: `${id}-e${n++}`, boardItemId: id, at, ...e })
      events.set(id, list)
    }
    const cur = items.get(id)
    if (c.kind === 'created') {
      items.set(id, demoItem(id, cwd, c.title, c.status, `demo-${prefix === 'b-' ? 2 : 0}-${c.conv}`, at, c.po === true, c.note ?? null))
      log({ kind: 'created', actor: c.actor, fromStatus: null, toStatus: c.status, note: c.note ?? null })
      continue
    }
    if (!cur) continue
    const next: BoardItem = { ...cur, revision: cur.revision + 1, updatedAt: at }
    if (c.kind === 'status_changed') {
      const from = cur.poStatus ?? cur.sourceStatus
      if (c.actor === 'agent') Object.assign(next, { sourceStatus: c.status, poStatus: null, poReason: null })
      else Object.assign(next, { poStatus: c.status, poReason: c.turnEnd ? boardTurnEndReason('result') : (c.note ?? null), poAt: at })
      log({ kind: 'status_changed', actor: c.actor, fromStatus: from, toStatus: c.status, note: c.note ?? null })
    } else if (c.kind === 'retitled') {
      Object.assign(next, { poTitle: c.title ?? null, poReason: c.note ?? null, poAt: at })
      log({ kind: 'retitled', actor: c.actor, fromStatus: null, toStatus: null, note: c.note ?? null })
    } else if (c.kind === 'justified') {
      Object.assign(next, { poReason: c.note ?? null, poAt: at })
      log({ kind: 'justified', actor: c.actor, fromStatus: null, toStatus: null, note: c.note ?? null })
    } else {
      next.dismissedAt = c.kind === 'dismissed' ? at : null
      log({ kind: c.kind, actor: c.actor, fromStatus: null, toStatus: null, note: c.note ?? null })
    }
    items.set(id, next)
  }
  return { items, events, step }
}

function demoItem(id: string, cwd: string, title: string, status: BoardItemStatus, conv: string, at: string, po: boolean, note: string | null): BoardItem {
  return {
    id,
    projectId: `demo:${cwd}`,
    projectCwd: cwd,
    conversationId: conv,
    origin: po ? 'po' : 'agent',
    sourceId: po ? null : id,
    sourceTitle: title,
    sourceStatus: status,
    activeForm: null,
    seq: 0,
    poTitle: null,
    poNote: null,
    poStatus: null,
    poReason: po ? note : null,
    poAt: po ? at : null,
    dismissedAt: null,
    revision: 1,
    createdAt: at,
    updatedAt: at
  }
}

const BIG = [
  'Revisar o checkout', 'Cupom de desconto', 'Frete por CEP', 'Página do produto', 'Carrinho persistente', 'Busca com filtros', 'Login com Google',
  'Favoritos', 'Avaliações', 'Estoque baixo', 'Nota fiscal', 'Boleto', 'Pix', 'Cartão em parcelas', 'Rastreio', 'E-mail de pedido', 'Painel do lojista',
  'Relatório de vendas', 'Banner da home', 'SEO das categorias', 'Política de troca', 'Chat de suporte'
]

/** 22 cartões espalhados nas três colunas (pilhas "+K"). */
function big(cwd: string, now: number): BoardItem[] {
  const status = (i: number): BoardItemStatus => (i < 9 ? 'pending' : i < 13 ? 'in_progress' : 'completed')
  return BIG.map((title, i) => ({ ...demoItem(`big-${i}`, cwd, title, status(i), `demo-1-${i % 4}`, iso(now - (i + 1) * 60_000), i === 4, null) }))
}

const projectOf = (cwd: string): string => cwd.split(/[\\/]+/).filter(Boolean).pop() ?? cwd

/** O que o usuário fez por cima do roteiro (arrasto ou dispensar), até o laço recomeçar. */
type Moves = Map<string, { status: BoardItemStatus | 'dismissed'; at: string }>

function boardAt(cwd: string, now: number, moves: Moves): { board: ProjectBoard; events: Map<string, BoardItemEvent[]>; step: number } {
  const project = projectOf(cwd)
  if (project === 'api-pagamentos') return { board: { available: false, items: [] }, events: new Map(), step: 0 }
  if (project === 'portal-aluno') return { board: { available: true, items: [] }, events: new Map(), step: 0 }
  const st = project === 'loja-virtual' ? { items: new Map(big(cwd, now).map((i) => [i.id, i])), events: new Map<string, BoardItemEvent[]>(), step: 0 } : live(now, cwd, project === 'erp-itp' ? 'b-' : 'a-', project === 'erp-itp' ? 37 : 0)
  for (const [id, m] of moves) {
    const it = st.items.get(id)
    if (!it || m.at < it.updatedAt) continue
    if (m.status === 'dismissed') st.items.set(id, { ...it, dismissedAt: m.at })
    else st.items.set(id, { ...it, poStatus: m.status, poReason: 'o usuário moveu o cartão pelo quadro', revision: it.revision + 1, updatedAt: m.at })
  }
  const rank: Record<BoardItemStatus, number> = { in_progress: 0, pending: 1, completed: 2 }
  const items = [...st.items.values()]
    .filter((i) => i.dismissedAt === null)
    .sort((a, b) => rank[a.poStatus ?? a.sourceStatus] - rank[b.poStatus ?? b.sourceStatus] || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  return { board: { available: true, items }, events: st.events, step: st.step }
}

/**
 * O quadro da demo como o window.api do Quadro (o 3D não sabe que é falso). O
 * roteiro anda sozinho: no tique do motor (`tick`, sem timer próprio), cada
 * mudança que passa vira um `board:changed`, como o main faria.
 */
export function demoBoardApi(clock: () => number = () => Date.now()): BoardApi {
  const moves: Moves = new Map()
  const cwds = new Map<string, string>()
  const listeners = new Set<(msg: { projectId: string }) => void>()
  const last = new Map<string, number>()
  return {
    tick: (now) => {
      for (const [pid, cwd] of cwds) {
        const step = boardAt(cwd, now, moves).step
        if (last.has(pid) && last.get(pid) !== step) for (const cb of listeners) cb({ projectId: pid })
        last.set(pid, step)
      }
    },
    boardList: async ({ projectCwd }) => {
      cwds.set(`demo:${projectCwd}`, projectCwd)
      return boardAt(projectCwd, clock(), moves).board
    },
    boardItemEvents: async (id) => {
      for (const cwd of cwds.values()) {
        const ev = boardAt(cwd, clock(), moves).events.get(id)
        if (ev) return ev
      }
      return []
    },
    onBoardChanged: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    boardMove: async (id, toStatus) => {
      if (toStatus === 'in_progress') return { ok: false, message: 'Abra esta conversa e mande uma mensagem para o agente começar antes de mover pelo quadro.' }
      moves.set(id, { status: toStatus, at: iso(clock()) })
      return { ok: true }
    },
    // Dispensar na demo some com o cartão até o laço recomeçar.
    boardDismiss: async (id, dismissed) => {
      if (dismissed) moves.set(id, { status: 'dismissed', at: iso(clock()) })
      else moves.delete(id)
      return null
    }
  }
}
