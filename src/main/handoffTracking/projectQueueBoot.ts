import { join } from 'node:path'
import type { HandoffProjectSnapshot } from '../../shared/handoffProject'
import { claudeObserverEnv } from '../observerQuery'
import type { HandoffRepository } from '../persistence/types'
import { collectPoGitEvidence } from '../po/poGit'
import { formatConversationHistory } from './conversationHistory'
import { createProjectEvaluator } from './projectQueueEvaluation'
import { createProjectGit } from './projectQueueGit'
import { ProjectQueueService } from './projectQueueService'
import { ProjectQueueStore } from './projectQueueStore'

/**
 * A montagem da fila do projeto para o index.ts: o estado num JSON da pasta de
 * dados (por PC), o git, o PO com ferramentas (modelo e conta do PO) e os
 * avisos para a tela. Só fios — a lógica mora no serviço.
 */

export interface ProjectQueueBootDeps {
  /** A pasta de dados do app (`app.getPath('userData')`). */
  userData: string
  repository(): HandoffRepository | null
  /** A conversa gravada (para exportar o histórico do A ao PO). */
  conversation(id: string): Promise<Record<string, unknown> | null>
  /** O modelo do PO agora (Configurações → Quadro). */
  poModel(): string
  notify(conversationId: string): void
  publish(snapshot: HandoffProjectSnapshot): void
}

export function createProjectQueue(deps: ProjectQueueBootDeps): ProjectQueueService {
  const git = createProjectGit()
  return new ProjectQueueService({
    repository: deps.repository,
    store: new ProjectQueueStore(join(deps.userData, 'handoff-project-queue.json')),
    git,
    evaluate: createProjectEvaluator({
      recordsDir: join(deps.userData, 'po-avaliacoes'),
      git,
      gitEvidence: (cwd, sinceMs) => collectPoGitEvidence(cwd, sinceMs),
      history: async (id) => formatConversationHistory(await deps.conversation(id)),
      // A mesma conta da conversa do A (o observador Claude usa a conta da conversa acompanhada).
      runtime: async (id) => {
        const model = deps.poModel()
        const env = await claudeObserverEnv(id, model)
        return { model, ...(env ? { env } : {}) }
      }
    }),
    notify: deps.notify,
    publish: deps.publish,
    log: (line) => console.warn(line)
  })
}
