/**
 * Planejar pelo Escritório ("📋 Planejar" / clique na TV vazia): o mesmo
 * caminho do "Novo planejamento" — o plano nasce no main ("Sem nome", pasta
 * plano-AAAAMMDD-HHMM) e a conversa de planejamento é criada pelo App —, mas
 * sem sair do Escritório, e o pedido inicial vai como a 1ª mensagem (é dela
 * que sai o nome do plano). Nada aqui lança: falha vira aviso e null.
 */
import type { PlanningFailure, PlanningRef, PlanningResult } from '@shared/ipc'
import type { Conversation } from '../types'
import { isCentralConversation } from '@shared/central'
import { isSandboxCwd } from '../sandbox/sandboxFlow'
import { PLANNING_UNTITLED } from './planningConversation'
import { generatePlanningSlug } from './planningSlug'

export interface PlanStartApi {
  planningList(req: { projectCwd: string }): Promise<PlanningResult<{ slugs: string[] }>>
  planningCreate(req: PlanningRef & { titulo: string }): Promise<PlanningResult<object>>
}

export interface PlanStartDeps {
  api: PlanStartApi
  /** Cria a conversa de planejamento do slug (o App: createConversation com os campos do plano). */
  create: (slug: string, titulo: string) => Conversation
  /** Manda a 1ª mensagem (o envio normal do chat). */
  send: (conv: Conversation, text: string) => void
  notify: (kind: 'erro', text: string) => void
}

const why = (f: PlanningFailure): string => (f.code === 'rev_conflict' ? 'conflito de versão' : f.message)

/** Cria o plano e a conversa; devolve o id da conversa (null se falhou). */
export async function startOfficePlan(cwd: string, pedido: string, deps: PlanStartDeps): Promise<string | null> {
  try {
    const list = await deps.api.planningList({ projectCwd: cwd })
    const slug = generatePlanningSlug(new Date(), list.ok ? list.slugs : [])
    const res = await deps.api.planningCreate({ projectCwd: cwd, slug, titulo: PLANNING_UNTITLED })
    if (!res.ok) {
      deps.notify('erro', `Não consegui criar o planejamento: ${why(res)}`)
      return null
    }
    const conv = deps.create(slug, PLANNING_UNTITLED)
    if (pedido.trim()) deps.send(conv, pedido.trim())
    return conv.id
  } catch (err) {
    deps.notify('erro', `Não consegui criar o planejamento: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * Os projetos para o formulário: as pastas das conversas, pelo nome — sem a
 * Central e sem as pastas do sandbox (a barra lateral também não oferece
 * "Novo planejamento" no Sandbox).
 */
export function planProjectsOf(conversations: readonly Conversation[], sandboxRoot = ''): Array<{ cwd: string; name: string }> {
  const seen = new Map<string, string>()
  for (const c of conversations) {
    if (!c.cwd || isCentralConversation(c) || isSandboxCwd(sandboxRoot, c.cwd) || seen.has(c.cwd)) continue
    seen.set(c.cwd, c.cwd.split(/[\\/]+/).filter(Boolean).pop() ?? c.cwd)
  }
  return [...seen].map(([cwd, name]) => ({ cwd, name })).sort((a, b) => a.name.localeCompare(b.name))
}
