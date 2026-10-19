/**
 * As ações de handoff que chegam do celular (RemoteConversationAction `handoff`
 * e `handoff-generate`, emitidas pela ponte em main/remote/planningBridge.ts),
 * executadas pelo MESMO caminho da Tela de Planejamento: o `startHandoff` do App
 * (conversa de implementação com o modelo/esforço do Manager, fila do quadro,
 * registro no banco), o registro em _handoff/enviados.json só do que foi
 * entregue (deliveredMarks) e o pedido ao Agent Manager (managerHandoffRequest
 * com os interruptores do handoff lidos agora). O App.tsx só liga as dependências.
 */
import type { AgentCodeApi } from '@shared/api'
import type { RemoteConversationAction } from '@shared/ipc'
import type { Conversation } from '../types'
import {
  deliveredMarks,
  errText,
  failureText,
  handoffPartialMessage,
  handoffSentMessage,
  managerHandoffRequest,
  readHandoffConfig,
  safe,
  type HandoffSendOutcome
} from './handoffFlow'
import { isPlanningConversation } from './planningConversation'
import { handoffFastModeChoice } from './useHandoffFastMode'

export type RemoteHandoffAction = Extract<RemoteConversationAction, { type: 'handoff' }>
export type RemoteHandoffGenerateAction = Extract<RemoteConversationAction, { type: 'handoff-generate' }>

type NotifyKind = 'sucesso' | 'erro' | 'aviso'

export interface RemoteHandoffDeps {
  api: Pick<AgentCodeApi, 'getConfig' | 'planningMarkHandoffsSent'>
  /** O startHandoff do App (o mesmo do "Enviar" do PC). */
  startHandoff: (
    folder: string,
    slug: string,
    titulo: string,
    prompts: string[],
    names: string[],
    fastMode?: boolean
  ) => Promise<HandoffSendOutcome>
  /** O Fast mode das conversas do projeto (inheritedFastMode): o padrão da opção do PC. */
  projectFastMode: (cwd: string) => boolean
  /** O id da conversa do Agent Manager do plano, ou null. */
  managerOf: (cwd: string, slug: string) => string | null
  /** Manda um texto ao Manager pelo envio normal (fila, se ocupado). */
  ask: (convId: string, text: string) => void
  notify: (kind: NotifyKind, text: string) => void
}

type ManagerShape = Pick<Conversation, 'id' | 'cwd' | 'mode' | 'planningSlug'> & { updatedAt?: number }

/** A conversa do Agent Manager do plano (a mais recente, se houver mais de uma) — a mesma regra do celular. */
export function findManagerConversation<C extends ManagerShape>(convs: readonly C[], cwd: string, slug: string): C | null {
  let best: C | null = null
  for (const c of convs) {
    if (!isPlanningConversation(c) || c.planningSlug !== slug || c.cwd !== cwd) continue
    if (!best || (c.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = c
  }
  return best
}

/** Por quanto tempo o mesmo prompt não sai de novo pelo celular (o enviados.json pode não ter sido gravado ainda). */
export const REMOTE_RESEND_GUARD_MS = 120_000

/**
 * Trava contra o duplo toque: o celular relê o plano só depois do envio, e um
 * segundo "Enviar" antes disso criaria OUTRA conversa de implementação.
 */
export class RecentHandoffs {
  private readonly at = new Map<string, number>()
  constructor(private readonly now: () => number = Date.now) {}

  private key(cwd: string, slug: string, name: string): string {
    return `${cwd}\n${slug}\n${name}`
  }

  /** Reserva os prompts; false se algum saiu há pouco. */
  claim(cwd: string, slug: string, names: readonly string[]): boolean {
    const t = this.now()
    for (const [k, when] of this.at) if (t - when > REMOTE_RESEND_GUARD_MS) this.at.delete(k)
    if (names.some((n) => this.at.has(this.key(cwd, slug, n)))) return false
    for (const n of names) this.at.set(this.key(cwd, slug, n), t)
    return true
  }

  release(cwd: string, slug: string, names: readonly string[]): void {
    for (const n of names) this.at.delete(this.key(cwd, slug, n))
  }
}

const recentSends = new RecentHandoffs()

/** "Enviar" do celular: o envio do PC, com o Fast mode no padrão do diálogo, e o registro do entregue. */
export async function runRemoteHandoff(action: RemoteHandoffAction, deps: RemoteHandoffDeps, guard: RecentHandoffs = recentSends): Promise<void> {
  const { cwd, slug, titulo } = action
  const items = action.prompts.filter((p) => p.text.trim() !== '')
  const names = items.map((p) => p.name)
  const prompts = items.map((p) => p.text)
  if (items.length === 0) {
    deps.notify('erro', 'Nada foi enviado para a implementação: nenhum prompt com texto.')
    return
  }
  if (!guard.claim(cwd, slug, names)) {
    deps.notify('aviso', `O celular pediu de novo o envio de "${titulo}", que acabou de sair: ignorei para não criar outra conversa.`)
    return
  }
  const config = await Promise.resolve()
    .then(() => deps.api.getConfig())
    .catch(() => null)
  const fast = handoffFastModeChoice(config, deps.projectFastMode(cwd))
  let outcome: HandoffSendOutcome
  try {
    outcome = await (fast ? deps.startHandoff(cwd, slug, titulo, prompts, names, fast.on) : deps.startHandoff(cwd, slug, titulo, prompts, names))
  } catch (err) {
    guard.release(cwd, slug, names)
    deps.notify('erro', `Não consegui enviar para a implementação: ${errText(err)}`)
    return
  }
  if (outcome.status === 'not-created') {
    guard.release(cwd, slug, names)
    deps.notify('erro', 'Nada foi enviado para a implementação: nenhum prompt com texto.')
    return
  }
  // Só o que a conversa recebeu: no envio parcial, o resto continua a enviar.
  const marks = deliveredMarks(names, outcome)
  if (marks.length > 0) {
    const res = await safe(() => deps.api.planningMarkHandoffsSent({ projectCwd: cwd, slug, entries: marks }))
    if (!res.ok) {
      deps.notify(
        'erro',
        `Enviado, mas não consegui registrar o envio em _handoff/enviados.json: ${failureText(res)}. ` +
          'Marque esses prompts como já enviados para não mandá-los de novo.'
      )
    }
  }
  if (outcome.status === 'sent') deps.notify('sucesso', handoffSentMessage(titulo, outcome, prompts.length))
  else deps.notify('erro', handoffPartialMessage(titulo, outcome))
}

/** "Gerar prompts" do celular: o mesmo pedido do botão do PC, à conversa do Manager do plano. */
export async function runRemoteHandoffGenerate(action: RemoteHandoffGenerateAction, deps: RemoteHandoffDeps): Promise<void> {
  const convId = deps.managerOf(action.cwd, action.slug)
  if (!convId) {
    deps.notify('erro', 'O celular pediu os prompts de um plano cuja conversa do Agent Manager não está aberta no PC.')
    return
  }
  // Os interruptores do handoff valem na hora do pedido (desligados = o pedido de antes).
  const guidance = await readHandoffConfig(deps.api)
  deps.ask(convId, managerHandoffRequest(action.planDir, action.openAmbiguities, action.mediaCount, guidance))
}

/** Despacha as duas ações; devolve false para as que não são de handoff. */
export function runRemotePlanningAction(action: RemoteConversationAction, deps: RemoteHandoffDeps): boolean {
  if (action.type === 'handoff') void runRemoteHandoff(action, deps)
  else if (action.type === 'handoff-generate') void runRemoteHandoffGenerate(action, deps)
  else return false
  return true
}
