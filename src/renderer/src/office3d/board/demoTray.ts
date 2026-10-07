/**
 * A fila falsa da demonstração (Ctrl+Alt+Shift+D) para a bandeja do quadro —
 * determinística pelo relógio, no mesmo laço de DEMO_LOOP_MS do resto da demo:
 * o agent-code tem 5 prompts (4 folhas e "+1"); aos DEMO_TRAY_RELEASE_MS o
 * despachante solta o de cima para a "Demo 1.2" (o PO leva a folha até a mesa
 * dela) e aos DEMO_TRAY_STOP_MS o próximo fica parado (clipe vermelho). Os dois
 * instantes caem com a luz acesa (o apagão é USAGE_OUT_AT..USAGE_BACK_AT) e
 * longe das idas do PO ao quadro do agent-code (demoBoard.ts). O erp-itp tem
 * 2, o de cima segurado pelo PO; o loja-virtual, 1.
 */
import type { HandoffEnvio, HandoffQueueItem, HandoffQueueState } from '@shared/handoffTracking'
import { DEMO_LOOP_MS } from '../demoTimeline'
import type { TrayApi } from './queueTray'

export const DEMO_TRAY_RELEASE_MS = 100_000
export const DEMO_TRAY_STOP_MS = 108_000
/** O envio que a demonstração solta (o de cima do agent-code). */
export const DEMO_TRAY_RELEASED = 'demo-envio-0-2'

function item(r: number, project: string, n: number, conv: number, estado: HandoffQueueState = 'esperando', motivo: string | null = null): HandoffQueueItem {
  return {
    envioId: `demo-envio-${r}-${n}`,
    conversationId: `demo-${r}-${conv}`,
    conversationTitle: `Demo ${r + 1}.${conv + 1}`,
    projectCwd: `C:\\demo\\${project}`,
    planSlug: `plano-demo-${r}`,
    planTitulo: 'Plano da demonstração',
    loteId: `lote-demo-${r}`,
    ordem: n,
    arquivo: `prompt-${n}.md`,
    estado,
    motivo,
    estimativaTotal: 30,
    planPosicao: 1,
    etapas: [],
    totalPrompts: 6,
    conteudo: `Prompt ${n} da demonstração`
  }
}

/** A fila no instante `t` do laço. */
export function demoTrayItems(t: number): HandoffQueueItem[] {
  const released = t >= DEMO_TRAY_RELEASE_MS
  const stopped = t >= DEMO_TRAY_STOP_MS
  const code = [2, 3, 4, 5, 6]
    .filter((n) => !(released && n === 2))
    .map((n) => (stopped && n === 3 ? item(0, 'agent-code', n, 1, 'parada', 'o prompt anterior terminou com pendência: falta o commit') : item(0, 'agent-code', n, 1)))
  return [...code, item(2, 'erp-itp', 2, 0, 'segurada', 'a resposta do agente contradiz o próximo prompt'), item(2, 'erp-itp', 3, 0), item(1, 'loja-virtual', 4, 0)]
}

/** O envio já saído, como o acompanhamento da conversa o mostra. */
function sentEnvio(q: HandoffQueueItem, at: number): HandoffEnvio {
  const iso = new Date(at).toISOString()
  return {
    id: q.envioId,
    planSlug: q.planSlug,
    planTitulo: q.planTitulo,
    projectId: q.projectCwd,
    projectCwd: q.projectCwd,
    conversationId: q.conversationId,
    conversationTitle: q.conversationTitle,
    arquivo: q.arquivo,
    ordem: q.ordem,
    loteId: q.loteId,
    conteudo: q.conteudo,
    conteudoHash: q.envioId,
    status: 'enviado',
    motivo: null,
    estimativaTotal: q.estimativaTotal,
    prazoTotal: null,
    atrasado: false,
    tempoAtivoMs: 0,
    retrabalhoMs: 0,
    criadoEm: iso,
    enviadoEm: iso,
    iniciadoEm: null,
    concluidoEm: null,
    updatedAt: iso,
    entregas: []
  }
}

export function demoTrayApi(clock: () => number = () => Date.now()): TrayApi {
  const phase = (): number => ((clock() % DEMO_LOOP_MS) + DEMO_LOOP_MS) % DEMO_LOOP_MS
  const step = (t: number): number => (t >= DEMO_TRAY_STOP_MS ? 2 : t >= DEMO_TRAY_RELEASE_MS ? 1 : 0)
  const listeners = new Set<() => void>()
  let last = step(phase())
  const on = (cb: () => void): (() => void) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  }
  return {
    // O "aviso" do main: no tique do motor, mudou de fase no laço → quem assina relê.
    tick: (now) => {
      const s = step(((now % DEMO_LOOP_MS) + DEMO_LOOP_MS) % DEMO_LOOP_MS)
      if (s === last) return
      last = s
      for (const cb of listeners) cb()
    },
    handoffQueueList: async () => ({ ok: true, items: demoTrayItems(phase()) }),
    handoffList: async (req) => {
      const done = step(phase()) >= 1 ? [item(0, 'agent-code', 2, 1)] : []
      return { ok: true, envios: done.filter((q) => !req?.conversationId || q.conversationId === req.conversationId).map((q) => sentEnvio(q, clock())) }
    },
    onHandoffChanged: (cb) => on(() => cb({ conversationId: 'demo-0-1' })),
    onHandoffProjectChanged: (cb) => on(() => cb({ caseInsensitive: true, folders: [] }))
  }
}
