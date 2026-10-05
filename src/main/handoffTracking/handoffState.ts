/**
 * O estado EM MEMÓRIA de cada conversa acompanhada (handoffTracker.ts): turno
 * rodando, perguntas abertas, a fatia de tempo ativo em curso e os textos vistos
 * no agent:send. Muda na hora do evento; o banco só recebe o que já foi decidido.
 * Nada disso sobrevive ao processo — e é de propósito: app fechado não conta tempo.
 */

/** Um texto mandado à conversa, guardado para o registro que chega DEPOIS dele. */
export interface SeenSend {
  hash: string
  at: number
  used: boolean
}

export interface ConvState {
  cwd: string
  projectId: string | null
  turnRunning: boolean
  turnStartedAt: number | null
  /** Perguntas/permissões abertas: id → ferramenta. */
  pending: Map<string, string>
  /** Início da fatia ativa em curso; `null` fora de tempo ativo. */
  activeSince: number | null
  lastActivity: number
  seen: SeenSend[]
  /** Tempo ativo sem envio corrente ainda (registro atrasado). */
  carryMs: number
  /** Entregas do envio corrente com cartão em andamento (destino do retrabalho). */
  cardInProgress: Set<string>
  cardsQueued: boolean
  /** Fatia ativa fechada por mudança no Quadro, à espera da releitura enfileirada. */
  cardsMs: number
  /** `lastActivity` da última varredura que não achou nada que pudesse parar. */
  dormantAt: number | null
  /** Aviso de prazo ao agente: nenhum marco vence antes deste instante (ms) — o
   *  tempo ativo nunca anda mais rápido que o relógio. 0 = reler o banco; toda
   *  escrita na conversa zera (handoffDeadline.msToNextMark). */
  noticeAt: number
  /** Aviso já gravado cujo texto ficou pronto depois do teto do hook: sai na
   *  próxima ferramenta (o marco não se perde nem se repete). */
  noticeCarry: string | null
  /** Há um aviso na fila: as ferramentas seguintes não esperam outra vez o teto. */
  noticeBusy: boolean
}

/** Textos lembrados por conversa (o registro atrasado leva segundos, não horas). */
export const SEEN_MAX = 20

export function newConvState(cwd: string, now: number): ConvState {
  return {
    cwd,
    projectId: null,
    turnRunning: false,
    turnStartedAt: null,
    pending: new Map(),
    activeSince: null,
    lastActivity: now,
    seen: [],
    carryMs: 0,
    cardInProgress: new Set(),
    cardsQueued: false,
    cardsMs: 0,
    dormantAt: null,
    noticeAt: 0,
    noticeCarry: null,
    noticeBusy: false
  }
}

/** Tempo ativo = turno rodando e nenhuma pergunta/permissão esperando você. */
export function isActive(s: ConvState): boolean {
  return s.turnRunning && s.pending.size === 0
}

/** Fecha a fatia ativa até `at`, aplica a mudança e reabre a fatia se ainda
 *  ativo. Devolve os ms da fatia fechada (0 fora de tempo ativo). */
export function closeSlice(s: ConvState, at: number, mutate: () => void = () => undefined): number {
  const ms = s.activeSince === null ? 0 : Math.max(0, at - s.activeSince)
  mutate()
  s.activeSince = isActive(s) ? at : null
  return ms
}

/** Guarda o texto visto no agent:send (os mais antigos saem). */
export function rememberSend(s: ConvState, hash: string, at: number): SeenSend {
  const seen: SeenSend = { hash, at, used: false }
  s.seen.push(seen)
  if (s.seen.length > SEEN_MAX) s.seen.splice(0, s.seen.length - SEEN_MAX)
  return seen
}
