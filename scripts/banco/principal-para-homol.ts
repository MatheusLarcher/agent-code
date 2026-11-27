// Leva o banco do Agent Code PRINCIPAL (conversas, memórias, quadro…) para a Homol, como um
// backup que a Homol restaura em Configurações › Dados › Backups.
//
// SÓ LEITURA no principal: copia a pasta do Postgres dele para uma pasta temporária, sobe um
// Postgres separado em cima da CÓPIA (sem senha, só 127.0.0.1), conta as linhas e faz o pg_dump
// da cópia, parada (contagem exata). O principal não é tocado e pode continuar aberto.
//
//   npx esbuild scripts/banco/principal-para-homol.ts --bundle --platform=node --format=esm --packages=external --outfile=scripts/banco/.p2h.tmp.mjs
//   node scripts/banco/.p2h.tmp.mjs
import { execFileSync } from 'node:child_process'
import { mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { lerBanco, pgBin } from '../analise-conversas/banco.mjs'
import { countDatabase } from '../../src/main/persistence/backup/databaseCounts'
import { pgDumpArgs } from '../../src/main/persistence/backup/pgTools'

const LOCAL = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
const ORIGEM = join(LOCAL, 'agent-code', 'pgdata')
// A pasta de backups da Homol (<pasta de dados da Homol>\backups); 1º argumento, se a pasta mudou.
const DESTINO = process.argv[2] ?? join(homedir(), 'Documents', 'agent-code-homol', 'backups')
const PORTA = 15497

const agora = new Date()
const p2 = (n: number): string => String(n).padStart(2, '0')
const nome = `${agora.getFullYear()}-${p2(agora.getMonth() + 1)}-${p2(agora.getDate())}_${p2(agora.getHours())}${p2(agora.getMinutes())}_PRINCIPAL_local_diario`

await lerBanco(ORIGEM, PORTA, async () => {
  const client = new pg.Client({ host: '127.0.0.1', port: PORTA, user: 'agentcode', database: 'agent-code' })
  await client.connect()
  try {
    const counts = await countDatabase(client)
    const serverVersion = (await client.query<{ v: string }>("SELECT current_setting('server_version') AS v")).rows[0]?.v ?? null
    mkdirSync(DESTINO, { recursive: true })
    const parcial = join(DESTINO, `${nome}.dump.partial`)
    execFileSync(join(pgBin(), 'pg_dump.exe'), ['-h', '127.0.0.1', '-p', String(PORTA), '-U', 'agentcode', ...pgDumpArgs(parcial)], { stdio: 'inherit' })
    renameSync(parcial, join(DESTINO, `${nome}.dump`))
    const meta = {
      version: 1, file: `${nome}.dump`, createdAt: agora.toISOString(), side: 'local', reason: 'diario',
      appVersion: '0.1.185', conversations: counts.conversations, lastUpdate: counts.lastUpdate,
      sizeBytes: statSync(join(DESTINO, `${nome}.dump`)).size, tables: counts.tables, serverVersion, machine: 'PRINCIPAL'
    }
    // O .json por último: sem ele o backup não aparece na lista (backupFiles.ts).
    writeFileSync(join(DESTINO, `${nome}.json`), JSON.stringify(meta, null, 2))
    console.log(`Backup do principal: ${counts.conversations} conversas, última em ${counts.lastUpdate} → ${join(DESTINO, `${nome}.dump`)}`)
  } finally {
    await client.end()
  }
})
