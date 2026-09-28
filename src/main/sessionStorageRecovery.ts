import type { StorageStatus } from './persistence/types'

/** O que este módulo precisa de uma sessão de agente (ProviderFailoverSession). */
export interface RecoverableSession {
  waitForIdle(): Promise<void>
  dispose(): void
  /** O banco voltou: o reparo do espelho pendente tenta já, sem esperar o backoff. */
  storageRestored?(): void
}

export interface SessionStorageRecoveryDeps<S extends RecoverableSession> {
  sessions: Map<string, S>
  /** Estado da persistência AGORA (não o do aviso que disparou a espera). */
  currentState: () => StorageStatus['state']
  /** Limpa o resto da conversa descartada (sessão automática, lease). */
  forget: (convId: string) => void
  /** Renova na hora o lease de toda conversa com sessão viva. */
  renewLeases: () => void
}

/**
 * Reação das sessões de agente às mudanças da persistência.
 *
 * Queda: cada sessão espera o turno terminar e só é descartada se o banco
 * CONTINUA fora — se a reconexão automática voltou antes, ela segue viva. Isso
 * só é seguro porque a sessão não guarda o repositório: store do espelho,
 * verificação do fim de turno, `llm_calls` e reparo resolvem o repositório ativo
 * a cada chamada (activeRepository.ts), e o lease é renovado pelo keeper no ativo.
 *
 * Volta (postgres-ready depois de uma queda): renova os leases já — o lease
 * pode ter vencido na queda e, até o heartbeat seguinte, as gravações com fence
 * seriam recusadas como "outro writer" — e dispara o reparo do espelho pendente,
 * que senão esperaria o degrau do backoff (até 1 hora).
 */
export function createSessionStorageRecovery<S extends RecoverableSession>(
  deps: SessionStorageRecoveryDeps<S>
): (status: StorageStatus) => void {
  let offlineSeen = false
  // Uma espera por sessão: `postgres-offline` é publicado de novo a cada
  // tentativa que desiste ou erro novo, e cada publicação empilhava outra. A
  // espera em curso já confere o estado de AGORA quando termina, então também
  // cobre uma segunda queda que chegue antes do fim do turno.
  const waiting = new Set<S>()
  return (status) => {
    if (status.state === 'postgres-offline') {
      offlineSeen = true
      for (const [convId, session] of deps.sessions) {
        if (waiting.has(session)) continue
        waiting.add(session)
        void session.waitForIdle().catch(() => undefined).finally(() => {
          waiting.delete(session)
          if (deps.currentState() !== 'postgres-offline') return
          // Outra queda (ou um novo start) pode ter trocado a sessão da conversa
          // no meio da espera; só a mesma sessão sai do mapa.
          if (deps.sessions.get(convId) !== session) return
          session.dispose()
          deps.sessions.delete(convId)
          deps.forget(convId)
        })
      }
      return
    }
    if (status.state === 'postgres-ready' && offlineSeen) {
      offlineSeen = false
      deps.renewLeases()
      for (const session of deps.sessions.values()) session.storageRestored?.()
    }
  }
}
