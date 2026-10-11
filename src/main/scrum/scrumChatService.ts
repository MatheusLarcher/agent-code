import { randomUUID } from 'node:crypto'
import type { ScrumMasterConfig } from '../../shared/ipc'
import type { ScrumAskRequest, ScrumAskResult, ScrumChatMessage, ScrumDecisao } from '../../shared/scrumPanel'
import type { ScrumLogWriter } from './scrumLog'

/**
 * A CONVERSA COM O SCRUM MASTER (a terceira aba do painel). O usuário pergunta
 * sobre as decisões; o SM responde com base no PRÓPRIO diário, sem ferramentas
 * (a rota do julgamento: askObserver). Por aqui ele NÃO corta, NÃO retoma, NÃO
 * muda configuração e NÃO passa a aplicar sozinho as regras que o usuário dita:
 * elas ficam guardadas na conversa para ajustar o SM depois.
 *
 * "Marcar como corte errado" grava uma linha `contestado` no diário com a frase
 * do usuário (a única linha do diário com texto dele) e responde com texto fixo.
 * As perguntas entram em fila: duas seguidas não se atropelam.
 */

export const SCRUM_CHAT_ASK_TIMEOUT_MS = 120_000
const QUESTION_MAX = 2_000
const RECENT_DECISIONS = 30
const RECENT_MESSAGES = 20
const CONTEST_DEFAULT = 'corte errado'

export const SCRUM_CONTEST_ANSWER =
  'Marquei esta decisão como contestada. A sua frase fica guardada junto dela no diário, para quando eu for ajustado.'
export const SCRUM_NO_ANSWER = 'Não consegui responder agora (conta, rede ou demorou demais). Tente de novo.'

export interface ScrumChatStoreLike {
  append(...messages: ScrumChatMessage[]): Promise<void>
  all(): Promise<ScrumChatMessage[]>
}

export interface ScrumChatDeps {
  store: ScrumChatStoreLike
  /** O diário inteiro (readScrumLog). */
  history(): Promise<ScrumDecisao[]>
  /** O gravador do diário com aviso à tela (scrumFeed.log). */
  log: ScrumLogWriter
  config(): ScrumMasterConfig
  ask(prompt: string, model: string, conversationId?: string): Promise<string>
  timeoutMs?: number
  now?(): number
  newId?(): string
}

function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    timer.unref?.()
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      }
    )
  })
}

function minutes(ms: number | null): string {
  return ms === null ? '?' : String(Math.round(ms / 60_000))
}

/** Uma decisão em uma linha, para o prompt. */
export function decisionLine(d: ScrumDecisao): string {
  const parts = [
    d.at,
    `id ${d.id}`,
    d.tipo,
    d.conversationTitle ? `conversa "${d.conversationTitle}"` : null,
    d.etapaN !== null ? `etapa ${d.etapaN}${d.etapaId ? ` (${d.etapaId})` : ''}` : null,
    d.marco !== null ? `marco ${d.marco === 'travado' ? 'travado' : `${d.marco}%`}` : null,
    d.veredito ? `veredito ${d.veredito}${d.tipoDesvio ? `/${d.tipoDesvio}` : ''}` : null,
    d.tempoAtivoMs !== null ? `tempo ${minutes(d.tempoAtivoMs)} de ${d.prazoMin ?? '?'} min` : null,
    d.declaradoMin !== null ? `declarado ${d.declaradoMin} min` : null,
    d.motivo ? `motivo: ${d.motivo}` : null,
    d.cobranca ? `cobrança: ${d.cobranca}` : null,
    d.texto ? `${d.tipo === 'contestado' ? 'frase do usuário' : 'texto'}: ${d.texto}` : null
  ]
  return parts.filter(Boolean).join(' · ')
}

export interface ScrumChatPromptInput {
  question: string
  sobre: ScrumDecisao | null
  /** As linhas ligadas à decisão `sobre` (resposta do agente, contestação, decisão do usuário). */
  ligadas: readonly ScrumDecisao[]
  recentes: readonly ScrumDecisao[]
  chat: readonly ScrumChatMessage[]
}

export function scrumChatPrompt(input: ScrumChatPromptInput): string {
  const lines = [
    'Você é o Scrum Master do Agent Code: o agente que cobra as etapas de handoff que passam do prazo',
    '(marcos de 150%, 200% e 300% do prazo da etapa), corta o turno do agente travado e, no 300%, pode parar o envio.',
    'O usuário está conversando com você sobre as SUAS decisões, registradas no diário abaixo.',
    '',
    'Regras desta conversa:',
    '- Responda em português do Brasil, curto e objetivo, em texto corrido (sem títulos nem tabelas).',
    '- Use só o diário e a conversa abaixo. O que não estiver neles, diga que não sabe.',
    '- Você NÃO corta, NÃO retoma envios e NÃO muda configuração por aqui. Se o usuário pedir, diga que isso é',
    '  feito no painel (Retomar com o aviso, Tirar da fila, a chave "Pode parar envios").',
    '- Se o usuário ditar uma regra ("não corte quando…"), diga que ela fica registrada nesta conversa para quando',
    '  você for ajustado — você não passa a aplicá-la sozinho.',
    '- Explique o porquê de cada decisão pelo motivo, o veredito e os números registrados.'
  ]
  if (input.sobre) {
    lines.push('', 'A pergunta é sobre esta decisão:', decisionLine(input.sobre))
    for (const d of input.ligadas) lines.push(`  ↳ ${decisionLine(d)}`)
  }
  lines.push('', `Diário (as ${input.recentes.length} decisões mais recentes, da mais antiga para a mais nova):`)
  if (input.recentes.length === 0) lines.push('(vazio)')
  for (const d of input.recentes) lines.push(decisionLine(d))
  if (input.chat.length > 0) {
    lines.push('', 'Conversa até aqui:')
    for (const m of input.chat) lines.push(`${m.role === 'usuario' ? 'Usuário' : 'Scrum Master'}: ${m.text}`)
  }
  lines.push('', `Pergunta do usuário: ${input.question}`, '', 'Responda só com o texto da resposta.')
  return lines.join('\n')
}

export class ScrumChatService {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: ScrumChatDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private id(): string {
    return this.deps.newId?.() ?? randomUUID()
  }

  private message(role: ScrumChatMessage['role'], text: string, sobre: ScrumDecisao | null, sobreId: string | null): ScrumChatMessage {
    return { id: this.id(), at: new Date(this.now()).toISOString(), role, text, sobre: sobreId, projectCwd: sobre?.projectCwd ?? null }
  }

  /** Uma pergunta (ou uma contestação). Em fila com as anteriores; nunca rejeita. */
  ask(req: ScrumAskRequest): Promise<ScrumAskResult> {
    const run = this.chain.catch(() => undefined).then(() => this.run(req))
    this.chain = run
    return run.catch((err): ScrumAskResult => ({ ok: false, message: err instanceof Error ? err.message : String(err) }))
  }

  private async run(req: ScrumAskRequest): Promise<ScrumAskResult> {
    const typed = req.text.trim().slice(0, QUESTION_MAX)
    const text = typed || (req.contestar ? CONTEST_DEFAULT : '')
    if (!text) return { ok: false, message: 'Escreva a mensagem.' }
    const log = await this.deps.history().catch((): ScrumDecisao[] => [])
    const sobre = req.sobre ? (log.find((d) => d.id === req.sobre) ?? null) : null
    const contest = !!sobre && (req.contestar === true || /corte errado/i.test(text))
    if (req.contestar && !sobre) return { ok: false, message: 'Escolha a decisão a contestar (Questionar, no Histórico).' }
    const user = this.message('usuario', text, sobre, req.sobre ?? null)
    try {
      await this.deps.store.append(user)
    } catch (err) {
      return { ok: false, message: `A conversa não foi guardada: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (contest && sobre) {
      this.deps.log({
        ...sobre,
        id: this.id(),
        at: new Date(this.now()).toISOString(),
        tipo: 'contestado',
        refId: sobre.id,
        texto: text
      })
      return this.answer([user], SCRUM_CONTEST_ANSWER, sobre, req.sobre ?? null, true)
    }
    const chat = await this.deps.store.all()
    const prompt = scrumChatPrompt({
      question: text,
      sobre,
      ligadas: sobre ? log.filter((d) => d.refId === sobre.id) : [],
      recentes: log.slice(-RECENT_DECISIONS),
      // A pergunta já foi gravada: ela vai como "Pergunta", não no histórico.
      chat: chat.filter((m) => m.id !== user.id).slice(-RECENT_MESSAGES)
    })
    const raw = await withTimeout(this.deps.ask(prompt, this.deps.config().model, sobre?.convId), this.deps.timeoutMs ?? SCRUM_CHAT_ASK_TIMEOUT_MS, '')
    return this.answer([user], raw.trim() || SCRUM_NO_ANSWER, sobre, req.sobre ?? null, false)
  }

  private async answer(before: ScrumChatMessage[], text: string, sobre: ScrumDecisao | null, sobreId: string | null, contestado: boolean): Promise<ScrumAskResult> {
    const sm = this.message('sm', text, sobre, sobreId)
    try {
      await this.deps.store.append(sm)
    } catch (err) {
      return { ok: false, message: `A resposta não foi guardada: ${err instanceof Error ? err.message : String(err)}` }
    }
    return { ok: true, messages: [...before, sm], contestado }
  }
}
