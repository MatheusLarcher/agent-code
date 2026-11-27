// Leitura SÓ LEITURA do Postgres embutido do app, compartilhada por analisar.mjs e contexto.mjs.
//
// Copia a pasta do banco para uma pasta temporária, sobe um Postgres separado em
// cima da CÓPIA (outra porta, sem senha, só 127.0.0.1), roda as consultas, desliga
// e apaga a cópia. O banco do app não é tocado e o app não precisa fechar.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const LOCAL = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
const REPO = join(import.meta.dirname, '..', '..')
export const INSTANCIAS = {
  principal: { pgdata: join(LOCAL, 'agent-code', 'pgdata') },
  // Desde 27/11 o lado "teste" é a Agent Code Homol (instalada, com as correções), não mais a
  // cópia de desenvolvimento (agent-code-dev).
  teste: { pgdata: join(LOCAL, 'agent-code-homol', 'pgdata') }
}
const EXE = process.platform === 'win32' ? '.exe' : ''

export function instancia(arg) {
  const nome = arg ?? process.env.AC_INSTANCIA ?? 'principal'
  if (!INSTANCIAS[nome]) throw new Error(`Instância desconhecida "${nome}". Use: ${Object.keys(INSTANCIAS).join(' ou ')}`)
  return nome
}

export function pgBin() {
  const cands = [
    process.env.AC_PG_BIN,
    join(LOCAL, 'Programs', 'agent-code-desktop', 'resources', 'postgres', 'bin'),
    join(REPO, 'out', 'postgres', 'bin')
  ].filter(Boolean)
  const bin = cands.find((d) => existsSync(join(d, `pg_ctl${EXE}`)))
  if (!bin) throw new Error(`pg_ctl não encontrado. Defina AC_PG_BIN. Procurado em:\n${cands.join('\n')}`)
  return bin
}

function copiarBanco(pgdata, copia) {
  if (!existsSync(join(pgdata, 'PG_VERSION'))) throw new Error(`Banco não encontrado em ${pgdata}`)
  mkdirSync(copia, { recursive: true })
  // pg_control primeiro e pg_wal por último: a recuperação parte do checkpoint
  // mais antigo e o WAL copiado depois cobre o que mudou durante a cópia.
  cpSync(join(pgdata, 'global'), join(copia, 'global'), { recursive: true })
  for (const nome of readdirSync(pgdata)) {
    if (['global', 'pg_wal', 'postmaster.pid', 'postmaster.opts'].includes(nome)) continue
    cpSync(join(pgdata, nome), join(copia, nome), { recursive: true })
  }
  cpSync(join(pgdata, 'pg_wal'), join(copia, 'pg_wal'), { recursive: true })
  writeFileSync(join(copia, 'pg_hba.conf'), 'host all all 127.0.0.1/32 trust\n') // só a cópia
}

/** Roda `consultas(q)` sobre uma cópia do banco; `q(sql)` devolve as linhas como JSON. Sempre apaga a cópia. */
export async function lerBanco(pgdata, port, consultas) {
  const tmp = join(tmpdir(), `analise-conversas-${process.pid}`)
  const copia = join(tmp, 'pgdata')
  // stdio 'ignore': com pipe, o postgres filho herda o handle e o execFileSync nunca volta (Windows).
  const pgCtl = (bin, args) => execFileSync(join(bin, `pg_ctl${EXE}`), ['-D', copia, ...args], { stdio: 'ignore' })
  let bin
  try {
    bin = pgBin()
    copiarBanco(pgdata, copia)
    pgCtl(bin, ['-o', `-p ${port} -c listen_addresses=127.0.0.1`, '-l', join(tmp, 'pg.log'), '-w', '-t', '90', 'start'])
    // psql do próprio Postgres do app (sem depender de node_modules); cada consulta volta como JSON.
    const q = (sql) => JSON.parse(execFileSync(join(bin, `psql${EXE}`),
      ['-h', '127.0.0.1', '-p', String(port), '-U', 'agentcode', '-d', 'agent-code', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
        '-c', 'SET default_transaction_read_only = on', '-c', `SELECT coalesce(json_agg(x), '[]') FROM (${sql}) x`],
      { maxBuffer: 1 << 30, env: { ...process.env, PGCLIENTENCODING: 'UTF8' } }).toString('utf8'))
    return await consultas(q)
  } finally {
    if (bin) try { pgCtl(bin, ['-m', 'fast', '-w', 'stop']) } catch { /* não subiu ou já caiu */ }
    rmSync(tmp, { recursive: true, force: true })
  }
}
