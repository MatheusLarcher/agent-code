import {
  HANDOFF_PO_HOLD_PREFIX,
  HANDOFF_REMOVED_MOTIVO,
  isEnvioHeldByPo,
  isEnvioRemoved,
  isEnvioSent,
  type HandoffEnvio
} from '../../shared/handoffTracking'
import type { HandoffRepository } from '../persistence/types'
import type { PoNextPrompt } from '../po/poHold'
import { handoffContentHash } from './handoffModel'
import { decideQueue } from './handoffQueue'

/**
 * As AÇÕES da faixa "Próximos prompts" sobre os envios que ainda não saíram:
 * tirar da fila, editar o texto e reordenar os prompts de um plano. Envio que
 * já saiu é do acompanhamento e não muda por aqui; o tirado da fila fica no
 * banco com o motivo (o arquivo em `_handoff/` não é tocado).
 */

export interface QueueEditDeps {
  repository(): HandoffRepository | null
  /** Avisa a tela e a fila do projeto (handoff:changed): o despachante confere de novo. */
  changed(conversationId: string): void
}

export type QueueEditResult = { ok: true } | { ok: false; message: string }

const offline: QueueEditResult = { ok: false, message: 'O banco está indisponível agora.' }

/** Espera a vez: nem saiu nem foi tirado da fila. */
function waiting(envio: HandoffEnvio): boolean {
  return !isEnvioSent(envio) && !isEnvioRemoved(envio)
}

async function loadWaiting(repo: HandoffRepository, envioId: string): Promise<HandoffEnvio | QueueEditResult> {
  const [envio] = await repo.listHandoffEnvios({ ids: [envioId] })
  if (!envio) return { ok: false, message: 'Este prompt não existe mais.' }
  if (!waiting(envio)) return { ok: false, message: 'Este prompt já saiu da fila.' }
  return envio
}

/** "Tirar da fila": o envio sai com o motivo, e o próximo do plano passa à frente. */
export async function removeQueued(deps: QueueEditDeps, envioId: string): Promise<QueueEditResult> {
  const repo = deps.repository()
  if (!repo) return offline
  const envio = await loadWaiting(repo, envioId)
  if ('ok' in envio) return envio
  await repo.updateHandoffEnvio(envio.id, { status: 'parada', motivo: HANDOFF_REMOVED_MOTIVO })
  deps.changed(envio.conversationId)
  return { ok: true }
}

/**
 * "Ver/editar": grava o texto que vai sair (e o hash dele, para o casamento do
 * agent:send). O prompt que o PO segurou volta a esperar a vez: o usuário o
 * acertou.
 */
export async function editQueued(deps: QueueEditDeps, envioId: string, conteudo: string): Promise<QueueEditResult> {
  if (!conteudo.trim()) return { ok: false, message: 'O prompt não pode ficar vazio.' }
  const repo = deps.repository()
  if (!repo) return offline
  const envio = await loadWaiting(repo, envioId)
  if ('ok' in envio) return envio
  await repo.updateHandoffEnvio(envio.id, {
    conteudo,
    conteudoHash: handoffContentHash(conteudo),
    ...(isEnvioHeldByPo(envio) ? { motivo: null } : {})
  })
  deps.changed(envio.conversationId)
  return { ok: true }
}

/**
 * SEGURAR do PO: o próximo prompt espera, com o motivo. Só o envio que o digest
 * mostrou e que ainda espera — o veredito atrasado não segura o que já saiu.
 */
export async function holdQueued(deps: QueueEditDeps, envioId: string, motivo: string): Promise<boolean> {
  const repo = deps.repository()
  if (!repo || !motivo.trim()) return false
  const envio = await loadWaiting(repo, envioId)
  if ('ok' in envio) return false
  await repo.updateHandoffEnvio(envio.id, { motivo: `${HANDOFF_PO_HOLD_PREFIX}${motivo.trim()}` })
  deps.changed(envio.conversationId)
  return true
}

/** O próximo prompt do plano em curso da conversa, resumido para o PO (título e etapas). */
export async function nextQueuedPrompt(repo: HandoffRepository | null, conversationId: string): Promise<PoNextPrompt | null> {
  if (!repo) return null
  const envios = await repo.listHandoffEnvios({ conversationId })
  const decision = decideQueue(envios, { force: true })
  if (decision.kind !== 'next') return null
  const envio = envios.find((e) => e.id === decision.envio.id)
  if (!envio) return null
  const total = envios.filter((e) => e.loteId === envio.loteId && !isEnvioRemoved(e)).length
  const etapas = [...envio.entregas].sort((a, b) => a.ordem - b.ordem).map((e) => `[${e.etapaId}] ${e.etapaTitulo}`)
  return {
    envioId: envio.id,
    summary: `Prompt ${envio.ordem} de ${Math.max(total, envio.ordem)} do plano "${envio.planTitulo}" (${envio.arquivo})${etapas.length > 0 ? ` — etapas: ${etapas.join(', ')}` : ''}`
  }
}

/**
 * Reordena os prompts que esperam num plano: as MESMAS posições (`ordem`) dos
 * que esperam, redistribuídas na ordem nova. Um prompt de outro plano (ou que
 * já saiu) recusa tudo — nunca um prompt de um plano entre os de outro.
 */
export async function reorderQueued(deps: QueueEditDeps, conversationId: string, envioIds: readonly string[]): Promise<QueueEditResult> {
  const repo = deps.repository()
  if (!repo) return offline
  const envios = await repo.listHandoffEnvios({ conversationId })
  const chosen = envioIds.map((id) => envios.find((e) => e.id === id))
  if (chosen.some((e) => !e || !waiting(e))) return { ok: false, message: 'A lista mudou: algum prompt já saiu da fila.' }
  const list = chosen as HandoffEnvio[]
  if (new Set(list.map((e) => e.loteId)).size !== 1 || new Set(envioIds).size !== envioIds.length) {
    return { ok: false, message: 'Só dá para reordenar os prompts de um mesmo plano.' }
  }
  const positions = list.map((e) => e.ordem).sort((a, b) => a - b)
  let wrote = false
  for (const [index, envio] of list.entries()) {
    if (envio.ordem === positions[index]) continue
    await repo.updateHandoffEnvio(envio.id, { ordem: positions[index] })
    wrote = true
  }
  if (wrote) deps.changed(conversationId)
  return { ok: true }
}
