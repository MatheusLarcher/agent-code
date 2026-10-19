/**
 * Tarefas agendadas do Agent Code: o LEMBRETE (dispara no horário, sem modelo) e
 * o MONITOR (uma rodada do agente na frequência pedida, que só avisa quando a
 * condição bate). Tipos e validação compartilhados pelo main (dono das tarefas),
 * pela tela do PC e pelo celular.
 *
 * A tarefa pertence à conversa onde foi pedida (`convId`); horários são no fuso
 * America/Sao_Paulo; o agendador é do app (não o CronCreate do SDK, preso à sessão).
 */
import { z } from 'zod'

export const TAREFA_FUSO = 'America/Sao_Paulo'

export const TAREFA_TIPOS = ['lembrete', 'monitor'] as const
export type TarefaTipo = (typeof TAREFA_TIPOS)[number]

export const TAREFA_ESTADOS = ['ativa', 'pausada', 'concluida', 'cancelada'] as const
export type TarefaEstado = (typeof TAREFA_ESTADOS)[number]

/** Uma vez (`quando`, ISO), a cada N minutos ou todo dia às HH:MM (fuso de São Paulo). */
export type TarefaAgenda =
  | { tipo: 'uma-vez'; quando: string }
  | { tipo: 'intervalo'; intervaloMin: number }
  | { tipo: 'diario'; hora: string }

/**
 * - `bateu` / `nao-bateu`: a rodada do monitor chamou `aviso_resultado`;
 * - `falha`: erro, prazo estourado, cota esgotada ou rodada sem `aviso_resultado`;
 * - `pulada`: a anterior ainda rodava (sem sobreposição);
 * - `precisa-de-voce`: a rodada parou porque depende do usuário;
 * - `disparado`: o lembrete avisou no horário.
 */
export const TAREFA_RESULTADOS = ['bateu', 'nao-bateu', 'falha', 'pulada', 'precisa-de-voce', 'disparado'] as const
export type TarefaResultado = (typeof TAREFA_RESULTADOS)[number]

export interface TarefaRodada {
  id: string
  tarefaId: string
  inicio: string
  fim: string | null
  resultado: TarefaResultado
  valor: string | null
  resumo: string | null
  fonte: string | null
  falha: string | null
  /** A instalação (PC) que rodou. */
  instalacao: string | null
}

export interface Tarefa {
  id: string
  tipo: TarefaTipo
  titulo: string
  /** Lembrete: a frase do aviso. Monitor: o que dizer quando bater (opcional). */
  mensagem: string | null
  convId: string
  cwd: string
  agenda: TarefaAgenda
  estado: TarefaEstado
  /** Monitor: o modelo das rodadas (o agente escolhe; o usuário pode fixar). */
  modelo: string | null
  /** Monitor: o que precisa acontecer para avisar. */
  condicao: string | null
  /** Monitor: o que a rodada pode fazer, combinado com o usuário na criação. */
  combinado: string | null
  /** A instalação que criou: tem a prioridade na trava entre PCs. */
  criadaPor: string
  criadaEm: string
  atualizadaEm: string
  /** Próxima execução (ISO); `null` = nenhuma (concluída, cancelada). */
  proximaEm: string | null
  ultimaEm: string | null
  ultimoResultado: TarefaResultado | null
  ultimoValor: string | null
  /** O valor do último aviso de "bateu": o mesmo valor não avisa de novo. */
  avisadoValor: string | null
  falhasSeguidas: number
  /** Bateu e o usuário ainda não abriu a bolinha (selo verde). */
  bateuNaoVistoEm: string | null
}

/** O que a tela e o celular recebem: a tarefa + o estado ao vivo do agendador. */
export interface TarefaVista extends Tarefa {
  rodando: boolean
  /** As últimas rodadas, a mais recente primeiro (no máximo TAREFA_RODADAS_VISTAS). */
  rodadas: TarefaRodada[]
}

export const TAREFA_RODADAS_VISTAS = 10
/** Rodadas guardadas por tarefa no banco (o resto é podado). */
export const TAREFA_RODADAS_GUARDADAS = 30
/** Teto do intervalo: 31 dias. */
export const TAREFA_INTERVALO_MAX_MIN = 31 * 24 * 60
/** Falhas seguidas do monitor que viram UM aviso. */
export const TAREFA_FALHAS_AVISO = 3

/** O estado da bolinha da conversa (mockup aprovado). */
export type TarefaBolinha = 'esperando' | 'checando' | 'bateu' | 'lembrete' | 'pausado'

export interface TarefaResumoConversa {
  convId: string
  /** Tarefas ativas + pausadas. */
  total: number
  estado: TarefaBolinha
  rodando: boolean
  bateuNaoVisto: boolean
}

/** Só ativas e pausadas aparecem (concluída/cancelada saem da bolinha). */
export function tarefaVisivel(t: Pick<Tarefa, 'estado'>): boolean {
  return t.estado === 'ativa' || t.estado === 'pausada'
}

/** Resumo de uma conversa para a bolinha e o selo; `null` = nenhuma tarefa visível. */
export function resumoDaConversa(convId: string, tarefas: readonly TarefaVista[]): TarefaResumoConversa | null {
  const delas = tarefas.filter((t) => t.convId === convId && tarefaVisivel(t))
  if (!delas.length) return null
  const rodando = delas.some((t) => t.rodando)
  const bateuNaoVisto = delas.some((t) => !!t.bateuNaoVistoEm)
  const ativas = delas.filter((t) => t.estado === 'ativa')
  const estado: TarefaBolinha = bateuNaoVisto
    ? 'bateu'
    : rodando
      ? 'checando'
      : !ativas.length
        ? 'pausado'
        : ativas.every((t) => t.tipo === 'lembrete')
          ? 'lembrete'
          : 'esperando'
  return { convId, total: delas.length, estado, rodando, bateuNaoVisto }
}

/** convId → resumo, para o selo da lista de conversas (só as conversas com tarefa). */
export function resumosPorConversa(tarefas: readonly TarefaVista[]): Map<string, TarefaResumoConversa> {
  const mapa = new Map<string, TarefaResumoConversa>()
  for (const id of new Set(tarefas.map((t) => t.convId))) {
    const r = resumoDaConversa(id, tarefas)
    if (r) mapa.set(id, r)
  }
  return mapa
}

/** "a cada 10 min", "1x por dia às 09:00", "uma vez em 20/10 09:00". */
export function frequenciaTexto(agenda: TarefaAgenda): string {
  if (agenda.tipo === 'intervalo') {
    const m = agenda.intervaloMin
    if (m % 1440 === 0) return m === 1440 ? 'a cada 1 dia' : `a cada ${m / 1440} dias`
    if (m % 60 === 0) return m === 60 ? 'a cada 1 h' : `a cada ${m / 60} h`
    return `a cada ${m} min`
  }
  if (agenda.tipo === 'diario') return `1x por dia às ${agenda.hora}`
  return `uma vez em ${dataHoraTexto(Date.parse(agenda.quando))}`
}

// --- Fuso de São Paulo, sem biblioteca: Intl dá a hora de parede do instante.

interface Partes {
  y: number
  m: number
  d: number
  h: number
  mi: number
}

let formatador: Intl.DateTimeFormat | null = null
function partesSP(ms: number): Partes {
  formatador ??= new Intl.DateTimeFormat('en-US', {
    timeZone: TAREFA_FUSO,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  })
  const p: Record<string, string> = {}
  for (const part of formatador.formatToParts(new Date(ms))) p[part.type] = part.value
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute) }
}

/** Diferença entre a hora de parede de São Paulo e o UTC naquele instante (ms). */
function deslocamentoSP(ms: number): number {
  const p = partesSP(ms)
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(ms / 60_000) * 60_000
}

/** "HH:MM" de hoje, ou "dd/mm HH:MM" — no fuso de São Paulo. */
export function dataHoraTexto(ms: number, agora = Date.now()): string {
  const p = partesSP(ms)
  const hoje = partesSP(agora)
  const hora = `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`
  if (p.y === hoje.y && p.m === hoje.m && p.d === hoje.d) return hora
  return `${String(p.d).padStart(2, '0')}/${String(p.m).padStart(2, '0')} ${hora}`
}

/** O próximo "HH:MM" de São Paulo estritamente depois de `depoisDe`. */
export function proximaDiaria(hora: string, depoisDe: number): number {
  const [hh, mm] = hora.split(':').map(Number)
  const hoje = partesSP(depoisDe)
  for (let dia = 0; dia < 3; dia++) {
    const parede = Date.UTC(hoje.y, hoje.m - 1, hoje.d + dia, hh, mm)
    const instante = parede - deslocamentoSP(parede)
    if (instante > depoisDe) return instante
  }
  return depoisDe + 24 * 3_600_000
}

/**
 * A próxima execução DEPOIS de uma rodada (ou da criação) em `base`. Uma vez:
 * a data marcada, só se ainda não rodou (`jaRodou`); intervalo: base + N min;
 * diário: o próximo HH:MM. Atrasada (PC dormiu, app fechado) continua no passado
 * e roda UMA vez: a seguinte é calculada a partir dessa rodada, não acumula.
 */
export function proximaExecucao(agenda: TarefaAgenda, base: number, jaRodou: boolean): number | null {
  if (agenda.tipo === 'uma-vez') return jaRodou ? null : Date.parse(agenda.quando)
  if (agenda.tipo === 'intervalo') return base + agenda.intervaloMin * 60_000
  return proximaDiaria(agenda.hora, base)
}

// --- Validação na fronteira (MCP do agente, IPC da tela, rota do celular).

const dataIso = z
  .string()
  .trim()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'data/hora inválida (use ISO 8601, ex. 2026-10-20T09:00:00-03:00)')

export const TarefaAgendaSchema = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('uma-vez'), quando: dataIso }),
  z.object({ tipo: z.literal('intervalo'), intervaloMin: z.number().int().min(1).max(TAREFA_INTERVALO_MAX_MIN) }),
  z.object({ tipo: z.literal('diario'), hora: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'hora no formato HH:MM') })
])

export const TarefaNovaSchema = z
  .object({
    tipo: z.enum(TAREFA_TIPOS),
    titulo: z.string().trim().min(1).max(160),
    mensagem: z.string().trim().max(500).optional(),
    convId: z.string().trim().min(1).max(200),
    cwd: z.string().max(2000),
    agenda: TarefaAgendaSchema,
    modelo: z.string().trim().min(1).max(100).optional(),
    condicao: z.string().trim().min(1).max(2000).optional(),
    combinado: z.string().trim().max(2000).optional()
  })
  .superRefine((t, ctx) => {
    if (t.tipo === 'monitor' && !t.condicao) ctx.addIssue({ code: 'custom', path: ['condicao'], message: 'o monitor precisa da condição' })
    if (t.tipo === 'monitor' && t.agenda.tipo === 'uma-vez') {
      ctx.addIssue({ code: 'custom', path: ['agenda'], message: 'o monitor é recorrente: use intervalo ou diário' })
    }
  })

export type TarefaNova = z.infer<typeof TarefaNovaSchema>

export type Validado<T> = { ok: true; valor: T } | { ok: false; erro: string }

function primeiroErro(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'inválido'
  const onde = issue.path.length ? `${issue.path.join('.')}: ` : ''
  return `${onde}${issue.message}`
}

export function validarTarefaNova(raw: unknown): Validado<TarefaNova> {
  const r = TarefaNovaSchema.safeParse(raw)
  return r.success ? { ok: true, valor: r.data } : { ok: false, erro: primeiroErro(r.error) }
}

/** Ações da bolinha (tela do PC e celular). */
export const TAREFA_ACOES = ['pausar', 'retomar', 'cancelar', 'visto'] as const
export type TarefaAcao = (typeof TAREFA_ACOES)[number]

export const TarefaAcaoSchema = z.object({ id: z.string().trim().min(1).max(200), acao: z.enum(TAREFA_ACOES) })
export type TarefaAcaoPedido = z.infer<typeof TarefaAcaoSchema>

export function validarTarefaAcao(raw: unknown): Validado<TarefaAcaoPedido> {
  const r = TarefaAcaoSchema.safeParse(raw)
  return r.success ? { ok: true, valor: r.data } : { ok: false, erro: primeiroErro(r.error) }
}
