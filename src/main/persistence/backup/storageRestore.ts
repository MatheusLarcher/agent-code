import type { DatabaseRestoreRequestDto, DatabaseSide } from '../../../shared/databaseBackup'
import { StorageError } from '../types'
import { drainAndHold, ensureDatabase, republish, sideLabel, sideOf, type StorageSwitchDeps } from './switchSupport'

export interface RestoreOutcome {
  /** O destino era o banco em uso: o app reinicia para reabrir nele. */
  relaunch: boolean
  message: string
}

/**
 * Restaura o backup que o usuário escolheu no destino que ele escolheu (o banco
 * local, ou a nuvem se ligada). Antes, um backup do estado atual do destino —
 * restaurar também é reversível. O pg_restore roda em transação única: se falhar,
 * o destino continua como estava. Com o destino em uso, a fila drena antes, as
 * gravações ficam retidas durante a cópia e o app reinicia no fim.
 */
export async function restoreBackup(deps: StorageSwitchDeps, request: DatabaseRestoreRequestDto): Promise<RestoreOutcome> {
  deps.assertIdle()
  const { path, meta } = await deps.backups.read(request.file)
  await deps.backups.cancelDaily()
  return deps.lifecycle.exclusive(async (host) => {
    const data = await host.bootstrap().load()
    const activeSide: DatabaseSide | null = data.backend === 'postgres' ? sideOf(data.postgresTarget) : null
    if (request.target === 'nuvem' && activeSide !== 'nuvem') {
      throw new StorageError('TRANSITION_IN_PROGRESS', 'A nuvem não está ligada: o destino da restauração só pode ser o banco local.')
    }
    const previous = host.status()
    const inUse = request.target === activeSide
    let detached = false
    try {
      if (inUse) {
        await drainAndHold(deps, host, 'restoring-postgres', previous.hasPassword, true)
      } else {
        host.publish(previous.backend, 'restoring-postgres', previous.writable, previous.hasPassword)
      }
      host.step(`Preparando o ${sideLabel(request.target)}`)
      const draft = request.target === 'local' ? await host.localDraft() : await host.bootstrap().connection()
      await ensureDatabase(deps, draft)
      host.step(`Salvando um backup do estado atual do ${sideLabel(request.target)}`)
      const before = await deps.backups.create({ side: request.target, draft }, 'antes-da-restauracao')
      if (inUse) {
        await host.detach()
        detached = true
      }
      host.step(`Restaurando o backup de ${new Date(meta.createdAt).toLocaleString('pt-BR')}`)
      const checked = await deps.backups.restoreInto(path, draft, meta.tables)
      const message =
        `Backup ${meta.file} restaurado no ${sideLabel(request.target)} (${checked}). ` +
        `O estado anterior ficou em ${before.file}.`
      deps.log(`restauração: ${message}`)
      if (inUse) return { relaunch: true, message: `${message} O app vai reiniciar.` }
      republish(host, previous)
      return { relaunch: false, message }
    } catch (error) {
      deps.log(`restauração de ${meta.file} no ${sideLabel(request.target)} falhou: ${error instanceof Error ? error.message : String(error)}`)
      // Transação única: o destino ficou como estava. O banco em uso volta a abrir.
      if (detached) await host.reopen().catch(() => undefined)
      else republish(host, previous)
      throw error
    }
  })
}
