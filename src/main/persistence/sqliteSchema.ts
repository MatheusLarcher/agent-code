import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { hashJson, hashText, normalizeJson, type JsonValue } from './hashes'
import {
  isRegisteredPersistedKey,
  migrationScopeForUnknownKey,
  persistedKeyDefinition
} from './keyRegistry'
import { StorageError, type ConversationRecord, type KvScope } from './types'
import { writeDbAtomically } from '../atomicDb'

const LEGACY_CONVERSATIONS_KEY = 'agentcode.conversations.v1'
const DATA_DIRNAME = 'data'

/** Migration 1 — the v2 base. Its text is frozen: the checksum stored in every
 *  existing install is `hashText(SQLITE_V2_SCHEMA)`, so new tables go into
 *  later, additive migrations instead of editing this string. */
export const SQLITE_V2_SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS persistent_kv_v2 (
    scope TEXT NOT NULL CHECK(scope IN ('global', 'device')),
    key TEXT NOT NULL,
    value_text TEXT NOT NULL,
    revision INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(scope, key)
  );
  CREATE TABLE IF NOT EXISTS conversations_v2 (
    id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    revision INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sdk_sessions_v2 (
    project_key TEXT NOT NULL,
    session_id TEXT NOT NULL,
    mtime_ms INTEGER NOT NULL,
    PRIMARY KEY(project_key, session_id)
  );
  CREATE TABLE IF NOT EXISTS sdk_session_entries_v2 (
    project_key TEXT NOT NULL,
    session_id TEXT NOT NULL,
    subpath TEXT NOT NULL DEFAULT '',
    sequence INTEGER NOT NULL,
    entry_uuid TEXT,
    entry_json TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    PRIMARY KEY(project_key, session_id, subpath, sequence)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS sdk_session_entries_uuid_v2
    ON sdk_session_entries_v2(project_key, session_id, subpath, entry_uuid)
    WHERE entry_uuid IS NOT NULL;
  CREATE TABLE IF NOT EXISTS sdk_session_summaries_v2 (
    project_key TEXT NOT NULL,
    session_id TEXT NOT NULL,
    mtime_ms INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY(project_key, session_id)
  );
`

const TASK_STATUS_CHECK = "CHECK(status IN ('pending', 'running', 'blocked', 'review', 'done', 'failed', 'cancelled'))"

/** Migration 2 — task ledger (see docs/superpowers/specs/2026-09-10-registro-de-tarefas…). */
export const SQLITE_TASKS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    project_cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    acceptance_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL ${TASK_STATUS_CHECK},
    owner_agent TEXT,
    write_scope_json TEXT NOT NULL DEFAULT '{"allow":[],"deny":[]}',
    parent_task_id TEXT REFERENCES tasks(id),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lease_token TEXT,
    lease_expires_at TEXT,
    fencing_epoch INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tasks_status_created_at ON tasks(status, created_at);
  CREATE INDEX IF NOT EXISTS tasks_project_cwd ON tasks(project_cwd);
  CREATE TABLE IF NOT EXISTS task_steps (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('analyze', 'implement', 'verify', 'review', 'handoff')),
    status TEXT NOT NULL ${TASK_STATUS_CHECK},
    agent TEXT,
    sdk_session_id TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error_json TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(task_id, seq)
  );
  CREATE TABLE IF NOT EXISTS task_deliverables (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    step_id TEXT REFERENCES task_steps(id),
    kind TEXT NOT NULL CHECK(kind IN ('diff', 'test_run', 'note', 'file', 'screenshot')),
    summary TEXT NOT NULL,
    payload_path TEXT,
    payload_hash TEXT,
    verified INTEGER NOT NULL DEFAULT 0,
    verified_by TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS task_deliverables_task_id ON task_deliverables(task_id);
  CREATE TABLE IF NOT EXISTS task_events (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    step_id TEXT,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    data_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS task_events_task_at ON task_events(task_id, at);
`

const MEMORY_SCOPE_CHECK = "CHECK(scope IN ('user', 'project', 'domain'))"

/** Migration 3 — memory service (memory_entries + memory_proposals queue). */
export const SQLITE_MEMORY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_entries (
    id TEXT PRIMARY KEY,
    rel_path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    hook TEXT NOT NULL,
    scope TEXT NOT NULL ${MEMORY_SCOPE_CHECK},
    project_cwd TEXT,
    domain TEXT,
    body TEXT NOT NULL,
    body_hash TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK(status IN ('active', 'retired')),
    origin_conversation_id TEXT,
    origin_message_id TEXT,
    origin_agent TEXT,
    supersedes_id TEXT REFERENCES memory_entries(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memory_entries_status ON memory_entries(status);
  CREATE TABLE IF NOT EXISTS memory_proposals (
    id TEXT PRIMARY KEY,
    entry_id TEXT REFERENCES memory_entries(id),
    op TEXT NOT NULL CHECK(op IN ('create', 'update', 'retire')),
    rel_path TEXT NOT NULL,
    title TEXT,
    hook TEXT,
    body TEXT,
    scope TEXT NOT NULL ${MEMORY_SCOPE_CHECK},
    project_cwd TEXT,
    domain TEXT,
    origin_conversation_id TEXT,
    origin_message_id TEXT,
    origin_agent TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending', 'applied', 'rejected', 'conflict')),
    reason TEXT,
    proposed_by TEXT NOT NULL,
    expected_revision INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memory_proposals_status_created_at ON memory_proposals(status, created_at);
`

/**
 * Migration 4 — identidade estável de projeto para o registro de tarefas.
 *
 * `tasks.project_cwd` é o caminho local, então o MESMO projeto em dois PCs
 * (`C:\GitHub\agent-code` e `D:\dev\agent-code`) parecia dois projetos
 * diferentes no PostgreSQL compartilhado — cada máquina só enxergava a própria
 * fila. A identidade estável já existe (`resolveProjectIdentity`: remote do git
 * + commit raiz); faltava onde guardá-la.
 *
 * **Por que uma tabela de mapeamento e não uma coluna em `tasks`.** Este schema
 * inteiro é re-executado a cada escrita como guarda idempotente
 * (`db.exec(SQLITE_SCHEMA)`), e o SQLite não tem `ADD COLUMN IF NOT EXISTS`:
 * um `ALTER TABLE` numa migração quebraria toda escrita a partir da segunda.
 * `CREATE TABLE IF NOT EXISTS` é idempotente por construção, então a tabela
 * atravessa a guarda sem tocar no framework de migração.
 *
 * Cada PC grava a própria linha (caminho dele → id do projeto). Ler quem mais
 * compartilha aquele `project_id` devolve os caminhos dos outros PCs — é isso
 * que faz `claim`/`list` enxergarem a fila inteira do projeto.
 */
export const SQLITE_TASK_PROJECT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS task_project_identity (
    project_cwd TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    signature TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS task_project_identity_project ON task_project_identity(project_id);
`

const BOARD_STATUS_VALUES = "('pending', 'in_progress', 'completed')"

/**
 * Migration 5 — quadro de tarefas do agente.
 *
 * Tabela nova em vez de reaproveitar `tasks`: são ciclos de vida diferentes.
 * `tasks` é contrato de delegação (lease, fence, tentativas, escopo de escrita);
 * um cartão do quadro é um passo que o agente declarou e que se marca sozinho
 * quando ele conclui. Espremer os dois na mesma tabela obrigaria um dos dois a
 * carregar colunas que nunca usa e um `status` com dois significados.
 *
 * As duas camadas ficam em colunas separadas (`source_*` do agente, `po_*` do
 * PO) porque a separação é a garantia: a ingestão do snapshot reescreve só a
 * primeira, então um PO que erre nunca apaga o que o agente declarou.
 *
 * A chave de projeto é `project_id` (identidade estável), e não `project_cwd`
 * como em `tasks` — o mesmo repositório clonado em dois PCs tem UM quadro. O
 * caminho local fica junto só para auditoria.
 */
export const SQLITE_BOARD_SCHEMA = `
  CREATE TABLE IF NOT EXISTS board_items (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    project_cwd TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('agent', 'po')),
    source_id TEXT,
    source_title TEXT NOT NULL DEFAULT '',
    source_status TEXT NOT NULL CHECK(source_status IN ${BOARD_STATUS_VALUES}),
    active_form TEXT,
    seq INTEGER NOT NULL DEFAULT 0,
    po_title TEXT,
    po_note TEXT,
    po_status TEXT CHECK(po_status IS NULL OR po_status IN ${BOARD_STATUS_VALUES}),
    po_reason TEXT,
    po_at TEXT,
    dismissed_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS board_items_project ON board_items(project_id, conversation_id);
  CREATE UNIQUE INDEX IF NOT EXISTS board_items_source
    ON board_items(conversation_id, source_id)
    WHERE source_id IS NOT NULL;
`

/**
 * Migration 6 — histórico append-only do quadro (`board_item_events`).
 *
 * O cartão só guarda o ÚLTIMO `po_reason`; sem um log separado, a tela de
 * detalhe não tem como mostrar "o que aconteceu com este cartão" — só "o que
 * é verdade agora". Mesmo espírito do `task_events` (migration 2): uma linha
 * por fato, nunca sobrescrita.
 *
 * `ON DELETE CASCADE`: `syncBoardItems` apaga o cartão de origem `agent` que
 * sumiu do snapshot do CLI — sem cascade, o `DELETE` bate na FK e falha assim
 * que o cartão já tem QUALQUER evento (o próprio "created" basta). A história
 * de um cartão que não existe mais não serve pra nada.
 */
export const SQLITE_BOARD_EVENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS board_item_events (
    id TEXT PRIMARY KEY,
    board_item_id TEXT NOT NULL REFERENCES board_items(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('created', 'status_changed', 'retitled', 'note_changed', 'dismissed', 'restored')),
    actor TEXT NOT NULL CHECK(actor IN ('agent', 'po')),
    from_status TEXT,
    to_status TEXT,
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS board_item_events_item_at ON board_item_events(board_item_id, at);
`

/**
 * Migration 7 — actor `'user'` em `board_item_events` (espelha a migration 9
 * do PostgreSQL).
 *
 * O drag-and-drop no Quadro é um TERCEIRO tipo de escritor no histórico do
 * cartão — nem o agente (snapshot do CLI) nem o PO (auditoria automática) —
 * e é exatamente para distinguir isso que a tabela de eventos existe.
 *
 * SQLite não altera `CHECK` inline com `ALTER TABLE`: a migration recria a
 * tabela preservando as linhas existentes, para que um cartão com eventos
 * antigos (`agent`/`po`) continue legível depois dela.
 */
export const SQLITE_BOARD_EVENTS_ACTOR_USER_SCHEMA = `
  PRAGMA foreign_keys=OFF;
  CREATE TABLE board_item_events_v2 (
    id TEXT PRIMARY KEY,
    board_item_id TEXT NOT NULL REFERENCES board_items(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('created','status_changed','retitled','note_changed','dismissed','restored')),
    actor TEXT NOT NULL CHECK(actor IN ('agent','po','user')),
    from_status TEXT,
    to_status TEXT,
    note TEXT
  );
  INSERT INTO board_item_events_v2 SELECT * FROM board_item_events;
  DROP TABLE board_item_events;
  ALTER TABLE board_item_events_v2 RENAME TO board_item_events;
  CREATE INDEX IF NOT EXISTS board_item_events_item_at ON board_item_events(board_item_id, at);
  PRAGMA foreign_keys=ON;
`

/**
 * Migration 8 — vínculo entre uma tarefa do ledger e um cartão do quadro
 * (`task_board_links`).
 *
 * Tabela de mapeamento nova, não uma coluna em `tasks` ou `board_items`: mesmo
 * motivo da migration 4 — este schema inteiro reexecuta a cada `write()` como
 * guarda idempotente, e SQLite não tem `ADD COLUMN IF NOT EXISTS`. Um `ALTER
 * TABLE` numa migração quebraria toda escrita a partir da segunda vez;
 * `CREATE TABLE IF NOT EXISTS` atravessa o guarda sem custo.
 *
 * `task_id` é PK: uma tarefa vincula a no máximo um cartão. `board_item_id`
 * tem `ON DELETE CASCADE` porque um vínculo para um cartão apagado não serve
 * pra nada — mesmo espírito de `board_item_events.board_item_id`.
 */
export const SQLITE_TASK_BOARD_LINKS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS task_board_links (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    board_item_id TEXT NOT NULL REFERENCES board_items(id) ON DELETE CASCADE,
    linked_by TEXT NOT NULL CHECK(linked_by IN ('agent', 'po')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS task_board_links_board_item ON task_board_links(board_item_id);
`

/**
 * Migration 9 — árvore de consumo de tokens por chamada de LLM (`llm_calls` +
 * `llm_usage_totals`), ver
 * docs/superpowers/specs/2026-09-19-arvore-consumo-tokens-design.md.
 *
 * `llm_usage_totals` é um agregado incremental (upsert a cada INSERT em
 * `llm_calls`, na mesma escrita) para não depender da poda de 15 dias rodar:
 * o total da conversa continua correto mesmo depois que o detalhe já foi
 * apagado. `subagent_type` entra com `''` (nunca `NULL`) na chave primária da
 * tabela de totais porque SQLite trata `NULL` como distinto de si mesmo em
 * `UNIQUE`/`PRIMARY KEY` — duas linhas "sem subagente" no mesmo dia/modelo
 * duplicariam o agregado da raiz em vez de somar na mesma linha.
 */
export const SQLITE_AGENT_INPUT_QUEUE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_input_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    message_uuid TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'processing')) DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    available_at TEXT NOT NULL,
    processing_started_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(conversation_id, message_uuid),
    UNIQUE(conversation_id, sequence)
  );
  CREATE INDEX IF NOT EXISTS agent_input_queue_fifo ON agent_input_queue(conversation_id, status, sequence);
`

export const SQLITE_TOKEN_USAGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS llm_calls (
    id TEXT PRIMARY KEY,
    conv_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    parent_node_id TEXT,
    subagent_type TEXT,
    task_description TEXT,
    seq INTEGER NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    input_preview TEXT,
    output_preview TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS llm_calls_conv_id ON llm_calls(conv_id, created_at);
  CREATE INDEX IF NOT EXISTS llm_calls_created_at ON llm_calls(created_at);
  CREATE TABLE IF NOT EXISTS llm_usage_totals (
    conv_id TEXT NOT NULL,
    day TEXT NOT NULL,
    model TEXT NOT NULL,
    subagent_type TEXT NOT NULL DEFAULT '',
    sum_input INTEGER NOT NULL DEFAULT 0,
    sum_output INTEGER NOT NULL DEFAULT 0,
    sum_cache_read INTEGER NOT NULL DEFAULT 0,
    sum_cache_write INTEGER NOT NULL DEFAULT 0,
    sum_cost REAL,
    call_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(conv_id, day, model, subagent_type)
  );
  CREATE INDEX IF NOT EXISTS llm_usage_totals_conv_id ON llm_usage_totals(conv_id);
`

export interface SqliteMigration {
  version: number
  name: string
  sql: string
  /**
   * SQL rodado pelo guarda idempotente de `write()` (`SQLITE_SCHEMA`), que
   * reexecuta a cada escrita — não só uma vez, como a migração versionada.
   * Por padrão é o mesmo `sql`, e só faz sentido divergir quando `sql` não é
   * seguro de repetir para sempre (ex.: um recreate de tabela). Nesse caso,
   * `writeGuardSql` é a versão barata e idempotente de verdade (`IF NOT
   * EXISTS` puro) que garante o estado final sem refazer o trabalho pesado —
   * ele já rodou uma vez, de forma correta, via `applyPendingMigrations`.
   */
  writeGuardSql: string
  checksum: string
}

function migration(version: number, name: string, sql: string, writeGuardSql: string = sql): SqliteMigration {
  return { version, name, sql, writeGuardSql, checksum: hashText(sql) }
}

/** Ordered, additive. Every statement is `IF NOT EXISTS`, so the concatenation
 *  (`SQLITE_SCHEMA`) can be re-run on every write as an idempotent guard. */
export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  migration(1, 'sqlite-v2-base', SQLITE_V2_SCHEMA),
  migration(2, 'sqlite-v2-tasks', SQLITE_TASKS_SCHEMA),
  migration(3, 'sqlite-v2-memory', SQLITE_MEMORY_SCHEMA),
  migration(4, 'sqlite-v2-task-project-identity', SQLITE_TASK_PROJECT_SCHEMA),
  migration(5, 'sqlite-v2-board', SQLITE_BOARD_SCHEMA),
  migration(6, 'sqlite-v2-board-events', SQLITE_BOARD_EVENTS_SCHEMA),
  // `sql` (o recreate de tabela) roda EXATAMENTE uma vez — no bootstrap de
  // instalação nova (`db.exec(SQLITE_SCHEMA)`, que só executa quando o banco
  // ainda não existe) e na migração de um banco existente
  // (`applyPendingMigrations`, gravado em `schema_migrations`). O guarda de
  // `write()` reexecuta a cada escrita para sempre; se ele repetisse o
  // recreate, toda escrita da vida do app — mesmo numa tabela sem nenhuma
  // relação com o quadro — copiaria o histórico inteiro de `board_item_events`
  // para uma tabela nova e a recriaria. `writeGuardSql` aqui só garante o
  // estado final (o índice), porque o recreate em si já rodou.
  migration(
    7,
    'sqlite-v2-board-events-actor-user',
    SQLITE_BOARD_EVENTS_ACTOR_USER_SCHEMA,
    'CREATE INDEX IF NOT EXISTS board_item_events_item_at ON board_item_events(board_item_id, at);'
  ),
  migration(8, 'sqlite-v2-task-board-links', SQLITE_TASK_BOARD_LINKS_SCHEMA),
  migration(9, 'sqlite-v2-token-usage', SQLITE_TOKEN_USAGE_SCHEMA),
  migration(10, 'sqlite-v2-agent-input-queue', SQLITE_AGENT_INPUT_QUEUE_SCHEMA)
]

/** Guarda idempotente de `write()` (roda a cada escrita, para sempre). */
export const SQLITE_SCHEMA = SQLITE_MIGRATIONS.map((entry) => entry.writeGuardSql).join('\n')

/** SQL completo de toda migração, na ordem — usado só onde a execução é
 *  garantidamente ÚNICA num banco novo: o bootstrap de instalação nova
 *  (abaixo) e a exportação Postgres→SQLite (`postgresTransfer.ts`). Nunca
 *  chame isto de `write()`; é exatamente para não repetir o `sql` pesado de
 *  migrações como a 7 que `writeGuardSql` existe. */
export const SQLITE_SCHEMA_FULL = SQLITE_MIGRATIONS.map((entry) => entry.sql).join('\n')

const LATEST_VERSION = SQLITE_MIGRATIONS.at(-1)!.version

/** Marks every migration as applied in a freshly built db (all DDL already executed). */
export function recordSqliteMigrations(db: DatabaseSync, appliedAt: string): void {
  const insert = db.prepare(
    `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES(?, ?, ?, ?)
     ON CONFLICT(version) DO NOTHING`
  )
  for (const entry of SQLITE_MIGRATIONS) insert.run(entry.version, entry.name, entry.checksum, appliedAt)
}

interface LegacyKv {
  key: string
  value: string
  scope: KvScope
}

function close(db: DatabaseSync): void {
  try {
    db.close()
  } catch {
    /* already closed */
  }
}

function withReadableDb<T>(path: string, fn: (db: DatabaseSync) => T): T {
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(path, { readOnly: true })
    return fn(db)
  } catch (cause) {
    if (cause instanceof StorageError) throw cause
    throw new StorageError('INVALID_PERSISTED_DATA', `Banco SQLite ilegível: ${path}`, false, { cause })
  } finally {
    if (db) close(db)
  }
}

function readLegacyKv(dbPath: string): LegacyKv[] {
  if (!existsSync(dbPath)) return []
  return withReadableDb(dbPath, (db) => {
    const hasKv = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get()
    if (!hasKv) return []
    const rows = db.prepare('SELECT key, value FROM kv ORDER BY key').all() as unknown as Array<{
      key: string
      value: string
    }>
    return rows
      .filter((row) => row.key !== LEGACY_CONVERSATIONS_KEY)
      .map((row) => ({
        key: row.key,
        value: row.value,
        scope: isRegisteredPersistedKey(row.key)
          ? persistedKeyDefinition(row.key).scope
          : migrationScopeForUnknownKey()
      }))
  })
}

function parseConversationArray(raw: string, source: string): ConversationRecord[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new StorageError('INVALID_PERSISTED_DATA', `Histórico inválido em ${source}.`, false, { cause })
  }
  if (!Array.isArray(parsed)) {
    throw new StorageError('INVALID_PERSISTED_DATA', `Histórico em ${source} não é uma lista.`)
  }
  return parsed as ConversationRecord[]
}

function readLegacyConversationBlob(dbPath: string): ConversationRecord[] {
  if (!existsSync(dbPath)) return []
  return withReadableDb(dbPath, (db) => {
    const hasKv = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get()
    if (!hasKv) return []
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(LEGACY_CONVERSATIONS_KEY) as
      | { value?: string }
      | undefined
    return row?.value ? parseConversationArray(row.value, `${dbPath}:${LEGACY_CONVERSATIONS_KEY}`) : []
  })
}

function readProjectConversations(cacheDir: string): ConversationRecord[] {
  const dir = join(cacheDir, DATA_DIRNAME)
  let files: string[]
  try {
    files = readdirSync(dir).filter((file) => file.toLowerCase().endsWith('.db'))
  } catch {
    return []
  }
  const records: ConversationRecord[] = []
  for (const file of files) {
    const path = join(dir, file)
    records.push(
      ...withReadableDb(path, (db) => {
        const hasKv = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get()
        if (!hasKv) throw new StorageError('INVALID_PERSISTED_DATA', `Tabela kv ausente em ${path}.`)
        const row = db.prepare("SELECT value FROM kv WHERE key = 'conversations'").get() as
          | { value?: string }
          | undefined
        return row?.value ? parseConversationArray(row.value, path) : []
      })
    )
  }
  return records
}

function numericField(record: ConversationRecord, field: string): number {
  const value = record[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function messageCount(record: ConversationRecord): number {
  return Array.isArray(record.messages) ? record.messages.length : 0
}

function richer(left: ConversationRecord, right: ConversationRecord): ConversationRecord {
  const byUpdatedAt = numericField(left, 'updatedAt') - numericField(right, 'updatedAt')
  if (byUpdatedAt !== 0) return byUpdatedAt > 0 ? left : right
  return messageCount(left) >= messageCount(right) ? left : right
}

function conflictCopy(record: ConversationRecord, originalId: string, hash: string): ConversationRecord {
  const title = typeof record.title === 'string' && record.title.trim() ? record.title : 'Conversa'
  return {
    ...record,
    id: `${originalId}-conflict-${hash.slice(0, 8)}`,
    title: `${title} (conflito importado)`,
    legacyConflictOf: originalId
  }
}

function normalizeConversations(records: ConversationRecord[]): ConversationRecord[] {
  const byId = new Map<string, { record: ConversationRecord; hash: string }>()
  const conflicts: ConversationRecord[] = []
  for (const raw of records) {
    const record = normalizeJson(raw) as ConversationRecord & JsonValue
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (!id) throw new StorageError('INVALID_PERSISTED_DATA', 'Conversa sem ID no histórico SQLite.')
    const hash = hashJson(record)
    const current = byId.get(id)
    if (!current) {
      byId.set(id, { record, hash })
      continue
    }
    if (current.hash === hash) continue
    const winner = richer(current.record, record)
    const loser = winner === current.record ? record : current.record
    const loserHash = winner === current.record ? hash : current.hash
    byId.set(id, { record: winner, hash: hashJson(winner as JsonValue) })
    conflicts.push(conflictCopy(loser, id, loserHash))
  }
  return [...[...byId.values()].map((value) => value.record), ...conflicts]
}

function isoFromRecord(value: unknown, fallback: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? fallback : date.toISOString()
}

/** Versions already recorded in `schema_migrations`, after verifying each one's
 *  checksum. Empty when the file is missing or still pre-v2 (legacy `kv` only). */
function appliedMigrations(dbPath: string): Set<number> {
  if (!existsSync(dbPath)) return new Set()
  return withReadableDb(dbPath, (db) => {
    const table = db
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get()
    if (!table) return new Set<number>()
    const rows = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as unknown as Array<{
      version: number
      checksum: string
    }>
    const applied = new Set<number>()
    for (const row of rows) {
      const version = Number(row.version)
      if (version > LATEST_VERSION) {
        throw new StorageError('SCHEMA_TOO_NEW', 'O schema SQLite foi criado por uma versão mais nova do Agent Code.')
      }
      const known = SQLITE_MIGRATIONS.find((entry) => entry.version === version)
      if (!known || known.checksum !== row.checksum) {
        throw new StorageError('SCHEMA_CHECKSUM_MISMATCH', `O checksum da migration SQLite ${version} não confere.`)
      }
      applied.add(version)
    }
    if (applied.has(1)) {
      for (const name of [
        'persistent_kv_v2',
        'conversations_v2',
        'sdk_sessions_v2',
        'sdk_session_entries_v2',
        'sdk_session_summaries_v2'
      ]) {
        const found = db
          .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(name)
        if (!found) throw new StorageError('INVALID_PERSISTED_DATA', `Tabela SQLite v2 ausente: ${name}.`)
      }
    }
    return applied
  })
}

/** Additive upgrade of an existing v2 db: run only the missing migrations, each
 *  recorded in the same transaction, on an atomically swapped copy. */
function applyPendingMigrations(dbPath: string, applied: Set<number>): void {
  const pending = SQLITE_MIGRATIONS.filter((entry) => !applied.has(entry.version))
  if (pending.length === 0) return
  const appliedAt = new Date().toISOString()
  writeDbAtomically(
    dbPath,
    (db) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const entry of pending) {
          db.exec(entry.sql)
          db.prepare(
            `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES(?, ?, ?, ?)`
          ).run(entry.version, entry.name, entry.checksum, appliedAt)
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    { seed: true }
  )
}

export function initializeSqliteV2(cacheDir: string, dbPath: string): void {
  mkdirSync(cacheDir, { recursive: true })
  const applied = appliedMigrations(dbPath)
  if (applied.has(1)) {
    applyPendingMigrations(dbPath, applied)
    return
  }

  const appliedAt = new Date().toISOString()
  const legacyKv = readLegacyKv(dbPath)
  const legacyConversations = normalizeConversations([
    ...readLegacyConversationBlob(dbPath),
    ...readProjectConversations(cacheDir)
  ])
  const backupPath = `${dbPath}.pre-v2.bak`
  if (existsSync(dbPath) && !existsSync(backupPath)) {
    try {
      copyFileSync(dbPath, backupPath)
    } catch (cause) {
      throw new StorageError('MIGRATION_VERIFICATION_FAILED', 'Não foi possível criar o backup pré-v2.', false, {
        cause
      })
    }
  }

  writeDbAtomically(
    dbPath,
    (db) => {
      // Completo, não o guarda: esta é a ÚNICA vez que este banco vai existir
      // e passar por toda migração — precisa do `sql` de verdade (o recreate
      // da migração 7 incluído), não do atalho barato que `SQLITE_SCHEMA`
      // (o guarda de `write()`) usa para não repetir esse recreate para sempre.
      db.exec(SQLITE_SCHEMA_FULL)
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const entry of legacyKv) {
          db.prepare(
            `INSERT INTO persistent_kv_v2(scope, key, value_text, revision, content_hash, updated_at)
             VALUES(?, ?, ?, 1, ?, ?)
             ON CONFLICT(scope, key) DO NOTHING`
          ).run(entry.scope, entry.key, entry.value, hashText(entry.value), appliedAt)
        }
        for (const record of legacyConversations) {
          const id = record.id as string
          const payload = normalizeJson(record)
          db.prepare(
            `INSERT INTO conversations_v2(
               id, payload_json, revision, content_hash, created_at, updated_at, deleted_at
             ) VALUES(?, ?, 1, ?, ?, ?, NULL)
             ON CONFLICT(id) DO NOTHING`
          ).run(
            id,
            JSON.stringify(payload),
            hashJson(payload),
            isoFromRecord(record.createdAt, appliedAt),
            isoFromRecord(record.updatedAt, appliedAt)
          )
        }
        recordSqliteMigrations(db, appliedAt)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    { seed: true }
  )
}
