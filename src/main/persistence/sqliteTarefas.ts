import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { Tarefa, TarefaRodada } from '../../shared/tarefas'
import { msOf, rodadaFromRow, tarefaFromRow, ultimasPorTarefa } from './tarefaRows'
import type { TarefaClaim, TarefaEstadoPatch, TarefaFimRodada, TarefaRegistro } from './tarefaTypes'

/**
 * Migration 21 — as tarefas agendadas (`tarefas` + `tarefa_rodadas`) no SQLite.
 * Tabelas novas com `IF NOT EXISTS`: atravessam o guarda de `write()` sem custo.
 * No PostgreSQL as mesmas tabelas NÃO são migração numerada — ver postgresTarefas.ts.
 */
export const SQLITE_TAREFAS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS tarefas (
    id TEXT PRIMARY KEY,
    tipo TEXT NOT NULL CHECK(tipo IN ('lembrete', 'monitor')),
    titulo TEXT NOT NULL,
    mensagem TEXT,
    conv_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    agenda_json TEXT NOT NULL,
    estado TEXT NOT NULL CHECK(estado IN ('ativa', 'pausada', 'concluida', 'cancelada')),
    modelo TEXT,
    condicao TEXT,
    combinado TEXT,
    criada_por TEXT NOT NULL,
    criada_em TEXT NOT NULL,
    atualizada_em TEXT NOT NULL,
    proxima_ms INTEGER,
    ultima_ms INTEGER,
    ultimo_resultado TEXT,
    ultimo_valor TEXT,
    avisado_valor TEXT,
    falhas_seguidas INTEGER NOT NULL DEFAULT 0,
    bateu_nao_visto_em TEXT,
    lease_dono TEXT,
    lease_token TEXT,
    lease_ate INTEGER
  );
  CREATE INDEX IF NOT EXISTS tarefas_estado ON tarefas(estado, proxima_ms);
  CREATE INDEX IF NOT EXISTS tarefas_conv ON tarefas(conv_id);
  CREATE TABLE IF NOT EXISTS tarefa_rodadas (
    id TEXT PRIMARY KEY,
    tarefa_id TEXT NOT NULL,
    inicio TEXT NOT NULL,
    fim TEXT,
    resultado TEXT NOT NULL,
    valor TEXT,
    resumo TEXT,
    fonte TEXT,
    falha TEXT,
    instalacao TEXT
  );
  CREATE INDEX IF NOT EXISTS tarefa_rodadas_tarefa ON tarefa_rodadas(tarefa_id, inicio);
`

type Row = Record<string, SQLInputValue>

export function listSqliteTarefas(db: DatabaseSync): TarefaRegistro[] {
  const rows = db.prepare(`SELECT * FROM tarefas WHERE estado IN ('ativa', 'pausada') ORDER BY criada_em, id`).all() as Row[]
  return rows.map((row) => tarefaFromRow(row)).filter((t): t is TarefaRegistro => t !== null)
}

export function listSqliteTarefaRodadas(db: DatabaseSync, ids: string[], porTarefa: number): TarefaRodada[] {
  if (!ids.length || porTarefa <= 0) return []
  const marks = ids.map(() => '?').join(', ')
  const rows = db.prepare(`SELECT * FROM tarefa_rodadas WHERE tarefa_id IN (${marks}) ORDER BY inicio DESC, id DESC`).all(...ids) as Row[]
  return ultimasPorTarefa(rows.map((row) => rodadaFromRow(row)), porTarefa)
}

export function insertSqliteTarefa(db: DatabaseSync, t: Tarefa): void {
  db.prepare(
    `INSERT INTO tarefas (id, tipo, titulo, mensagem, conv_id, cwd, agenda_json, estado, modelo, condicao, combinado, criada_por,
       criada_em, atualizada_em, proxima_ms, ultima_ms, ultimo_resultado, ultimo_valor, avisado_valor, falhas_seguidas, bateu_nao_visto_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run(
    t.id, t.tipo, t.titulo, t.mensagem, t.convId, t.cwd, JSON.stringify(t.agenda), t.estado, t.modelo, t.condicao, t.combinado, t.criadaPor,
    t.criadaEm, t.atualizadaEm, msOf(t.proximaEm), msOf(t.ultimaEm), t.ultimoResultado, t.ultimoValor, t.avisadoValor, t.falhasSeguidas, t.bateuNaoVistoEm
  )
}

export function updateSqliteTarefaEstado(db: DatabaseSync, patch: TarefaEstadoPatch): boolean {
  const result = db
    .prepare(`UPDATE tarefas SET estado = ?, proxima_ms = ?, atualizada_em = ?, falhas_seguidas = CASE WHEN ? = 'ativa' THEN 0 ELSE falhas_seguidas END WHERE id = ?`)
    .run(patch.estado, msOf(patch.proximaEm), patch.atualizadaEm, patch.estado, patch.id)
  return Number(result.changes) > 0
}

export function marcarSqliteTarefaVista(db: DatabaseSync, id: string, atualizadaEm: string): void {
  db.prepare(`UPDATE tarefas SET bateu_nao_visto_em = NULL, atualizada_em = ? WHERE id = ? AND bateu_nao_visto_em IS NOT NULL`).run(atualizadaEm, id)
}

export function cancelSqliteTarefasDaConversa(db: DatabaseSync, convId: string, atualizadaEm: string): number {
  const result = db
    .prepare(`UPDATE tarefas SET estado = 'cancelada', proxima_ms = NULL, atualizada_em = ? WHERE conv_id = ? AND estado IN ('ativa', 'pausada')`)
    .run(atualizadaEm, convId)
  return Number(result.changes)
}

/**
 * A tarefa venceu para quem pede a trava? Só LEITURA: o SQLite é de um PC só,
 * então a trava dele mora na memória do repositório (como as travas de conversa
 * do SQLite) — e cada `write()` copia o arquivo inteiro, caro demais para
 * pegar/renovar trava a cada 20 s. As colunas `lease_*` ficam nulas aqui.
 */
export function sqliteTarefaVencida(db: DatabaseSync, c: TarefaClaim): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM tarefas WHERE id = ? AND estado = 'ativa' AND proxima_ms IS NOT NULL
         AND proxima_ms <= ? - (CASE WHEN criada_por = ? THEN 0 ELSE ? END)`
    )
    .get(c.id, c.agora, c.dono, c.cortesiaMs)
  return row !== undefined
}

export function finishSqliteTarefaRodada(db: DatabaseSync, fim: TarefaFimRodada): boolean {
  const c = fim.campos
  db.exec('BEGIN IMMEDIATE')
  try {
    const updated = db
      .prepare(
        `UPDATE tarefas SET proxima_ms = ?, ultima_ms = ?, ultimo_resultado = ?, ultimo_valor = ?, avisado_valor = ?, falhas_seguidas = ?,
           bateu_nao_visto_em = ?, estado = CASE WHEN ? = 1 AND estado = 'ativa' THEN 'concluida' ELSE estado END,
           atualizada_em = ?, lease_dono = NULL, lease_token = NULL, lease_ate = NULL
         WHERE id = ? AND (lease_token = ? OR ((lease_token IS NULL OR lease_ate < ?) AND (ultima_ms IS NULL OR ultima_ms < ?)))`
      )
      .run(
        msOf(c.proximaEm), msOf(c.ultimaEm), c.ultimoResultado, c.ultimoValor, c.avisadoValor, c.falhasSeguidas, c.bateuNaoVistoEm,
        c.concluir ? 1 : 0, c.atualizadaEm, fim.id, fim.token, fim.agora, fim.inicio
      )
    if (Number(updated.changes) === 0) {
      db.exec('ROLLBACK')
      return false
    }
    const insert = db.prepare(
      `INSERT INTO tarefa_rodadas (id, tarefa_id, inicio, fim, resultado, valor, resumo, fonte, falha, instalacao)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`
    )
    for (const r of fim.rodadas) insert.run(r.id, r.tarefaId, r.inicio, r.fim, r.resultado, r.valor, r.resumo, r.fonte, r.falha, r.instalacao)
    db.prepare(
      `DELETE FROM tarefa_rodadas WHERE tarefa_id = ? AND id NOT IN (
         SELECT id FROM tarefa_rodadas WHERE tarefa_id = ? ORDER BY inicio DESC, id DESC LIMIT ?)`
    ).run(fim.id, fim.id, Math.max(1, fim.guardar))
    db.exec('COMMIT')
    return true
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
