import type { DatabaseSide } from '../../../shared/databaseBackup'
import type { PostgresConnectionDraft } from '../../../shared/ipc'
import type { PostgresTarget } from '../bootstrapStore'
import type { StorageLifecycleService } from '../lifecycle'
import { provisionPostgres } from '../postgresProvisioning'
import type { TransitionHost } from '../storageTransitions'
import type { StorageStatus } from '../types'
import type { DatabaseBackups } from './databaseBackups'

/**
 * O que a restauração (storageRestore.ts) e a troca local ↔ nuvem (cloudSwitch.ts)
 * usam do resto do app. As duas seguem a mesma guarda: nenhuma conversa no meio
 * de um turno, a fila de gravação drenada antes e retida durante a cópia.
 */
export interface StorageSwitchDeps {
  lifecycle: Pick<StorageLifecycleService, 'exclusive'>
  backups: Pick<DatabaseBackups, 'create' | 'dumpForTransfer' | 'restoreInto' | 'read' | 'cancelDaily'>
  installationId(): string
  appVersion: string
  /** Recusa (lança) se alguma conversa estiver no meio de um turno — a guarda do app_restart. */
  assertIdle(): void
  /** A tela entrega o que tem e as filas gravam no lado em uso; false = não terminou no prazo. */
  drain(): Promise<boolean>
  /** Encerra as sessões (todas ociosas, pela guarda) e solta os leases. */
  stopSessions(): Promise<void>
  log(line: string): void
  /** Só nos testes: a criação do banco no destino. */
  provision?: (draft: PostgresConnectionDraft) => Promise<{ createdDatabase: boolean }>
}

export const sideOf = (target: PostgresTarget): DatabaseSide => (target === 'local' ? 'local' : 'nuvem')
export const targetOf = (side: DatabaseSide): PostgresTarget => (side === 'local' ? 'local' : 'cloud')
export const sideLabel = (side: DatabaseSide): string => (side === 'local' ? 'banco local' : 'nuvem')

/** O banco agent-code existe no destino, com as migrations desta versão: o pg_restore
 *  precisa de um banco para entrar. Devolve se ele acabou de ser criado (vazio). */
export async function ensureDatabase(deps: StorageSwitchDeps, draft: PostgresConnectionDraft): Promise<{ createdDatabase: boolean }> {
  if (deps.provision) return deps.provision(draft)
  const provisioned = await provisionPostgres(draft, deps.installationId(), deps.appVersion)
  await provisioned.pool.end().catch(() => undefined)
  return { createdDatabase: provisioned.createdDatabase }
}

/** O status de antes, de volta (a operação falhou sem trocar o banco em uso). */
export function republish(host: TransitionHost, previous: StorageStatus): void {
  host.publish(previous.backend, previous.state, previous.writable, previous.hasPassword)
}

/** Trava a operação: drena a fila no lado em uso e então retém as gravações. */
export async function drainAndHold(
  deps: StorageSwitchDeps,
  host: TransitionHost,
  state: 'switching-postgres' | 'restoring-postgres',
  hasPassword: boolean,
  required: boolean
): Promise<void> {
  host.publish('postgres', state, true, hasPassword)
  host.step('Gravando o que estava na fila')
  const drained = await deps.drain()
  if (!drained && required) {
    throw new Error('A fila de gravação não terminou de gravar no banco em uso; nada foi alterado.')
  }
  host.publish('postgres', state, false, hasPassword)
  // A guarda de novo, agora com o envio recusado: um turno que começou no meio
  // da drenagem não pode ser interrompido pela troca.
  deps.assertIdle()
  host.step('Encerrando as sessões ociosas')
  await deps.stopSessions()
}
