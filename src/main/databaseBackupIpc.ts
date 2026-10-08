import type { IpcMain } from 'electron'
import { z } from 'zod'
import { Channels } from '../shared/ipc'
import { inspectCloud, switchCloud } from './persistence/backup/cloudSwitch'
import type { DatabaseBackups } from './persistence/backup/databaseBackups'
import { restoreBackup } from './persistence/backup/storageRestore'
import type { StorageSwitchDeps } from './persistence/backup/switchSupport'
import { validatePostgresDraft } from './persistence/postgresProvisioning'

/**
 * Backups do banco nas Configurações (a lista, apagar e restaurar o escolhido) e a
 * nuvem opcional (o que cada lado tem, e a troca com o lado que o usuário escolheu).
 * Trocar ou restaurar o banco em uso termina reiniciando o app, como as outras
 * transições de banco.
 */

const restoreSchema = z
  .object({
    file: z.string().trim().min(1).max(200),
    target: z.enum(['local', 'nuvem'])
  })
  .strict()

const actionSchema = z.enum(['ligar', 'desligar'])

const switchSchema = z
  .object({
    action: actionSchema,
    keep: z.enum(['local', 'nuvem']),
    draft: z.unknown().optional()
  })
  .strict()

export interface DatabaseBackupIpcDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  backups: Pick<DatabaseBackups, 'list' | 'remove'>
  switchDeps: StorageSwitchDeps
  relaunch(): void
}

export function registerDatabaseBackupIpc(deps: DatabaseBackupIpcDeps): void {
  deps.ipcMain.handle(Channels.storageBackupsList, () => deps.backups.list())
  deps.ipcMain.handle(Channels.storageBackupDelete, async (_event, file: unknown) => {
    if (typeof file !== 'string' || !file.trim()) throw new TypeError('Backup inválido.')
    await deps.backups.remove(file)
  })
  deps.ipcMain.handle(Channels.storageBackupRestore, async (_event, raw: unknown) => {
    const outcome = await restoreBackup(deps.switchDeps, restoreSchema.parse(raw))
    if (outcome.relaunch) deps.relaunch()
    return outcome
  })
  deps.ipcMain.handle(Channels.storageCloudInspect, (_event, action: unknown, draft: unknown) =>
    inspectCloud(deps.switchDeps, actionSchema.parse(action), draft == null ? undefined : validatePostgresDraft(draft))
  )
  deps.ipcMain.handle(Channels.storageCloudSwitch, async (_event, raw: unknown) => {
    const request = switchSchema.parse(raw)
    const outcome = await switchCloud(deps.switchDeps, {
      action: request.action,
      keep: request.keep,
      ...(request.draft == null ? {} : { draft: validatePostgresDraft(request.draft) })
    })
    deps.relaunch()
    return outcome
  })
}
