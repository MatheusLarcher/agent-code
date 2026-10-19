import { TarefaAgendaSchema, TAREFA_ESTADOS, TAREFA_RESULTADOS, TAREFA_TIPOS, type TarefaResultado, type TarefaRodada } from '../../shared/tarefas'
import type { TarefaRegistro } from './tarefaTypes'

/**
 * Linha do banco → registro, igual nas duas persistências (o PostgreSQL devolve
 * `bigint` como texto: `Number` cobre os dois). Linha torta (agenda ilegível,
 * tipo desconhecido) é pulada com aviso — uma tarefa estragada não derruba a lista.
 */

type Row = Record<string, unknown>
type Decode = (value: string) => string

const ms = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))
const iso = (value: unknown): string | null => {
  const n = ms(value)
  return n === null || !Number.isFinite(n) ? null : new Date(n).toISOString()
}
const isoText = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value))
const resultado = (value: unknown): TarefaResultado | null =>
  typeof value === 'string' && (TAREFA_RESULTADOS as readonly string[]).includes(value) ? (value as TarefaResultado) : null

export function tarefaFromRow(row: Row, decode: Decode = (v) => v): TarefaRegistro | null {
  const text = (value: unknown): string | null => (value === null || value === undefined ? null : decode(String(value)))
  let agendaRaw: unknown
  try {
    agendaRaw = JSON.parse(decode(String(row.agenda_json)))
  } catch {
    agendaRaw = null
  }
  const agenda = TarefaAgendaSchema.safeParse(agendaRaw)
  const tipo = String(row.tipo)
  const estado = String(row.estado)
  if (!agenda.success || !(TAREFA_TIPOS as readonly string[]).includes(tipo) || !(TAREFA_ESTADOS as readonly string[]).includes(estado)) {
    console.warn(`[tarefas] linha ilegível ignorada: ${String(row.id)}`)
    return null
  }
  return {
    id: String(row.id),
    tipo: tipo as TarefaRegistro['tipo'],
    titulo: text(row.titulo) ?? '',
    mensagem: text(row.mensagem),
    convId: String(row.conv_id),
    cwd: text(row.cwd) ?? '',
    agenda: agenda.data,
    estado: estado as TarefaRegistro['estado'],
    modelo: text(row.modelo),
    condicao: text(row.condicao),
    combinado: text(row.combinado),
    criadaPor: String(row.criada_por),
    criadaEm: isoText(row.criada_em),
    atualizadaEm: isoText(row.atualizada_em),
    proximaEm: iso(row.proxima_ms),
    ultimaEm: iso(row.ultima_ms),
    ultimoResultado: resultado(row.ultimo_resultado),
    ultimoValor: text(row.ultimo_valor),
    avisadoValor: text(row.avisado_valor),
    falhasSeguidas: Number(row.falhas_seguidas ?? 0),
    bateuNaoVistoEm: row.bateu_nao_visto_em === null || row.bateu_nao_visto_em === undefined ? null : isoText(row.bateu_nao_visto_em),
    leaseDono: row.lease_dono === null || row.lease_dono === undefined ? null : String(row.lease_dono),
    leaseToken: row.lease_token === null || row.lease_token === undefined ? null : String(row.lease_token),
    leaseAte: ms(row.lease_ate)
  }
}

export function rodadaFromRow(row: Row, decode: Decode = (v) => v): TarefaRodada {
  const text = (value: unknown): string | null => (value === null || value === undefined ? null : decode(String(value)))
  return {
    id: String(row.id),
    tarefaId: String(row.tarefa_id),
    inicio: isoText(row.inicio),
    fim: row.fim === null || row.fim === undefined ? null : isoText(row.fim),
    resultado: resultado(row.resultado) ?? 'falha',
    valor: text(row.valor),
    resumo: text(row.resumo),
    fonte: text(row.fonte),
    falha: text(row.falha),
    instalacao: row.instalacao === null || row.instalacao === undefined ? null : String(row.instalacao)
  }
}

/** ISO → ms para as colunas comparáveis (`null` fica `null`). */
export function msOf(value: string | null): number | null {
  if (value === null) return null
  const n = Date.parse(value)
  return Number.isFinite(n) ? n : null
}

/** As N mais novas de cada tarefa, já ordenadas (mais nova primeiro). */
export function ultimasPorTarefa(rodadas: TarefaRodada[], porTarefa: number): TarefaRodada[] {
  const contagem = new Map<string, number>()
  return rodadas.filter((r) => {
    const n = (contagem.get(r.tarefaId) ?? 0) + 1
    contagem.set(r.tarefaId, n)
    return n <= porTarefa
  })
}
