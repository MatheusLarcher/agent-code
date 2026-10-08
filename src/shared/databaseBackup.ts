import type { PostgresConnectionDraft } from './ipc'

/**
 * Backups do banco (pg_dump) e a troca local ↔ nuvem: o que a tela e a
 * ferramenta do agente (`app_postgres_nuvem`) recebem do main.
 */

/** O lado de um banco: o PostgreSQL embutido desta máquina ou o da nuvem. */
export type DatabaseSide = 'local' | 'nuvem'

/** Por que o backup existe: o diário, o de antes de uma troca e o de antes de uma restauração. */
export type BackupReason = 'diario' | 'antes-da-troca' | 'antes-da-restauracao'

export const BACKUP_REASONS: readonly BackupReason[] = ['diario', 'antes-da-troca', 'antes-da-restauracao']

/** No máximo isto por motivo: os diários não empurram para fora o de antes de uma troca. */
export const BACKUPS_PER_REASON = 10

export interface DatabaseBackupDto {
  /** Nome do .dump na pasta de backups (ex.: 2026-10-08_0012_nuvem_antes-da-troca.dump). */
  file: string
  createdAt: string
  side: DatabaseSide
  reason: BackupReason
  appVersion: string
  /** Conversas (não apagadas) no momento do backup. */
  conversations: number
  /** Última atualização de conversa no momento do backup (ISO); null num banco vazio. */
  lastUpdate: string | null
  sizeBytes: number
}

export interface DatabaseBackupListDto {
  dir: string
  /** Soma dos arquivos da pasta: o peso que ela tem no OneDrive. */
  totalBytes: number
  items: DatabaseBackupDto[]
  /** Backup em andamento agora (o diário roda em segundo plano). */
  running: { side: DatabaseSide; reason: BackupReason; startedAt: string } | null
  /** O lado em uso; null fora do PostgreSQL (SQLite de recuperação). */
  activeSide: DatabaseSide | null
  /** A nuvem está ligada: ela também pode ser destino de uma restauração. */
  cloudEnabled: boolean
}

export interface DatabaseRestoreRequestDto {
  file: string
  target: DatabaseSide
}

/** O que um lado tem, para o diálogo da troca. */
export interface DatabaseSideSummaryDto {
  side: DatabaseSide
  /** Conectou? Sem conexão, o lado não pode ser copiado. */
  reachable: boolean
  error?: string
  /** O banco agent-code existe nesse servidor. */
  exists: boolean
  conversations: number
  lastUpdate: string | null
  serverVersion: string | null
}

export type CloudSwitchAction = 'ligar' | 'desligar'

/** Uma escolha do diálogo: o que acontece com cada lado se o usuário escolher manter `keep`. */
export interface CloudSwitchOptionDto {
  keep: DatabaseSide
  /** Há cópia (o lado mantido é o que o app deixa de usar). */
  copies: boolean
  /** O lado sobrescrito (com backup antes); null quando nada é sobrescrito. */
  overwrites: DatabaseSide | null
  description: string
}

export interface CloudInspectionDto {
  action: CloudSwitchAction
  local: DatabaseSideSummaryDto
  cloud: DatabaseSideSummaryDto
  /** Outros PCs vistos recentemente na nuvem (installations). */
  otherInstallations: Array<{ appVersion: string; lastSeenAt: string }>
  /** Lado pré-selecionado: o outro está vazio. null = o usuário escolhe sem sugestão. */
  suggested: DatabaseSide | null
  /** A nuvem roda um PostgreSQL mais antigo que o embutido (18): a cópia para ela pode falhar. */
  olderCloudServer: boolean
  options: CloudSwitchOptionDto[]
}

export interface CloudSwitchRequestDto {
  action: CloudSwitchAction
  keep: DatabaseSide
  /** A conexão da nuvem; ausente = a salva nesta instalação. */
  draft?: PostgresConnectionDraft
}

/** Fim de uma troca/restauração (a da ferramenta do agente roda depois do turno). */
export interface StorageTransitionResultDto {
  ok: boolean
  message: string
}
