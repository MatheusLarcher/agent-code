/**
 * Importar conversas do Agent Code original para a Homol (pedido do Erick, 27/11).
 *
 * SÓ LEITURA na origem: copia a pasta do Postgres do app original para uma pasta temporária,
 * sobe um Postgres separado em cima da CÓPIA (só 127.0.0.1, sem senha, porta livre), lê as
 * conversas e desliga. O app original não é tocado e pode continuar aberto.
 *
 * Importar = gravar o documento da conversa pelo mesmo caminho de toda conversa
 * (`upsertConversation`), ao lado das que já existem; conversa que já está aqui é pulada (nunca
 * sobrescreve). O histórico que o Claude usa para retomar fica em `~\.claude`, compartilhado
 * pelos dois apps no mesmo computador: a importada continua de onde parou.
 */
import { spawn } from 'node:child_process'
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import pg from 'pg'
import type { PersistenceRepository } from '../persistence/types'

/**
 * Roda o pg_ctl SEM herdar a saída: com pipe, no Windows, o postgres filho herda o handle e o
 * comando nunca volta (mesmo cuidado de scripts/analise-conversas/banco.mjs). Com prazo.
 */
function run(file: string, args: string[], timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(file, args, { stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => {
      p.kill()
      reject(new Error('O banco temporário demorou demais para responder.'))
    }, timeoutMs)
    p.once('error', (e) => (clearTimeout(timer), reject(e)))
    p.once('exit', (code) => (clearTimeout(timer), code === 0 ? resolve() : reject(new Error(`pg_ctl saiu com código ${code}`))))
  })
}
const EXE = process.platform === 'win32' ? '.exe' : ''
/** As conversas lidas ficam guardadas por este tempo para o "Importar" não copiar o banco de novo. */
const VALIDADE_MS = 15 * 60_000

export interface ConversaDaOrigem {
  id: string
  titulo: string
  pasta: string | null
  atualizadaEm: string | null
  pedidos: number
  /** Já está na Homol (não será importada de novo). */
  jaExiste: boolean
}

export type ResultadoListar = { ok: true; conversas: ConversaDaOrigem[] } | { ok: false; error: string }
export type ResultadoImportar = { ok: true; importadas: number; puladas: number; falhas: string[] } | { ok: false; error: string }

export interface DepsImportador {
  /** Pasta do Postgres do app de origem (o Agent Code original). */
  origemPgdata(): string
  /** Binários do Postgres embutido deste app (pg_ctl). */
  binDir(): string
  tmpDir(): string
  repositorio(): Pick<PersistenceRepository, 'loadConversations' | 'upsertConversation'>
  /** Falso fora da Homol: no app original a "origem" seria ele mesmo. */
  disponivel(): boolean
  /** Registra cada conversa trazida (a importação automática usa para saber se ela foi
   *  mexida aqui depois): id, quando mudou na origem, revisão gravada aqui. */
  aoImportar?(id: string, origemEm: string | null, revisao: number): Promise<void>
  now?(): number
}

export interface LinhaOrigem {
  id: string
  payload: Record<string, unknown>
  updated_at: Date | string | null
}

/** O que a leitura da origem devolve: as conversas e, por conversa, as memórias que entraram
 *  nos turnos dela (`context_turn.memories_json`, caminhos relativos). */
export interface LeituraOrigem {
  linhas: LinhaOrigem[]
  memorias: Map<string, Set<string>>
}

function portaLivre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const porta = (s.address() as { port: number }).port
      s.close(() => resolve(porta))
    })
  })
}

/** Copia a pasta do Postgres: `global` primeiro e `pg_wal` por último (a recuperação parte do
 *  checkpoint mais antigo e o WAL copiado depois cobre o que mudou durante a cópia). */
async function copiarBanco(origem: string, copia: string): Promise<void> {
  if (!existsSync(join(origem, 'PG_VERSION'))) throw new Error('O Agent Code original não foi encontrado neste computador.')
  await mkdir(copia, { recursive: true })
  await cp(join(origem, 'global'), join(copia, 'global'), { recursive: true })
  for (const nome of await readdir(origem)) {
    if (['global', 'pg_wal', 'postmaster.pid', 'postmaster.opts'].includes(nome)) continue
    await cp(join(origem, nome), join(copia, nome), { recursive: true })
  }
  await cp(join(origem, 'pg_wal'), join(copia, 'pg_wal'), { recursive: true })
  // Só a cópia, só local: sem senha para o usuário do app.
  await writeFile(join(copia, 'pg_hba.conf'), 'host all all 127.0.0.1/32 trust\n')
}

export function pedidosDe(payload: Record<string, unknown>): number {
  const msgs = Array.isArray(payload.messages) ? (payload.messages as Array<{ kind?: unknown }>) : []
  return msgs.filter((m) => m?.kind === 'user').length
}

export class ImportadorPrincipal {
  private lidas: { em: number; linhas: LinhaOrigem[] } | null = null
  private ocupado = false

  constructor(private readonly deps: DepsImportador) {}

  /** Lê as conversas do app original (numa cópia) e diz quais já estão aqui. */
  async listar(): Promise<ResultadoListar> {
    if (!this.deps.disponivel()) return { ok: false, error: 'Importar do Agent Code só existe na Agent Code Homol.' }
    if (this.ocupado) return { ok: false, error: 'Já estou lendo as conversas. Espere terminar.' }
    this.ocupado = true
    try {
      const { linhas } = await this.lerOrigem()
      this.lidas = { em: this.deps.now?.() ?? Date.now(), linhas }
      const existentes = await this.existentes(linhas.map((l) => l.id))
      return { ok: true, conversas: linhas.map((l) => this.resumo(l, existentes)) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      this.ocupado = false
    }
  }

  /** Grava as escolhidas ao lado das que já existem. Nunca sobrescreve. */
  async importar(ids: readonly string[]): Promise<ResultadoImportar> {
    if (!this.deps.disponivel()) return { ok: false, error: 'Importar do Agent Code só existe na Agent Code Homol.' }
    const agora = this.deps.now?.() ?? Date.now()
    if (!this.lidas || agora - this.lidas.em > VALIDADE_MS) return { ok: false, error: 'A lista ficou antiga. Clique em "Ver conversas do Agent Code" de novo.' }
    const pedidas = new Set(ids.filter((id) => typeof id === 'string'))
    const escolhidas = this.lidas.linhas.filter((l) => pedidas.has(l.id))
    const existentes = await this.existentes(escolhidas.map((l) => l.id))
    let importadas = 0
    let puladas = 0
    const falhas: string[] = []
    const repo = this.deps.repositorio()
    for (const l of escolhidas) {
      if (existentes.has(l.id)) {
        puladas++
        continue
      }
      try {
        const gravada = await repo.upsertConversation({ id: l.id, payload: l.payload as never })
        importadas++
        await this.deps.aoImportar?.(l.id, l.updated_at ? new Date(l.updated_at).toISOString() : null, gravada?.revision ?? 1).catch(() => undefined)
      } catch (e) {
        falhas.push(`${String(l.payload.title ?? l.id)}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return { ok: true, importadas, puladas, falhas }
  }

  private resumo(l: LinhaOrigem, existentes: ReadonlySet<string>): ConversaDaOrigem {
    const quando = l.updated_at ? new Date(l.updated_at).toISOString() : null
    return {
      id: l.id,
      titulo: typeof l.payload.title === 'string' && l.payload.title.trim() ? l.payload.title : 'Conversa sem título',
      pasta: typeof l.payload.cwd === 'string' ? l.payload.cwd : null,
      atualizadaEm: quando,
      pedidos: pedidosDe(l.payload),
      jaExiste: existentes.has(l.id)
    }
  }

  private async existentes(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set()
    const ja = await this.deps.repositorio().loadConversations({ ids, includeDeleted: true })
    return new Set(ja.map((c) => c.id))
  }

  /** Lê a origem numa cópia (conversas + memórias usadas por conversa). Usado também pela
   *  importação automática. */
  async lerOrigem(): Promise<LeituraOrigem> {
    const tmp = join(this.deps.tmpDir(), `importar-principal-${process.pid}-${Date.now()}`)
    const copia = join(tmp, 'pgdata')
    const pgCtl = join(this.deps.binDir(), `pg_ctl${EXE}`)
    let subiu = false
    try {
      await copiarBanco(this.deps.origemPgdata(), copia)
      const porta = await portaLivre()
      await run(pgCtl, ['-D', copia, '-o', `-p ${porta} -c listen_addresses=127.0.0.1`, '-l', join(tmp, 'pg.log'), '-w', '-t', '90', 'start'])
      subiu = true
      const client = new pg.Client({ host: '127.0.0.1', port: porta, user: 'agentcode', database: 'agent-code' })
      await client.connect()
      try {
        await client.query('SET default_transaction_read_only = on')
        const r = await client.query<LinhaOrigem>(
          'SELECT conversation_id AS id, payload, updated_at FROM conversations WHERE deleted_at IS NULL ORDER BY updated_at DESC'
        )
        const memorias = new Map<string, Set<string>>()
        try {
          const m = await client.query<{ conv_id: string; memories_json: unknown }>(
            'SELECT conv_id, memories_json FROM context_turn WHERE jsonb_array_length(memories_json) > 0'
          )
          for (const row of m.rows) {
            const set = memorias.get(row.conv_id) ?? new Set<string>()
            for (const p of Array.isArray(row.memories_json) ? row.memories_json : []) if (typeof p === 'string') set.add(p)
            memorias.set(row.conv_id, set)
          }
        } catch {
          /* versão antiga sem context_turn: só as conversas */
        }
        return { linhas: r.rows.filter((l) => l.payload && typeof l.payload === 'object'), memorias }
      } finally {
        await client.end().catch(() => undefined)
      }
    } finally {
      if (subiu) await run(pgCtl, ['-D', copia, '-m', 'fast', '-w', 'stop']).catch(() => undefined)
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
