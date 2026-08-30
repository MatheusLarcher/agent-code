import { app, safeStorage } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { Client } from 'pg'

const userData = process.env.AGENT_CODE_DIAGNOSTIC_USER_DATA
if (!userData) throw new Error('AGENT_CODE_DIAGNOSTIC_USER_DATA is required')
const bootstrapUserData = process.env.AGENT_CODE_DIAGNOSTIC_BOOTSTRAP_USER_DATA ?? userData
const output = process.env.AGENT_CODE_DIAGNOSTIC_OUTPUT
if (!output) throw new Error('AGENT_CODE_DIAGNOSTIC_OUTPUT is required')
app.setPath('userData', userData)

async function emit(report) {
  await writeFile(output, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600 })
}

await emit({ ok: false, phase: 'starting' })

function ssl(tlsMode, ca) {
  if (tlsMode === 'disable') return false
  if (tlsMode === 'verify-full') return { rejectUnauthorized: true, ca: ca || undefined }
  return { rejectUnauthorized: false }
}

function sanitized(error) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    code: typeof error?.code === 'string' ? error.code : undefined,
    message: error instanceof Error ? error.message.replace(/password=[^\s]+/gi, 'password=[redacted]') : String(error)
  }
}

app.whenReady().then(async () => {
  const bootstrap = JSON.parse(await readFile(`${bootstrapUserData}\\storage-bootstrap.json`, 'utf8'))
  let password
  try {
    password = safeStorage.decryptString(Buffer.from(bootstrap.postgres.encryptedPassword, 'base64'))
  } catch (error) {
    await emit({ ok: false, phase: 'decrypt', error: sanitized(error) })
    app.quit()
    process.exitCode = 1
  }

  if (password !== undefined) {
  const base = {
    host: bootstrap.postgres.host,
    port: bootstrap.postgres.port,
    user: bootstrap.postgres.user,
    password,
    connectionTimeoutMillis: 8_000,
    ssl: ssl(bootstrap.postgres.tlsMode, bootstrap.postgres.ca)
  }
  const report = {
    ok: false,
    configuredBackend: bootstrap.backend,
    transitionState: bootstrap.transitionState,
    maintenance: null,
    target: null
  }
  const maintenance = new Client({ ...base, database: bootstrap.postgres.maintenanceDatabase })
  try {
    await maintenance.connect()
    const role = await maintenance.query(
      `SELECT current_user AS user_name, r.rolcreatedb, r.rolsuper,
         EXISTS(SELECT 1 FROM pg_database WHERE datname = 'agent-code') AS target_exists
       FROM pg_roles r WHERE r.rolname = current_user`
    )
    report.maintenance = role.rows[0]
  } catch (error) {
    report.maintenance = { error: sanitized(error) }
  } finally {
    await maintenance.end().catch(() => undefined)
  }
  if (report.maintenance?.target_exists) {
    const target = new Client({ ...base, database: 'agent-code' })
    try {
      await target.connect()
      const [schema, counts] = await Promise.all([
        target.query(`SELECT to_regclass('public.schema_migrations') AS migrations_table,
          to_regclass('public.conversations') AS conversations_table`),
        target.query(`SELECT
          (SELECT count(*)::int FROM conversations) AS conversations,
          (SELECT count(*)::int FROM global_kv) AS global_kv,
          (SELECT count(*)::int FROM device_kv) AS device_kv`)
      ])
      report.target = { ...schema.rows[0], ...counts.rows[0] }
      if (process.env.AGENT_CODE_DIAGNOSTIC_ACTIVE === '1') {
        const ui = await target.query(
          `SELECT value_text FROM device_kv
           WHERE installation_id = $1 AND key = 'agentcode.ui.v1'`,
          [bootstrap.installationId]
        )
        let activeId
        try { activeId = JSON.parse(ui.rows[0]?.value_text ?? '{}').activeId } catch {}
        if (typeof activeId === 'string') {
          const active = await target.query(
            `SELECT conversation_id, revision::int, updated_at,
               CASE WHEN jsonb_typeof(payload->'messages') = 'array'
                 THEN jsonb_array_length(payload->'messages') ELSE 0 END AS message_count,
               payload->'messages'->-1->>'kind' AS last_message_kind,
               payload->'messages'->-1->>'answer' AS last_message_answer,
               payload->'messages'->-1->>'ts' AS last_message_ts
             FROM conversations WHERE conversation_id = $1`,
            [activeId]
          )
          report.target.active = active.rows[0] ?? null
        }
      }
      if (process.env.AGENT_CODE_DIAGNOSTIC_CONVERSATION_ID) {
        const proof = await target.query(
          `SELECT conversation_id, revision::int, deleted_at IS NOT NULL AS deleted,
             updated_by::text AS updated_by
           FROM conversations WHERE conversation_id = $1`,
          [process.env.AGENT_CODE_DIAGNOSTIC_CONVERSATION_ID]
        )
        report.target.proof = proof.rows[0] ?? null
      }
      report.ok = true
    } catch (error) {
      report.target = { error: sanitized(error) }
    } finally {
      await target.end().catch(() => undefined)
    }
  }
  await emit(report)
    password = undefined
    app.quit()
  }
}).catch(async (error) => {
  await emit({ ok: false, phase: 'ready', error: sanitized(error) })
  app.quit()
  process.exitCode = 1
})
