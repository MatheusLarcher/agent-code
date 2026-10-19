import {
  TAREFA_FALHAS_AVISO,
  dataHoraTexto,
  proximaDiaria,
  proximaExecucao,
  type Tarefa,
  type TarefaAgenda,
  type TarefaNova,
  type TarefaResultado,
  type Validado
} from '../../shared/tarefas'
import type { TarefaCamposRodada } from '../persistence/tarefaTypes'

/**
 * As regras puras das tarefas: a próxima execução ao criar/retomar e o que uma
 * rodada muda e avisa. Sem relógio nem banco — o agendador passa o `agora`.
 */

/** Lembrete que dispara com mais atraso que isso sai marcado "(atrasado)". */
export const ATRASO_AVISO_MS = 2 * 60_000
/** Falha do monitor: nova tentativa curta (ou o intervalo, se menor). */
export const RETENTATIVA_MS = 3 * 60_000
/** Teto de uma rodada do monitor (o timeout é o menor entre isto e o intervalo). */
export const RODADA_TETO_MS = 15 * 60_000
/** Uma data "uma vez" mais velha que isto, na criação, é recusada. */
const PASSADO_TOLERADO_MS = 60_000

export interface ResultadoRodada {
  resultado: TarefaResultado
  valor?: string | null
  resumo?: string | null
  fonte?: string | null
  falha?: string | null
}

export type AvisoTipo = 'agora' | 'lembrete' | 'bateu' | 'falhas' | 'precisa'

/** O que vai ao Windows (e, no prompt 3, ao celular). */
export interface AvisoTarefa {
  tipo: AvisoTipo
  convId: string
  tarefaId: string | null
  titulo: string
  texto: string
}

/** A mensagem compacta que entra na conversa quando o monitor bate. */
export interface MensagemTarefa {
  convId: string
  tarefaId: string
  titulo: string
  hora: string
  valor: string | null
  resumo: string | null
  fonte: string | null
}

export interface Decisao {
  campos: TarefaCamposRodada
  avisos: AvisoTarefa[]
  mensagem: MensagemTarefa | null
}

export function intervaloMs(agenda: TarefaAgenda): number {
  if (agenda.tipo === 'intervalo') return agenda.intervaloMin * 60_000
  if (agenda.tipo === 'diario') return 24 * 3_600_000
  return Number.POSITIVE_INFINITY
}

export function timeoutDaRodada(t: Pick<Tarefa, 'tipo' | 'agenda'>): number {
  return t.tipo === 'monitor' ? Math.min(intervaloMs(t.agenda), RODADA_TETO_MS) : 30_000
}

/**
 * A primeira execução: "uma vez" na data marcada; o monitor de intervalo checa
 * já (o usuário quer saber como está agora); o lembrete de intervalo espera o
 * primeiro intervalo; o diário, o próximo HH:MM.
 */
export function primeiraExecucao(tipo: Tarefa['tipo'], agenda: TarefaAgenda, agora: number): number {
  if (agenda.tipo === 'uma-vez') return Date.parse(agenda.quando)
  if (agenda.tipo === 'diario') return proximaDiaria(agenda.hora, agora)
  return tipo === 'monitor' ? agora : agora + agenda.intervaloMin * 60_000
}

/** A tarefa nova (ativa) a partir do pedido já validado. */
export function novaTarefa(nova: TarefaNova, ctx: { id: string; agora: number; instalacao: string }): Validado<Tarefa> {
  if (nova.agenda.tipo === 'uma-vez' && Date.parse(nova.agenda.quando) < ctx.agora - PASSADO_TOLERADO_MS) {
    return { ok: false, erro: `agenda.quando: ${nova.agenda.quando} já passou` }
  }
  const agoraIso = new Date(ctx.agora).toISOString()
  return {
    ok: true,
    valor: {
      id: ctx.id,
      tipo: nova.tipo,
      titulo: nova.titulo,
      mensagem: nova.mensagem ?? null,
      convId: nova.convId,
      cwd: nova.cwd,
      agenda: nova.agenda,
      estado: 'ativa',
      modelo: nova.tipo === 'monitor' ? (nova.modelo ?? null) : null,
      condicao: nova.tipo === 'monitor' ? (nova.condicao ?? null) : null,
      combinado: nova.tipo === 'monitor' ? (nova.combinado ?? null) : null,
      criadaPor: ctx.instalacao,
      criadaEm: agoraIso,
      atualizadaEm: agoraIso,
      proximaEm: new Date(primeiraExecucao(nova.tipo, nova.agenda, ctx.agora)).toISOString(),
      ultimaEm: null,
      ultimoResultado: null,
      ultimoValor: null,
      avisadoValor: null,
      falhasSeguidas: 0,
      bateuNaoVistoEm: null
    }
  }
}

/** Retomar: a data "uma vez" (atrasada roda uma vez), o monitor checa já, o resto segue a agenda. */
export function proximaAoRetomar(t: Pick<Tarefa, 'tipo' | 'agenda'>, agora: number): number {
  return primeiraExecucao(t.tipo, t.agenda, agora)
}

const iso = (ms: number): string => new Date(ms).toISOString()

/**
 * O que a rodada muda na tarefa e o que avisa. Atrasada roda UMA vez: a próxima
 * sai de `agora` (o fim desta rodada), não da hora perdida.
 */
export function decidirAposRodada(t: Tarefa, r: ResultadoRodada, ctx: { agora: number; atrasadaMs: number }): Decisao {
  const { agora } = ctx
  const base = {
    ultimaEm: iso(agora),
    ultimoResultado: r.resultado,
    atualizadaEm: iso(agora)
  }
  if (t.tipo === 'lembrete') {
    const proxima = proximaExecucao(t.agenda, agora, true)
    const atrasado = ctx.atrasadaMs > ATRASO_AVISO_MS
    return {
      campos: {
        ...base,
        proximaEm: proxima === null ? null : iso(proxima),
        ultimoValor: null,
        avisadoValor: null,
        falhasSeguidas: 0,
        bateuNaoVistoEm: t.bateuNaoVistoEm,
        concluir: t.agenda.tipo === 'uma-vez'
      },
      avisos: [{ tipo: 'lembrete', convId: t.convId, tarefaId: t.id, titulo: atrasado ? `${t.titulo} (atrasado)` : t.titulo, texto: t.mensagem ?? t.titulo }],
      mensagem: null
    }
  }

  const normal = proximaExecucao(t.agenda, agora, true) ?? agora + intervaloMs(t.agenda)
  const avisos: AvisoTarefa[] = []
  let mensagem: MensagemTarefa | null = null
  let falhas = 0
  let proxima = normal
  let avisadoValor = t.avisadoValor
  let bateuNaoVistoEm = t.bateuNaoVistoEm
  const valor = r.valor?.trim() || null

  if (r.resultado === 'bateu') {
    const chave = valor ?? r.resumo?.trim() ?? ''
    if (chave !== (t.avisadoValor ?? null)) {
      avisadoValor = chave
      bateuNaoVistoEm = iso(agora)
      const texto = [valor, r.resumo?.trim()].filter(Boolean).join(' — ') || t.condicao || 'A condição bateu.'
      avisos.push({ tipo: 'bateu', convId: t.convId, tarefaId: t.id, titulo: `${t.titulo} · bateu`, texto })
      mensagem = { convId: t.convId, tarefaId: t.id, titulo: t.titulo, hora: dataHoraTexto(agora, agora), valor, resumo: r.resumo?.trim() || null, fonte: r.fonte?.trim() || null }
    }
  } else if (r.resultado === 'nao-bateu') {
    // Saiu da condição: a próxima vez que bater é um aviso novo, mesmo com o mesmo valor.
    avisadoValor = null
  } else if (r.resultado === 'falha') {
    falhas = t.falhasSeguidas + 1
    if (falhas < TAREFA_FALHAS_AVISO) proxima = agora + Math.min(intervaloMs(t.agenda), RETENTATIVA_MS)
    if (falhas === TAREFA_FALHAS_AVISO) {
      avisos.push({ tipo: 'falhas', convId: t.convId, tarefaId: t.id, titulo: `${t.titulo} · falhou ${falhas} vezes`, texto: r.falha?.trim() || 'A checagem não conseguiu terminar.' })
    }
  } else if (r.resultado === 'precisa-de-voce' && t.ultimoResultado !== 'precisa-de-voce') {
    avisos.push({ tipo: 'precisa', convId: t.convId, tarefaId: t.id, titulo: `${t.titulo} · precisa de você`, texto: r.resumo?.trim() || r.falha?.trim() || 'A checagem parou num passo que depende de você.' })
  }

  return {
    campos: {
      ...base,
      proximaEm: iso(proxima),
      ultimoValor: r.resultado === 'falha' ? t.ultimoValor : (valor ?? t.ultimoValor),
      avisadoValor,
      falhasSeguidas: falhas,
      bateuNaoVistoEm,
      concluir: false
    },
    avisos,
    mensagem
  }
}
