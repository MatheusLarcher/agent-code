import { rm } from 'node:fs/promises'
import { Client } from 'pg'
import type {
  CloudInspectionDto,
  CloudSwitchAction,
  CloudSwitchOptionDto,
  CloudSwitchRequestDto,
  DatabaseSide,
  DatabaseSideSummaryDto
} from '../../../shared/databaseBackup'
import type { PostgresConnectionDraft } from '../../../shared/ipc'
import { POSTGRES_DATABASE } from '../bootstrapStore'
import { postgresClientConfig, testPostgresConnection, typedPostgresError } from '../postgresProvisioning'
import type { TransitionHost } from '../storageTransitions'
import { StorageError } from '../types'
import { drainAndHold, ensureDatabase, republish, sideLabel, sideOf, targetOf, type StorageSwitchDeps } from './switchSupport'

/**
 * Ligar ou desligar o PostgreSQL da nuvem (a tela e a ferramenta do agente chamam
 * isto). O usuário escolhe qual lado manter; só há cópia quando o lado mantido é
 * o que o app deixa de usar — o lado deixado nunca é apagado. Antes de sobrescrever,
 * backup; a cópia é pg_dump → pg_restore (transação única) com conferência das
 * contagens; depois, a troca do backend no bootstrap, e o app reinicia.
 */

/** O PostgreSQL embutido: um servidor da nuvem mais antigo pode não aceitar o que o pg_restore dele emite. */
const EMBEDDED_MAJOR = 18
/** "Outro PC visto recentemente" na tabela installations da nuvem. */
const RECENT_DAYS = 14

interface SideReading {
  summary: DatabaseSideSummaryDto
  others: Array<{ appVersion: string; lastSeenAt: string }>
}

/** O que um lado tem — só leitura: não cria banco nem aplica migration. */
export async function readSide(side: DatabaseSide, draft: PostgresConnectionDraft, installationId: string): Promise<SideReading> {
  const base: DatabaseSideSummaryDto = { side, reachable: false, exists: false, conversations: 0, lastUpdate: null, serverVersion: null }
  const maintenance = new Client(postgresClientConfig(draft, draft.maintenanceDatabase))
  try {
    await maintenance.connect()
  } catch (error) {
    return { summary: { ...base, error: typedPostgresError(error, 'connect').message }, others: [] }
  }
  maintenance.on('error', () => undefined)
  let serverVersion: string | null = null
  let exists = false
  try {
    serverVersion = (await maintenance.query<{ v: string }>("SELECT current_setting('server_version') AS v")).rows[0]?.v ?? null
    exists = Boolean(
      (await maintenance.query<{ found: boolean }>('SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS found', [POSTGRES_DATABASE]))
        .rows[0]?.found
    )
  } catch (error) {
    return { summary: { ...base, error: typedPostgresError(error, 'maintenance').message }, others: [] }
  } finally {
    await maintenance.end().catch(() => undefined)
  }
  const summary: DatabaseSideSummaryDto = { ...base, reachable: true, exists, serverVersion }
  if (!exists) return { summary, others: [] }
  const client = new Client(postgresClientConfig(draft, POSTGRES_DATABASE))
  try {
    await client.connect()
    client.on('error', () => undefined)
    const tables = (
      await client.query<{ c: boolean; i: boolean }>(
        "SELECT to_regclass('public.conversations') IS NOT NULL AS c, to_regclass('public.installations') IS NOT NULL AS i"
      )
    ).rows[0]
    if (tables?.c) {
      const row = (
        await client.query<{ live: string; last: Date | null }>(
          'SELECT count(*) FILTER (WHERE deleted_at IS NULL)::bigint AS live, max(updated_at) AS last FROM conversations'
        )
      ).rows[0]
      summary.conversations = Number(row?.live ?? 0)
      summary.lastUpdate = row?.last ? new Date(row.last).toISOString() : null
    }
    const others = tables?.i
      ? (
          await client.query<{ app_version: string; last_seen_at: Date }>(
            `SELECT app_version, last_seen_at FROM installations
              WHERE installation_id::text <> $1 AND last_seen_at > now() - make_interval(days => $2)
              ORDER BY last_seen_at DESC LIMIT 10`,
            [installationId, RECENT_DAYS]
          )
        ).rows.map((row) => ({ appVersion: row.app_version, lastSeenAt: new Date(row.last_seen_at).toISOString() }))
      : []
    return { summary, others }
  } catch (error) {
    return { summary: { ...summary, error: typedPostgresError(error, 'dml').message }, others: [] }
  } finally {
    await client.end().catch(() => undefined)
  }
}

const major = (version: string | null): number | null => {
  const parsed = version ? Number.parseInt(version, 10) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}

/** As duas escolhas do diálogo, com o que acontece com cada lado. */
export function switchOptions(action: CloudSwitchAction, cloud: DatabaseSideSummaryDto): CloudSwitchOptionDto[] {
  if (action === 'ligar') {
    return [
      {
        keep: 'local',
        copies: true,
        overwrites: 'nuvem',
        description: cloud.exists && cloud.conversations > 0
          ? 'As conversas deste PC sobem para a nuvem. O que a nuvem tem hoje é substituído — antes, vira backup.'
          : 'As conversas deste PC sobem para a nuvem.'
      },
      { keep: 'nuvem', copies: false, overwrites: null, description: 'O app passa a usar a nuvem como ela está. O banco local fica guardado neste PC, sem mudança.' }
    ]
  }
  return [
    {
      keep: 'nuvem',
      copies: true,
      overwrites: 'local',
      description: 'O que está na nuvem é copiado para este PC. O banco local de hoje é substituído — antes, vira backup. A nuvem não muda.'
    },
    { keep: 'local', copies: false, overwrites: null, description: 'O app volta ao banco local como ele está. A nuvem não é alterada.' }
  ]
}

function suggestion(local: DatabaseSideSummaryDto, cloud: DatabaseSideSummaryDto): DatabaseSide | null {
  const localCount = local.reachable ? local.conversations : 0
  const cloudCount = cloud.reachable && cloud.exists ? cloud.conversations : 0
  // Escolher o lado vazio tiraria tudo da vista: o outro vem marcado.
  if (localCount === 0 && cloudCount > 0) return 'nuvem'
  if (cloudCount === 0 && localCount > 0) return 'local'
  return null
}

async function inspectWith(host: TransitionHost, action: CloudSwitchAction, raw: PostgresConnectionDraft | undefined, installationId: string): Promise<CloudInspectionDto> {
  const cloudDraft = await host.bootstrap().connection(raw)
  const [local, cloud] = await Promise.all([
    host.localDraft().then(
      (draft) => readSide('local', draft, installationId),
      (error: unknown): SideReading => ({
        summary: { side: 'local', reachable: false, exists: false, conversations: 0, lastUpdate: null, serverVersion: null, error: error instanceof Error ? error.message : String(error) },
        others: []
      })
    ),
    readSide('nuvem', cloudDraft, installationId)
  ])
  const cloudMajor = major(cloud.summary.serverVersion)
  return {
    action,
    local: local.summary,
    cloud: cloud.summary,
    otherInstallations: cloud.others,
    suggested: suggestion(local.summary, cloud.summary),
    olderCloudServer: cloudMajor !== null && cloudMajor < EMBEDDED_MAJOR,
    options: switchOptions(action, cloud.summary)
  }
}

/** O que cada lado tem, para o diálogo (e para o `testar` da ferramenta do agente). */
export async function inspectCloud(deps: StorageSwitchDeps, action: CloudSwitchAction, raw?: PostgresConnectionDraft): Promise<CloudInspectionDto> {
  return deps.lifecycle.exclusive((host) => inspectWith(host, action, raw, deps.installationId()))
}

/** A troca (o app reinicia depois, por quem chamou). */
export async function switchCloud(deps: StorageSwitchDeps, request: CloudSwitchRequestDto): Promise<{ message: string }> {
  deps.assertIdle()
  await deps.backups.cancelDaily()
  return deps.lifecycle.exclusive(async (host) => {
    const data = await host.bootstrap().load()
    if (data.backend !== 'postgres') {
      throw new StorageError('TRANSITION_IN_PROGRESS', 'O banco ainda está no SQLite de recuperação: a troca exige o PostgreSQL local pronto.')
    }
    const from = sideOf(data.postgresTarget)
    const to: DatabaseSide = request.action === 'ligar' ? 'nuvem' : 'local'
    if (from === to) throw new StorageError('TRANSITION_IN_PROGRESS', request.action === 'ligar' ? 'A nuvem já está ligada.' : 'A nuvem já está desligada.')
    // Só copia quando o lado mantido é o que o app deixa de usar.
    const copies = request.keep === from
    const previous = host.status()
    try {
      host.publish('postgres', 'switching-postgres', previous.writable, previous.hasPassword)
      const cloud = await host.bootstrap().connection(request.draft)
      if (to === 'nuvem' || copies) {
        host.step('Testando a conexão com a nuvem')
        await testPostgresConnection(cloud)
      }
      const drafts: Record<DatabaseSide, PostgresConnectionDraft> = {
        nuvem: cloud,
        local: to === 'local' || copies ? await host.localDraft() : cloud
      }
      // Sem cópia, o que não chegou ao lado de agora vai para o novo (diário reaplicado).
      await drainAndHold(deps, host, 'switching-postgres', previous.hasPassword, copies)
      host.step(`Preparando o banco ${to === 'nuvem' ? 'da nuvem' : 'local'}`)
      const { createdDatabase } = await ensureDatabase(deps, drafts[to])
      let detail = `o ${sideLabel(from)} não foi alterado`
      if (copies) {
        let before = 'banco novo, sem backup'
        if (!createdDatabase) {
          host.step(`Salvando um backup do ${sideLabel(to)} antes de sobrescrever`)
          before = `antes, backup ${(await deps.backups.create({ side: to, draft: drafts[to] }, 'antes-da-troca')).file}`
        }
        host.step(`Copiando o ${sideLabel(from)}`)
        const dumped = await deps.backups.dumpForTransfer({ side: from, draft: drafts[from] })
        try {
          host.step(`Gravando a cópia no ${sideLabel(to)} e conferindo as contagens`)
          detail = `${await deps.backups.restoreInto(dumped.file, drafts[to], dumped.counts.tables)}; ${before}`
        } finally {
          await rm(dumped.file, { force: true }).catch(() => undefined)
        }
      }
      if (to === 'nuvem' && request.draft) await host.bootstrap().saveConnection(request.draft)
      await host.bootstrap().selectPostgresTarget(targetOf(to))
      const message =
        `${request.action === 'ligar' ? 'Nuvem ligada' : 'Nuvem desligada'}, mantendo os dados ${request.keep === 'local' ? 'locais' : 'da nuvem'} ` +
        `(${detail}). O app vai reiniciar.`
      deps.log(`troca de banco: ${message}`)
      return { message }
    } catch (error) {
      deps.log(`troca de banco (${request.action}, manter ${request.keep}) cancelada: ${error instanceof Error ? error.message : String(error)}`)
      republish(host, previous)
      throw error
    }
  })
}
