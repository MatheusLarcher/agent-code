import type { PoolClient } from 'pg'
import { hashText } from './hashes'
import { StorageError } from './types'

export interface PostgresMigration {
  version: number
  name: string
  sql: string
  checksum: string
}

const BASE_SCHEMA = `
CREATE TABLE installations (
  installation_id uuid PRIMARY KEY,
  app_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE global_kv (
  key text PRIMARY KEY,
  value_text text NOT NULL,
  revision bigint NOT NULL,
  content_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid NOT NULL REFERENCES installations(installation_id)
);
CREATE TABLE device_kv (
  installation_id uuid NOT NULL REFERENCES installations(installation_id),
  key text NOT NULL,
  value_text text NOT NULL,
  revision bigint NOT NULL,
  content_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (installation_id, key)
);
CREATE TABLE projects (
  project_id uuid PRIMARY KEY,
  remote_git text,
  signature text NOT NULL UNIQUE,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE project_devices (
  project_id uuid NOT NULL REFERENCES projects(project_id),
  installation_id uuid NOT NULL REFERENCES installations(installation_id),
  local_path text NOT NULL,
  signature text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, installation_id)
);
CREATE TABLE conversations (
  conversation_id text PRIMARY KEY,
  project_id uuid REFERENCES projects(project_id),
  payload jsonb NOT NULL,
  revision bigint NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  updated_by uuid NOT NULL REFERENCES installations(installation_id)
);
CREATE TABLE conversation_device_state (
  conversation_id text NOT NULL REFERENCES conversations(conversation_id),
  installation_id uuid NOT NULL REFERENCES installations(installation_id),
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (conversation_id, installation_id)
);
CREATE TABLE sdk_sessions (
  conversation_id text NOT NULL REFERENCES conversations(conversation_id),
  session_id text NOT NULL,
  mtime_ms bigint NOT NULL,
  sdk_version text NOT NULL,
  verified_hash text,
  resume_ready boolean NOT NULL DEFAULT false,
  mirror_error text,
  PRIMARY KEY (conversation_id, session_id)
);
CREATE TABLE sdk_session_entries (
  conversation_id text NOT NULL,
  session_id text NOT NULL,
  subpath text NOT NULL DEFAULT '',
  sequence bigint NOT NULL,
  entry_uuid text,
  entry jsonb NOT NULL,
  content_hash text NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (conversation_id, session_id, subpath, sequence),
  FOREIGN KEY (conversation_id, session_id) REFERENCES sdk_sessions(conversation_id, session_id)
);
CREATE UNIQUE INDEX sdk_session_entries_uuid
  ON sdk_session_entries(conversation_id, session_id, subpath, entry_uuid)
  WHERE entry_uuid IS NOT NULL;
CREATE TABLE sdk_session_summaries (
  conversation_id text NOT NULL,
  session_id text NOT NULL,
  mtime_ms bigint NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (conversation_id, session_id),
  FOREIGN KEY (conversation_id, session_id) REFERENCES sdk_sessions(conversation_id, session_id)
);
CREATE TABLE conversation_leases (
  conversation_id text PRIMARY KEY REFERENCES conversations(conversation_id),
  owner_installation_id uuid NOT NULL REFERENCES installations(installation_id),
  token uuid NOT NULL,
  fencing_epoch bigint NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
);
CREATE TABLE change_log (
  change_id bigserial PRIMARY KEY,
  entity text NOT NULL,
  entity_id text NOT NULL,
  scope text NOT NULL,
  revision bigint,
  installation_id uuid,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX change_log_changed_at ON change_log(changed_at);
CREATE TABLE installation_change_cursors (
  installation_id uuid PRIMARY KEY REFERENCES installations(installation_id),
  change_id bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE migration_runs (
  migration_run_id uuid PRIMARY KEY,
  transition_id uuid NOT NULL,
  installation_id uuid NOT NULL REFERENCES installations(installation_id),
  direction text NOT NULL CHECK(direction IN ('sqlite-to-postgres', 'postgres-to-sqlite')),
  status text NOT NULL,
  source_hash text,
  target_hash text,
  watermark text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  committed_at timestamptz
);
CREATE TABLE migration_items (
  migration_run_id uuid NOT NULL REFERENCES migration_runs(migration_run_id),
  entity text NOT NULL,
  entity_id text NOT NULL,
  content_hash text NOT NULL,
  item_count bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (migration_run_id, entity, entity_id)
);
`

const CHANGE_FEED = `
CREATE FUNCTION agent_code_record_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  new_id bigint;
  entity_name text;
  entity_key text;
  entity_scope text;
  entity_revision bigint;
  author uuid;
BEGIN
  entity_name := TG_ARGV[0];
  entity_scope := TG_ARGV[1];
  IF TG_TABLE_NAME = 'global_kv' THEN
    entity_key := NEW.key; entity_revision := NEW.revision; author := NEW.updated_by;
  ELSIF TG_TABLE_NAME = 'device_kv' THEN
    entity_key := NEW.key; entity_revision := NEW.revision; author := NEW.installation_id;
  ELSIF TG_TABLE_NAME = 'conversations' THEN
    entity_key := NEW.conversation_id; entity_revision := NEW.revision; author := NEW.updated_by;
  ELSIF TG_TABLE_NAME = 'projects' THEN
    entity_key := NEW.project_id::text; entity_revision := NULL; author := NULL;
  ELSE
    entity_key := NEW.conversation_id; entity_revision := NEW.fencing_epoch; author := NEW.owner_installation_id;
  END IF;
  INSERT INTO change_log(entity, entity_id, scope, revision, installation_id)
    VALUES(entity_name, entity_key, entity_scope, entity_revision, author)
    RETURNING change_id INTO new_id;
  PERFORM pg_notify('agent_code_changes', new_id::text);
  RETURN NEW;
END $$;
CREATE TRIGGER global_kv_change AFTER INSERT OR UPDATE ON global_kv
  FOR EACH ROW EXECUTE FUNCTION agent_code_record_change('global-kv', 'global');
CREATE TRIGGER device_kv_change AFTER INSERT OR UPDATE ON device_kv
  FOR EACH ROW EXECUTE FUNCTION agent_code_record_change('device-kv', 'device');
CREATE TRIGGER conversation_change AFTER INSERT OR UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION agent_code_record_change('conversation', 'global');
CREATE TRIGGER project_change AFTER INSERT OR UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION agent_code_record_change('project', 'global');
CREATE TRIGGER lease_change AFTER INSERT OR UPDATE ON conversation_leases
  FOR EACH ROW EXECUTE FUNCTION agent_code_record_change('lease', 'global');
`

const DEVICE_STATE_CHANGE_FEED = `
CREATE OR REPLACE FUNCTION agent_code_record_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  new_id bigint;
  entity_name text;
  entity_key text;
  entity_scope text;
  entity_revision bigint;
  author uuid;
BEGIN
  entity_name := TG_ARGV[0]; entity_scope := TG_ARGV[1];
  IF TG_TABLE_NAME = 'global_kv' THEN
    entity_key := NEW.key; entity_revision := NEW.revision; author := NEW.updated_by;
  ELSIF TG_TABLE_NAME = 'device_kv' THEN
    entity_key := NEW.key; entity_revision := NEW.revision; author := NEW.installation_id;
  ELSIF TG_TABLE_NAME = 'conversations' THEN
    entity_key := NEW.conversation_id; entity_revision := NEW.revision; author := NEW.updated_by;
  ELSIF TG_TABLE_NAME = 'conversation_device_state' THEN
    entity_key := NEW.conversation_id; entity_revision := NEW.revision; author := NEW.installation_id;
  ELSIF TG_TABLE_NAME = 'projects' THEN
    entity_key := NEW.project_id::text; entity_revision := NULL; author := NULL;
  ELSE
    entity_key := NEW.conversation_id; entity_revision := NEW.fencing_epoch; author := NEW.owner_installation_id;
  END IF;
  INSERT INTO change_log(entity, entity_id, scope, revision, installation_id)
    VALUES(entity_name, entity_key, entity_scope, entity_revision, author)
    RETURNING change_id INTO new_id;
  PERFORM pg_notify('agent_code_changes', new_id::text);
  RETURN NEW;
END $$;
CREATE TRIGGER conversation_device_state_change AFTER INSERT OR UPDATE ON conversation_device_state
  FOR EACH ROW EXECUTE FUNCTION agent_code_record_change('conversation', 'device');
`

function migration(version: number, name: string, sql: string): PostgresMigration {
  return { version, name, sql, checksum: hashText(sql) }
}

export const POSTGRES_MIGRATIONS: readonly PostgresMigration[] = [
  migration(1, 'postgres-base-schema', BASE_SCHEMA),
  migration(2, 'postgres-change-feed', CHANGE_FEED),
  migration(3, 'postgres-device-state-feed', DEVICE_STATE_CHANGE_FEED)
]

const MIGRATION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  app_version text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_by uuid NOT NULL
)`

export async function applyPostgresMigrations(
  client: PoolClient,
  installationId: string,
  appVersion: string
): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [7_420_260_829])
    await client.query(MIGRATION_TABLE)
    const existing = await client.query<{ version: number; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version'
    )
    const newest = Math.max(0, ...existing.rows.map((row) => Number(row.version)))
    const supported = POSTGRES_MIGRATIONS.at(-1)?.version ?? 0
    if (newest > supported) {
      throw new StorageError('SCHEMA_TOO_NEW', 'O schema PostgreSQL foi criado por uma versão mais nova do Agent Code.')
    }
    for (const row of existing.rows) {
      const known = POSTGRES_MIGRATIONS.find((entry) => entry.version === Number(row.version))
      if (!known || known.checksum !== row.checksum) {
        throw new StorageError('SCHEMA_CHECKSUM_MISMATCH', `Checksum divergente na migration PostgreSQL ${row.version}.`)
      }
    }
    const applied = new Set(existing.rows.map((row) => Number(row.version)))
    for (const entry of POSTGRES_MIGRATIONS) {
      if (applied.has(entry.version)) continue
      await client.query(entry.sql)
      await client.query(
        `INSERT INTO schema_migrations(version, name, checksum, app_version, applied_by)
         VALUES($1, $2, $3, $4, $5)`,
        [entry.version, entry.name, entry.checksum, appVersion, installationId]
      )
    }
    await client.query('COMMIT')
  } catch (cause) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw cause
  }
}
