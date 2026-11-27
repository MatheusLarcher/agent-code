// Confere a cópia para a nuvem: compara as linhas de cada tabela do último backup local
// (o .json que o app grava junto de cada .dump) com o banco "agent-code" na nuvem (Neon).
// Só leitura: não grava nada em nenhum dos dois lados.
//
// Uso (a string de conexão vem por variável de ambiente, nunca pela linha de comando):
//   read -rs AGENT_CODE_NUVEM_URL && export AGENT_CODE_NUVEM_URL
//   node scripts/banco/conferir-nuvem.mjs [pasta-dos-backups]
// A string do Neon aponta para o banco "neondb"; o script troca para "agent-code", o banco do app.
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'

const url = process.env.AGENT_CODE_NUVEM_URL
if (!url) {
  console.error('Defina AGENT_CODE_NUVEM_URL (veja o topo do arquivo).')
  process.exit(2)
}
const pasta = process.argv[2] ?? join(homedir(), 'Documents', 'agent-code', 'backups')
const jsons = readdirSync(pasta).filter((f) => f.endsWith('.json') && f.includes('_local_')).sort()
if (!jsons.length) {
  console.error(`Nenhum backup local (.json) em ${pasta}.`)
  process.exit(2)
}
const backup = JSON.parse(readFileSync(join(pasta, jsons.at(-1)), 'utf8'))

const alvo = new URL(url)
alvo.pathname = '/agent-code'
// sslmode da URL é ignorado quando "ssl" vem como objeto; o Neon exige TLS.
alvo.searchParams.delete('sslmode')
alvo.searchParams.delete('channel_binding')
const client = new pg.Client({ connectionString: alvo.toString(), ssl: { rejectUnauthorized: true } })
await client.connect()
try {
  const nomes = (await client.query(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY 1`
  )).rows.map((r) => r.name)
  const nuvem = {}
  for (const nome of nomes) {
    nuvem[nome] = Number((await client.query(`SELECT count(*)::bigint AS n FROM ${pg.escapeIdentifier(nome)}`)).rows[0].n)
  }
  const todas = [...new Set([...Object.keys(backup.tables), ...nomes])].sort()
  let diferencas = 0
  console.log(`Backup local: ${jsons.at(-1)} (${backup.createdAt})`)
  console.log('tabela'.padEnd(30), 'local'.padStart(8), 'nuvem'.padStart(8))
  for (const t of todas) {
    const l = backup.tables[t]
    const n = nuvem[t]
    const igual = l === n
    if (!igual) diferencas++
    console.log(t.padEnd(30), String(l ?? '—').padStart(8), String(n ?? '—').padStart(8), igual ? '' : '  ← diferente')
  }
  console.log(diferencas ? `\n${diferencas} tabela(s) diferente(s). Normal se você usou o app depois do backup.` : '\nTudo igual.')
} finally {
  await client.end()
}
