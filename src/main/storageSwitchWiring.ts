import type { CloudSwitchRequestDto } from '../shared/databaseBackup'
import { Channels, type PostgresConnectionDraft } from '../shared/ipc'
import type { RestartGuardStatus } from './appRestart'
import { cloudToolDeps, configureCloudTool, runCloudTool, type CloudToolReply } from './cloudTool'
import { inspectCloud, switchCloud } from './persistence/backup/cloudSwitch'
import type { DatabaseBackups } from './persistence/backup/databaseBackups'
import type { StorageSwitchDeps } from './persistence/backup/switchSupport'
import type { StorageLifecycleService } from './persistence/lifecycle'
import { StorageError } from './persistence/types'

/**
 * A fiação da restauração e da troca local ↔ nuvem com o resto do main: a guarda
 * (a mesma do app_restart), a drenagem da tela e das filas antes da cópia, e a
 * ferramenta app_postgres_nuvem, cuja troca roda depois do turno de quem pediu.
 */

/** Prazo para as conversas ficarem livres depois que o agente pediu a troca de banco. */
const CLOUD_SWITCH_IDLE_WAIT_MS = 120_000

export interface StorageSwitchWiringDeps {
  lifecycle: Pick<StorageLifecycleService, 'exclusive' | 'status' | 'postgresSettings' | 'testPostgres'>
  backups: DatabaseBackups
  appVersion: string
  /** O coordenador do app_restart (a guarda das conversas ocupadas). */
  guard(): RestartGuardStatus | null
  /** A tela entrega o que tem para a fila do main. */
  flushRenderer(): Promise<void>
  /** As filas do main gravam no banco em uso, com prazo. */
  flushQueues(): Promise<{ conversations: boolean; outbox: boolean }>
  /** Só sobrou recusa definitiva na fila de conversas. */
  onlyRefusedLeft(): boolean
  /** Encerra as sessões (ociosas, pela guarda) e solta os leases. */
  stopSessions(): Promise<void>
  readSecret(name: string): Promise<string | null>
  send(channel: string, payload: unknown): void
  relaunch(): void
  log(line: string): void
}

export interface StorageSwitchWiring {
  switchDeps: StorageSwitchDeps
  /** A ferramenta sem conversa chamando (ganchos da instância isolada de teste). */
  cloudToolWithoutCaller(input: unknown): Promise<CloudToolReply>
}

export function createStorageSwitchWiring(deps: StorageSwitchWiringDeps): StorageSwitchWiring {
  const assertIdle = (): void => {
    const guard = deps.guard()
    if (guard && !guard.idle) {
      throw new StorageError(
        'TRANSITION_IN_PROGRESS',
        `Há agente trabalhando agora (${guard.blockedBy ?? 'turno em andamento'}). A troca de banco só acontece com todas as conversas paradas: tente quando o turno terminar.`
      )
    }
  }

  const drain = async (): Promise<boolean> => {
    const rendererFlushed = await deps.flushRenderer().then(
      () => true,
      () => false
    )
    const queues = await deps.flushQueues()
    // Conversa recusada pelo banco ("não salvo") não é espera: não segura a troca.
    return rendererFlushed && (queues.conversations || deps.onlyRefusedLeft()) && queues.outbox
  }

  const switchDeps: StorageSwitchDeps = {
    lifecycle: deps.lifecycle,
    backups: deps.backups,
    installationId: () => deps.lifecycle.status().installationId,
    appVersion: deps.appVersion,
    assertIdle,
    drain,
    stopSessions: () => deps.stopSessions(),
    log: (line) => deps.log(line)
  }

  /** A troca pedida pela ferramenta: espera o turno de quem pediu (e qualquer
   *  outro) terminar, roda pelo mesmo caminho da tela e reinicia o app. */
  const schedule = (request: CloudSwitchRequestDto): void => {
    void (async () => {
      const deadline = Date.now() + CLOUD_SWITCH_IDLE_WAIT_MS
      for (let guard = deps.guard(); guard && !guard.idle; guard = deps.guard()) {
        if (Date.now() > deadline) throw new Error('as conversas não ficaram livres em 2 minutos (algum turno continuou rodando)')
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      const outcome = await switchCloud(switchDeps, request)
      deps.send(Channels.storageTransitionResult, { ok: true, message: outcome.message })
      deps.relaunch()
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      deps.log(`troca de banco pedida pelo agente não aconteceu: ${message}`)
      deps.send(Channels.storageTransitionResult, { ok: false, message: `A troca de banco pedida pelo agente não aconteceu: ${message}` })
    })
  }

  const saved = async (): Promise<{ target: 'local' | 'cloud'; saved: Omit<PostgresConnectionDraft, 'password'> }> => {
    const settings = await deps.lifecycle.postgresSettings()
    return {
      target: deps.lifecycle.status().backend === 'postgres' ? settings.postgresTarget : 'local',
      saved: {
        host: settings.host,
        port: settings.port,
        user: settings.user,
        maintenanceDatabase: settings.maintenanceDatabase,
        tlsMode: settings.tlsMode,
        ca: settings.ca
      }
    }
  }

  configureCloudTool({
    current: saved,
    // Resolvido aqui no main e usado só na conexão: o valor nunca volta ao modelo.
    readSecret: (name) => deps.readSecret(name),
    inspect: (action, draft) => inspectCloud(switchDeps, action, draft),
    testConnection: async (draft) => deps.lifecycle.testPostgres(draft ?? { ...(await saved()).saved, password: '' }),
    schedule
  })

  return {
    switchDeps,
    cloudToolWithoutCaller: async (input) => {
      const toolDeps = cloudToolDeps(() => {
        const guard = deps.guard()
        return { ok: !guard || guard.idle, message: guard?.blockedBy ?? '' }
      })
      return toolDeps ? runCloudTool(input, toolDeps) : { ok: false, text: 'sem ferramenta' }
    }
  }
}
