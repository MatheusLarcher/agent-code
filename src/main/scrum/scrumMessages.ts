import { handoffContentHash } from '../handoffTracking/handoffModel'
import { STALL_ABORT_MS, STALL_ABORT_TOOL_MS } from '../stallWatch'
import {
  SCRUM_ETAPA_SECTION,
  SCRUM_RESPOSTAS_CORTADAS,
  SCRUM_RESPOSTAS_SECTION,
  SCRUM_SEM_RESPOSTAS,
  SCRUM_SYSTEM_PROMPT
} from './scrumPromptText'
import { SCRUM_TETO_DECLARACAO, type ScrumGatilho, type ScrumTipoDesvio, type ScrumVereditoTipo } from './scrumTypes'

/**
 * Os textos MONTADOS do Scrum Master (scrumMaster.ts decide, aqui só se
 * escreve): o pedido ao modelo, a cobrança com o rótulo, a mensagem do corte, a
 * nota da parada, o resumo ao usuário e a resposta de `entrega_aviso_demora`.
 */

const MIN_MS = 60_000

/** O que cabe das respostas do agente no pedido ao modelo (fica o FIM). */
export const SCRUM_RESPOSTAS_MAX_CHARS = 60_000

/** Teto do pedido de `entrega_aviso_demora`: um dia de relógio. */
export const SCRUM_DECLARACAO_MAX_MIN = 1_440
const DECLARACAO_MOTIVO_MAX = 500

/** "1,5" / "2" — uma casa, vírgula, sem o ",0". */
function num(n: number): string {
  return (Math.round(n * 10) / 10).toLocaleString('pt-BR', { maximumFractionDigits: 1 })
}

export function minText(ms: number): string {
  return `${num(ms / MIN_MS)} min`
}

/** Quantas vezes o prazo: "1,5×", "2×", "2,3×". */
export function vezesText(tempoMs: number, prazoMs: number): string {
  return prazoMs > 0 ? `${num(tempoMs / prazoMs)}×` : '?×'
}

export function gatilhoVezes(gatilho: ScrumGatilho, tempoMs: number, prazoMs: number): string {
  return gatilho === 'travado' ? vezesText(tempoMs, prazoMs) : `${num(gatilho / 100)}×`
}

/** O rótulo fixo da cobrança: o agente sabe de onde ela veio. */
export function scrumChargeLabel(etapaN: number, vezes: string): string {
  return `📋 Scrum Master — etapa ${etapaN}, ${vezes} do prazo:`
}

export function scrumCharge(etapaN: number, vezes: string, cobranca: string): string {
  return `${scrumChargeLabel(etapaN, vezes)} ${cobranca}`
}

/** O motivo gravado no envio parado — não é de inatividade (isStallMotivo). */
export function scrumStopMotivo(motivo: string): string {
  const m = motivo.replace(/\s+/g, ' ').trim() || 'seguir era desperdício'
  return `Scrum Master: ${m.length > 300 ? `${m.slice(0, 299)}…` : m}`
}

function hhmm(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** A nota da próxima mensagem depois da parada (molde da nota do cancelamento). */
export function scrumStopNote(at: number, motivo: string): string {
  return (
    `[Scrum Master] Este envio foi parado às ${hhmm(at)} por: ${motivo}. ` +
    'Antes de seguir, confira o estado dos arquivos que você estava editando.'
  )
}

export interface ScrumCutText {
  etapaN: number
  vezes: string
  motivo: string
  cobranca: string | null
  pendenteMs: number
}

/** A mensagem nova do corte do travado: quem cortou, por quê, que nada foi cancelado e o que fazer. */
export function scrumCutMessage(c: ScrumCutText): string {
  return [
    `${scrumChargeLabel(c.etapaN, c.vezes)} eu interrompi o seu turno porque ${c.motivo.replace(/[.\s]+$/u, '')} ` +
      `(a cobrança ficou ${minText(c.pendenteMs)} pendente sem chegar a você).`,
    'O pedido NÃO foi cancelado: o handoff e a etapa continuam valendo.',
    c.cobranca ?? '',
    'Agora: continue a etapa, diga em uma linha o que falta, ou registre o bloqueio.'
  ]
    .filter(Boolean)
    .join(' ')
}

const VEREDITO_LABEL: Record<ScrumVereditoTipo, string> = {
  justificado: 'atraso justificado',
  desvio: 'desvio',
  parar: 'parar',
  falha: 'sem julgamento do modelo'
}

export function vereditoText(veredito: ScrumVereditoTipo, tipo: ScrumTipoDesvio | null): string {
  return veredito === 'desvio' && tipo ? `desvio (${tipo})` : VEREDITO_LABEL[veredito]
}

export interface ScrumNoticeText {
  etapaN: number
  etapaId: string
  vezes: string
  veredito: ScrumVereditoTipo | null
  tipoDesvio: ScrumTipoDesvio | null
  /** O que o SM fez, numa frase. */
  acao: string
}

/** O resumo `scrum` ao usuário (handoffNoticeText põe o nome da conversa na frente). */
export function scrumNoticeText(n: ScrumNoticeText): string {
  const veredito = n.veredito ? ` — ${vereditoText(n.veredito, n.tipoDesvio)}` : ''
  return `Etapa ${n.etapaN} (${n.etapaId}): ${n.vezes} do prazo${veredito}. ${n.acao}`
}

type StoredMessage = { kind?: unknown; text?: unknown; parentToolUseId?: unknown }

/**
 * As respostas de TEXTO do agente principal desde o início do envio: depois da
 * última mensagem do usuário que é o conteúdo do envio (mesmo hash); sem ela,
 * todas. Nunca texto do usuário, ferramenta nem subagente.
 */
export function agentReplies(payload: Record<string, unknown> | null | undefined, conteudoHash: string | null): string[] {
  const messages = Array.isArray(payload?.messages) ? (payload.messages as StoredMessage[]) : []
  let start = 0
  if (conteudoHash) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m && m.kind === 'user' && typeof m.text === 'string' && handoffContentHash(m.text) === conteudoHash) {
        start = i + 1
        break
      }
    }
  }
  const out: string[] = []
  for (const m of messages.slice(start)) {
    if (!m || m.kind !== 'assistant-text' || m.parentToolUseId || typeof m.text !== 'string') continue
    const t = m.text.trim()
    if (t) out.push(t)
  }
  return out
}

/** As respostas juntas; compridas demais, fica o FIM com o marcador do corte. */
export function repliesBlock(replies: readonly string[], max = SCRUM_RESPOSTAS_MAX_CHARS): string {
  if (replies.length === 0) return SCRUM_SEM_RESPOSTAS
  const joined = replies.join('\n\n---\n\n')
  return joined.length > max ? `${SCRUM_RESPOSTAS_CORTADAS}\n${joined.slice(-max)}` : joined
}

export interface ScrumPromptInput {
  etapaN: number
  etapaId: string
  etapaTitulo: string
  prazoMs: number
  tempoMs: number
  gatilho: ScrumGatilho
  /** Há quanto a cobrança está pendente (só no travado). */
  pendenteMs: number | null
  declaracao: { validoMin: number; motivo: string; decorridoMs: number } | null
  replies: readonly string[]
}

function gatilhoText(p: ScrumPromptInput): string {
  if (p.gatilho !== 'travado') return `marco de ${p.gatilho}% do prazo`
  return (
    `agente travado — a cobrança está pendente há ${minText(p.pendenteMs ?? 0)} sem chegar ao agente, com o turno rodando ` +
    '(ele não chamou nenhuma ferramenta do fio principal nesse tempo)'
  )
}

function declaracaoText(d: ScrumPromptInput['declaracao']): string {
  if (!d) return 'nenhuma'
  const passou = d.decorridoMs >= d.validoMin * MIN_MS ? ' (já passou do declarado)' : ''
  return `${num(d.validoMin)} min de relógio para "${d.motivo}", declarada há ${minText(d.decorridoMs)}${passou}`
}

/** O pedido inteiro ao modelo: o papel, a etapa e as respostas do agente. */
export function buildScrumPrompt(p: ScrumPromptInput): string {
  return [
    SCRUM_SYSTEM_PROMPT,
    '',
    SCRUM_ETAPA_SECTION,
    `- Etapa ${p.etapaN} (${p.etapaId}): ${p.etapaTitulo}`,
    `- Prazo: ${minText(p.prazoMs)} de trabalho`,
    `- Tempo ativo: ${minText(p.tempoMs)} (${vezesText(p.tempoMs, p.prazoMs)} do prazo)`,
    `- Gatilho: ${gatilhoText(p)}`,
    `- Tarefa demorada declarada: ${declaracaoText(p.declaracao)}`,
    '',
    SCRUM_RESPOSTAS_SECTION,
    repliesBlock(p.replies)
  ].join('\n')
}

/** A validação do pedido de `entrega_aviso_demora`, com a frase em pt-BR; `null` = válido. */
export function declaracaoInputError(minutos: unknown, motivo: unknown): string | null {
  if (typeof minutos !== 'number' || !Number.isInteger(minutos) || minutos < 1 || minutos > SCRUM_DECLARACAO_MAX_MIN) {
    return `"minutos" precisa ser um número inteiro de 1 a ${SCRUM_DECLARACAO_MAX_MIN} (recebi ${JSON.stringify(minutos)}): minutos de relógio da tarefa demorada.`
  }
  const text = typeof motivo === 'string' ? motivo.trim() : ''
  if (!text) return 'Diga o "motivo": qual é a tarefa demorada (ex.: "build completo", "varredura do repositório").'
  if (text.length > DECLARACAO_MOTIVO_MAX) return `O "motivo" tem ${text.length} caracteres; o teto é ${DECLARACAO_MOTIVO_MAX}. Resuma e chame de novo.`
  return null
}

/** O lembrete do encerramento por silêncio total (stallWatch.ts), na resposta e na descrição da ferramenta. */
export const SCRUM_SILENCIO_AVISO =
  `A sessão continua sendo encerrada por silêncio total (${STALL_ABORT_MS / MIN_MS} min sem sinal nenhum, ` +
  `${STALL_ABORT_TOOL_MS / MIN_MS} min com uma ferramenta rodando): tarefa demorada de verdade roda em segundo plano ` +
  'e você a acompanha com chamadas de ferramenta.'

export interface ScrumDeclaracaoText {
  etapaN: number
  etapaId: string
  pedidoMin: number
  validoMin: number
  tetoMin: number | null
  motivo: string
  enabled: boolean
}

/** A resposta de `entrega_aviso_demora`: quanto tempo VALEU. */
export function declaracaoAnswer(d: ScrumDeclaracaoText): string {
  const lines = [
    `Declaração registrada para a etapa ${d.etapaN} (${d.etapaId}): VALEU ${num(d.validoMin)} min de relógio, a partir de agora, para "${d.motivo}".`
  ]
  if (d.tetoMin !== null && d.pedidoMin > d.validoMin) {
    lines.push(
      `Você pediu ${d.pedidoMin} min, acima do teto de ${SCRUM_TETO_DECLARACAO}× o prazo da etapa (${num(d.tetoMin)} min). ` +
        'O usuário foi avisado para aprovar o resto; até lá, conte só com o que valeu.'
    )
  }
  lines.push(
    d.enabled
      ? 'Dentro desse tempo o Scrum Master não interrompe o seu turno por cobrança sem resposta; passado ele, cobra.'
      : 'O Scrum Master está desligado neste app: a declaração fica registrada, mas ninguém vai cobrar.',
    SCRUM_SILENCIO_AVISO
  )
  return lines.join('\n')
}
