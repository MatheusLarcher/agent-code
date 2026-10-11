import {
  currentEntrega,
  currentEnvio,
  envioPosition,
  isRoutineEnvio,
  parseMs,
  type HandoffEnvio
} from '../../shared/handoffTracking'
import type { RemoteEtapasProgress } from '../../shared/ipc'
import type { PlanProgress } from '../../shared/stepProgress'
import type { HandoffRepository } from '../persistence/types'
import { loadPlanProgress } from './entregaTools'

/**
 * O PLACAR DAS ETAPAS para o celular (a barra de plano da conversa de handoff):
 * prontas/total do PLANO pela regra única de shared/stepProgress.planProgress,
 * lidas do acompanhamento das entregas (o banco) e do roteiro — nunca da lista
 * de tarefas do agente (TodoWrite/TaskCreate recomeça a numeração a cada sessão
 * nova, e já mostrou "10/25" num plano de 10 etapas prontas).
 *
 *   etapasProgressView(progress, envio, envios)  a vista PURA do placar;
 *   loadConversationEtapas(convId, deps)         o placar da conversa, ou null;
 *   HandoffEtapasCache                           o cache síncrono do /api/state,
 *                                                invalidado a cada handoff:changed.
 */

/** O motivo da trinca cabe numa linha menor do celular: até este tamanho (159 + "…"). */
export const MOTIVO_MAX_CHARS = 160

/** Conversa sem placar: quanto tempo sem voltar ao banco (o celular lê o estado a cada ~4 s). */
export const SEM_PLACAR_TTL_MS = 60_000

export interface EtapasViewDeps {
  /** Só leitura (vale com o banco em modo só-leitura). `null` ou lançar = sem banco. */
  repository: () => Pick<HandoffRepository, 'listHandoffEnvios'> | null
  /** As etapas do plano do envio, numeradas pela posição no PLANO. Padrão: loadPlanProgress de entregaTools (reuso, não cópia). */
  planProgress?: (envio: HandoffEnvio) => Promise<PlanProgress>
}

function cutMotivo(motivo: string | null | undefined): string | null {
  const text = (motivo ?? '').trim()
  if (!text) return null
  return text.length > MOTIVO_MAX_CHARS ? `${text.slice(0, MOTIVO_MAX_CHARS - 1).trimEnd()}…` : text
}

/**
 * A vista pura: o placar do plano (`progress`, de loadPlanProgress), a posição
 * do `envio` no lote dele e a etapa atual DESTA conversa — a de currentEntrega
 * do envio, a mesma regra "de envio" de stepLabel que o topo do chat do PC usa
 * (não a do plano, que pode estar noutra conversa quando o plano foi reenviado).
 */
export function etapasProgressView(progress: PlanProgress, envio: HandoffEnvio, envios: readonly HandoffEnvio[]): RemoteEtapasProgress {
  const atualId = currentEntrega(envio)?.etapaId
  const atual = atualId === undefined ? null : (progress.steps.find((s) => s.id === atualId)?.n ?? null)
  return {
    planSlug: envio.planSlug,
    planTitulo: envio.planTitulo,
    prompt: envioPosition(envios, envio),
    envioStatus: envio.status,
    total: progress.total,
    prontas: progress.prontas,
    incompletas: progress.incompletas,
    atual,
    steps: [...progress.steps]
      .sort((a, b) => a.n - b.n)
      .map((s) => ({ id: s.id, titulo: s.titulo, n: s.n, state: s.state, motivo: s.state === 'trinca' ? cutMotivo(s.entrega?.motivo) : null }))
  }
}

/**
 * O envio desta conversa: o corrente (o mais recente que saiu) ou, sem nenhum
 * enviado ainda, o mais novo registrado. Sem a rotina do PO (commit/push): ela
 * não tem etapas e não fala pelo prompt — a mesma regra da fila (handoffQueue).
 */
export function conversationEnvio(envios: readonly HandoffEnvio[]): HandoffEnvio | null {
  const prompts = envios.filter((e) => !isRoutineEnvio(e))
  const current = currentEnvio(prompts)
  if (current) return current
  let newest: HandoffEnvio | null = null
  for (const e of prompts) if (!newest || (parseMs(e.criadoEm) ?? 0) > (parseMs(newest.criadoEm) ?? 0)) newest = e
  return newest
}

/** O placar da conversa; `null` sem envio, sem banco ou com erro — nunca lança. */
export async function loadConversationEtapas(convId: string, deps: EtapasViewDeps): Promise<RemoteEtapasProgress | null> {
  try {
    const repo = deps.repository()
    if (!repo) return null
    const envios = await repo.listHandoffEnvios({ conversationId: convId })
    const envio = conversationEnvio(envios)
    if (!envio) return null
    const progress = await (deps.planProgress ?? loadPlanProgress)(envio)
    return etapasProgressView(progress, envio, envios)
  } catch {
    return null
  }
}

export interface EtapasCacheOptions {
  /** Como carregar o placar de uma conversa. Padrão: loadConversationEtapas com as deps. */
  load?: (convId: string) => Promise<RemoteEtapasProgress | null>
  now?: () => number
  semPlacarTtlMs?: number
}

/**
 * O cache do `/api/state`: `get` é SÍNCRONO (o celular lê o estado a cada ~4 s e
 * a resposta não espera o banco). Sem entrada, dispara UMA carga por conversa
 * (gets concorrentes não duplicam) e devolve undefined até ela terminar. Uma
 * conversa sem placar (sem envio, sem banco, erro) fica marcada por
 * SEM_PLACAR_TTL_MS para não bater no banco a cada poll. `invalidate` apaga a
 * entrada — uma carga em voo é descartada — e a próxima get recarrega.
 */
export class HandoffEtapasCache {
  private readonly ready = new Map<string, RemoteEtapasProgress>()
  private readonly loading = new Set<string>()
  private readonly semPlacarAte = new Map<string, number>()
  /** Sobe a cada invalidate: a carga em voo só grava se ainda for da mesma geração. */
  private readonly generation = new Map<string, number>()
  private readonly load: (convId: string) => Promise<RemoteEtapasProgress | null>
  private readonly now: () => number
  private readonly ttl: number
  private disposed = false

  constructor(deps: EtapasViewDeps, options: EtapasCacheOptions = {}) {
    this.load = options.load ?? ((convId) => loadConversationEtapas(convId, deps))
    this.now = options.now ?? Date.now
    this.ttl = options.semPlacarTtlMs ?? SEM_PLACAR_TTL_MS
  }

  get(convId: string): RemoteEtapasProgress | undefined {
    const hit = this.ready.get(convId)
    if (hit) return hit
    if (this.disposed || this.loading.has(convId)) return undefined
    const until = this.semPlacarAte.get(convId)
    if (until !== undefined && until > this.now()) return undefined
    void this.refresh(convId)
    return undefined
  }

  /** Uma escrita do acompanhamento (handoff:changed): a próxima get recarrega. */
  invalidate(convId: string): void {
    this.ready.delete(convId)
    this.semPlacarAte.delete(convId)
    this.loading.delete(convId)
    this.generation.set(convId, (this.generation.get(convId) ?? 0) + 1)
  }

  dispose(): void {
    this.disposed = true
    this.ready.clear()
    this.semPlacarAte.clear()
    this.loading.clear()
  }

  private async refresh(convId: string): Promise<void> {
    const gen = this.generation.get(convId) ?? 0
    this.loading.add(convId)
    let result: RemoteEtapasProgress | null = null
    try {
      result = await this.load(convId)
    } catch {
      result = null
    }
    // Invalidada (ou descartada) enquanto carregava: o que veio já é velho.
    if (this.disposed || (this.generation.get(convId) ?? 0) !== gen) return
    this.loading.delete(convId)
    if (result) this.ready.set(convId, result)
    else this.semPlacarAte.set(convId, this.now() + this.ttl)
  }
}
