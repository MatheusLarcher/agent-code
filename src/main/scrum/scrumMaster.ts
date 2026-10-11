import { randomUUID } from 'node:crypto'
import type { HandoffEntrega, HandoffEnvio } from '../../shared/handoffTracking'
import type { ScrumMasterConfig } from '../../shared/ipc'
import { noticeEntrega, noticeStepNumber } from '../handoffTracking/handoffDeadline'
import type { ScrumLogWriter } from './scrumLog'
import { dueScrumMark, firedFromLog, noteFired, scrumEsperaMs, scrumPrazoMs, travadoDue, type ScrumFired } from './scrumMarks'
import {
  agentReplies,
  buildScrumPrompt,
  declaracaoAnswer,
  declaracaoInputError,
  gatilhoVezes,
  minText,
  scrumCharge,
  scrumCutMessage,
  scrumNoticeText,
  scrumStopMotivo,
  scrumStopNote,
  vezesText
} from './scrumMessages'
import { scrumFixedCharge } from './scrumPromptText'
import type { ScrumDeclaracaoPedido, ScrumMasterRuntime } from './scrumRuntime'
import {
  SCRUM_TETO_DECLARACAO,
  type ScrumDecisao,
  type ScrumDecisaoTipo,
  type ScrumDeclaracao,
  type ScrumGatilho,
  type ScrumMarco,
  type ScrumVeredito
} from './scrumTypes'
import { parseScrumVerdict } from './scrumVerdict'

/**
 * O SERVIÇO do Scrum Master: a cada passada da varredura do handoff, olha as
 * conversas de handoff vivas e, na etapa em andamento com prazo:
 * - no marco (150/200/300%), consulta o modelo e deixa a COBRANÇA pendente — o
 *   hook PostToolUse a entrega na próxima ferramenta do fio principal
 *   (`takeCharge`); no 300% com PARAR e `podeParar`, PARA o envio pelo caminho
 *   do Stop;
 * - cobrança pendente há a espera com turno rodando (travado): respeita a
 *   declaração de tarefa demorada; sem ela, o modelo decide se CORTA o turno
 *   (interrupt sem as marcas do Stop + a cobrança como mensagem nova).
 * Uma intervenção forte (corte ou parada) por envio. Sem veredito do modelo
 * nunca corta nem para. Tudo vai ao diário; nada aqui lança para fora.
 */

const MIN_MS = 60_000

/** O que o SM usa do acompanhamento (o HandoffTracker real cumpre). */
export interface ScrumTracker {
  currentEnvio(convId: string, live?: boolean): Promise<HandoffEnvio | null>
  isTurnRunning(convId: string): boolean
  noteStop(convId: string, motivo?: string | null): void
  noteScrumCut(convId: string, on: boolean): void
}

export interface ScrumMasterDeps {
  tracker: ScrumTracker
  /** As conversas de handoff com sessão viva neste processo. */
  liveConversations(): string[]
  /** Interrompe SEM as marcas do Stop; `false` = não havia turno para cortar. */
  interrupt(convId: string): Promise<boolean>
  /** Manda a mensagem pelo mesmo `send` do Composer. */
  send(convId: string, text: string): Promise<unknown>
  config(): ScrumMasterConfig
  /** O payload salvo da conversa (de onde saem as respostas do agente). */
  conversation(convId: string): Promise<Record<string, unknown> | null>
  /** O modelo; `''` = falhou. */
  ask(prompt: string, model: string, convId: string): Promise<string>
  log: ScrumLogWriter
  /** O resumo `scrum` ao usuário. */
  publish(convId: string, texto: string): void
  /** O diário relido na primeira passada: o "já disparou" e as intervenções fortes. */
  history?(): Promise<readonly ScrumDecisao[]>
  now?(): number
  /** A escala de dev do prazo (scrumEscala); padrão 1. */
  escala?: number
  uuid?(): string
  warn?(where: string, err: unknown): void
}

/** A etapa em andamento de uma conversa, como o SM a vê agora. */
interface Etapa {
  convId: string
  envio: HandoffEnvio
  entrega: HandoffEntrega
  n: number
  prazoMs: number
  tempoMs: number
}

type Julgado = Pick<ScrumVeredito, 'tipoDesvio' | 'motivo' | 'cobranca'> & { veredito: ScrumVeredito['veredito'] | null }

interface Pendente {
  etapa: Etapa
  gatilho: ScrumMarco
  texto: string
  /** Desde quando está pendente COM turno rodando (o relógio do travado). */
  desde: number
  /** O travado desta cobrança já consultou o modelo (uma consulta por turno). */
  consultado: boolean
  /** O corte que o veredito pediu e não saiu (troca de conta no meio): tenta de novo. */
  cortarCom: { v: Julgado; base: Partial<ScrumDecisao> } | null
  deixou: boolean
  avisou: boolean
}

const SEM_ETAPA =
  'Nada registrado: esta conversa não tem uma etapa de handoff em andamento com prazo (estimativa do plano). Siga com o trabalho.'

export class ScrumMaster implements ScrumMasterRuntime {
  private readonly pending = new Map<string, Pendente>()
  private readonly stopNotes = new Map<string, string>()
  private readonly declaracoes = new Map<string, ScrumDeclaracao>()
  private readonly busy = new Set<string>()
  private readonly fired: ScrumFired = new Map()
  /** Envios cuja intervenção forte (corte ou parada) já foi usada. */
  private readonly strong = new Set<string>()
  private loaded: Promise<void> | null = null

  constructor(private readonly deps: ScrumMasterDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private get escala(): number {
    return this.deps.escala ?? 1
  }

  private warn(where: string, err: unknown): void {
    try {
      if (this.deps.warn) this.deps.warn(where, err)
      else console.warn(`[scrum] ${where}:`, err)
    } catch {
      /* o log nunca derruba o SM */
    }
  }

  private cfg(): ScrumMasterConfig | null {
    try {
      return this.deps.config()
    } catch (err) {
      this.warn('config', err)
      return null
    }
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const history = (await this.deps.history?.()) ?? []
        for (const [id, marco] of firedFromLog(history)) noteFired(this.fired, id, marco)
        for (const d of history) if (d.tipo === 'interrompeu' || d.tipo === 'parou') this.strong.add(d.envioId)
      } catch (err) {
        this.warn('history', err)
      }
    })()
    return this.loaded
  }

  /** Uma passada (a da varredura do handoff). Cada conversa, uma avaliação por vez. Nunca rejeita. */
  async onSweep(): Promise<void> {
    try {
      await this.load()
      const cfg = this.cfg()
      if (!cfg?.enabled) return
      const jobs: Promise<void>[] = []
      for (const convId of this.deps.liveConversations()) {
        if (this.busy.has(convId)) continue
        this.busy.add(convId)
        jobs.push(
          this.check(convId, cfg)
            .catch((err) => this.warn('check', err))
            .finally(() => this.busy.delete(convId))
        )
      }
      await Promise.all(jobs)
    } catch (err) {
      this.warn('onSweep', err)
    }
  }

  private async check(convId: string, cfg: ScrumMasterConfig): Promise<void> {
    const envio = await this.deps.tracker.currentEnvio(convId, true)
    const entrega = envio ? noticeEntrega(envio) : null
    const p = this.pending.get(convId)
    if (p && (!envio || !entrega || p.etapa.envio.id !== envio.id || p.etapa.entrega.id !== entrega.id)) this.pending.delete(convId)
    const running = this.deps.tracker.isTurnRunning(convId)
    const pend = this.pending.get(convId)
    // Sem turno a cobrança não tem como chegar: o relógio do travado volta a
    // contar no próximo turno (a cobrança fica para ele).
    if (pend && !running) Object.assign(pend, { desde: this.now(), consultado: false, cortarCom: null })
    if (!envio || !entrega || envio.status !== 'em_execucao') return
    const e = this.etapa(convId, envio, entrega)
    if (pend && travadoDue(pend.desde, this.now(), running, scrumEsperaMs(this.escala))) {
      await this.travado(e, pend, cfg)
      return
    }
    const due = dueScrumMark(envio, this.escala, this.fired)
    if (due) await this.mark(e, due.marco, cfg)
  }

  private etapa(convId: string, envio: HandoffEnvio, entrega: HandoffEntrega): Etapa {
    const prazoMs = scrumPrazoMs(entrega.estimativaPlano ?? 0, this.escala)
    return { convId, envio, entrega, n: noticeStepNumber(envio, entrega), prazoMs, tempoMs: Math.max(0, entrega.tempoAtivoMs) }
  }

  private declaration(e: Etapa): ScrumDeclaracao | null {
    return this.declaracoes.get(`${e.envio.id}:${e.entrega.id}`) ?? null
  }

  private validDeclaration(e: Etapa): boolean {
    const d = this.declaration(e)
    return !!d && this.now() - d.at < d.validoMin * MIN_MS
  }

  private record(e: Etapa, tipo: ScrumDecisaoTipo, extra: Partial<ScrumDecisao> = {}): void {
    try {
      this.deps.log({
        id: (this.deps.uuid ?? randomUUID)(),
        at: new Date(this.now()).toISOString(),
        tipo,
        convId: e.convId,
        conversationTitle: e.envio.conversationTitle || null,
        envioId: e.envio.id,
        entregaId: e.entrega.id,
        etapaId: e.entrega.etapaId,
        etapaN: e.n,
        projectCwd: e.envio.projectCwd || null,
        marco: null,
        veredito: null,
        tipoDesvio: null,
        motivo: null,
        cobranca: null,
        tempoAtivoMs: e.tempoMs,
        prazoMin: e.entrega.estimativaPlano,
        declaradoMin: null,
        decorridoMs: null,
        rota: null,
        durationMs: null,
        ...extra
      })
    } catch (err) {
      this.warn('log', err)
    }
  }

  private notice(e: Etapa, vezes: string, v: Julgado | null, acao: string): void {
    try {
      const veredito = v?.veredito ?? null
      this.deps.publish(e.convId, scrumNoticeText({ etapaN: e.n, etapaId: e.entrega.etapaId, vezes, veredito, tipoDesvio: v?.tipoDesvio ?? null, acao }))
    } catch (err) {
      this.warn('publish', err)
    }
  }

  /** O julgamento: só as respostas de texto do agente e os números da etapa. Falha = `falha`. */
  private async judge(e: Etapa, gatilho: ScrumGatilho, model: string, pendenteMs: number | null): Promise<{ v: ScrumVeredito; durationMs: number }> {
    const started = this.now()
    let text = ''
    try {
      const payload = await this.deps.conversation(e.convId)
      const d = this.declaration(e)
      const prompt = buildScrumPrompt({
        etapaN: e.n,
        etapaId: e.entrega.etapaId,
        etapaTitulo: e.entrega.etapaTitulo,
        prazoMs: e.prazoMs,
        tempoMs: e.tempoMs,
        gatilho,
        pendenteMs,
        declaracao: d ? { validoMin: d.validoMin, motivo: d.motivo, decorridoMs: this.now() - d.at } : null,
        replies: agentReplies(payload, e.envio.conteudoHash)
      })
      text = (await this.deps.ask(prompt, model, e.convId)) ?? ''
    } catch (err) {
      this.warn('judge', err)
    }
    return { v: parseScrumVerdict(text, gatilho), durationMs: Math.max(0, this.now() - started) }
  }

  private async mark(e: Etapa, marco: ScrumMarco, cfg: ScrumMasterConfig): Promise<void> {
    // Antes da consulta: a próxima passada não dispara o mesmo marco outra vez.
    noteFired(this.fired, e.entrega.id, marco)
    const { v, durationMs } = await this.judge(e, marco, cfg.model, null)
    const vezes = gatilhoVezes(marco, e.tempoMs, e.prazoMs)
    const base: Partial<ScrumDecisao> = { marco, veredito: v.veredito, tipoDesvio: v.tipoDesvio, motivo: v.motivo || null, rota: cfg.model, durationMs }
    if (v.veredito === 'parar' && marco === 300 && cfg.podeParar && !this.strong.has(e.envio.id) && !this.validDeclaration(e)) {
      await this.stop(e, v, vezes, base)
      return
    }
    const falhou = v.veredito === 'falha' || !v.cobranca
    const texto = scrumCharge(e.n, vezes, falhou ? scrumFixedCharge(e.n, e.entrega.etapaId, vezes) : (v.cobranca as string))
    this.setPending(e, marco, texto)
    this.record(e, v.veredito === 'falha' ? 'falha' : 'cobrou', { ...base, cobranca: texto })
    if (marco >= 200) {
      this.notice(e, vezes, v, v.veredito === 'falha' ? 'O modelo não julgou: o Scrum Master mandou a cobrança padrão ao agente.' : 'O Scrum Master cobrou o agente na conversa.')
    }
  }

  private setPending(e: Etapa, gatilho: ScrumMarco, texto: string): void {
    const old = this.pending.get(e.convId)
    const same = !!old && old.etapa.envio.id === e.envio.id && old.etapa.entrega.id === e.entrega.id
    this.pending.set(e.convId, {
      etapa: e,
      gatilho,
      texto,
      desde: same && old ? old.desde : this.now(),
      consultado: false,
      cortarCom: null,
      deixou: false,
      avisou: false
    })
  }

  /** A parada do 300%: o estado do Stop (com o motivo do SM) ANTES do interrupt — o fim do turno grava. */
  private async stop(e: Etapa, v: ScrumVeredito, vezes: string, base: Partial<ScrumDecisao>): Promise<void> {
    const motivo = scrumStopMotivo(v.motivo)
    const reason = motivo.slice('Scrum Master: '.length)
    this.strong.add(e.envio.id)
    this.pending.delete(e.convId)
    this.deps.tracker.noteStop(e.convId, motivo)
    try {
      await this.deps.interrupt(e.convId)
    } catch (err) {
      this.warn('interrupt', err)
    }
    this.stopNotes.set(e.convId, scrumStopNote(this.now(), reason))
    this.record(e, 'parou', { ...base, motivo: reason })
    this.notice(e, vezes, v, `O Scrum Master parou o envio: ${reason}. A fila espera você.`)
  }

  private async travado(e: Etapa, p: Pendente, cfg: ScrumMasterConfig): Promise<void> {
    const pendenteMs = this.now() - p.desde
    const d = this.declaration(e)
    if (d) {
      const decorridoMs = this.now() - d.at
      const extra = { marco: 'travado' as const, declaradoMin: d.validoMin, decorridoMs }
      if (decorridoMs < d.validoMin * MIN_MS) {
        if (!p.deixou) this.record(e, 'deixou-seguir', { ...extra, motivo: `dentro do tempo declarado para "${d.motivo}"` })
        p.deixou = true
        return
      }
      const motivo = `passou do tempo que você declarou (${minText(d.validoMin * MIN_MS)} para "${d.motivo}")`
      await this.cut(e, p, { veredito: null, tipoDesvio: null, motivo, cobranca: null }, { ...extra, motivo })
      return
    }
    if (p.consultado) {
      if (p.cortarCom) await this.cut(e, p, p.cortarCom.v, p.cortarCom.base)
      return
    }
    p.consultado = true
    const { v, durationMs } = await this.judge(e, 'travado', cfg.model, pendenteMs)
    const base: Partial<ScrumDecisao> = {
      marco: 'travado',
      veredito: v.veredito,
      tipoDesvio: v.tipoDesvio,
      motivo: v.motivo || null,
      rota: cfg.model,
      durationMs,
      decorridoMs: pendenteMs
    }
    // Sem veredito, nunca corta; JUSTIFICADO espera.
    if (v.veredito === 'falha') return this.record(e, 'falha', base)
    if (v.veredito === 'justificado') return this.record(e, 'deixou-seguir', base)
    await this.cut(e, p, v, base)
  }

  /** O corte do travado: interrompe SEM as marcas do Stop e manda a cobrança como mensagem nova. */
  private async cut(e: Etapa, p: Pendente, v: Julgado, base: Partial<ScrumDecisao>): Promise<void> {
    const vezes = vezesText(e.tempoMs, e.prazoMs)
    if (this.strong.has(e.envio.id)) {
      if (!p.avisou) {
        this.record(e, 'avisou', base)
        this.notice(e, vezes, v, 'O agente parece travado, mas este envio já teve a intervenção forte dele: o Scrum Master só avisa você.')
      }
      p.avisou = true
      return
    }
    const tracker = this.deps.tracker
    tracker.noteScrumCut(e.convId, true)
    let ok = false
    try {
      ok = await this.deps.interrupt(e.convId)
    } catch (err) {
      this.warn('interrupt', err)
    }
    if (!ok) {
      // A sessão já encerrou o turno sozinha (ou trocava de conta): a cobrança fica pendente.
      tracker.noteScrumCut(e.convId, false)
      p.cortarCom = { v, base }
      return
    }
    this.strong.add(e.envio.id)
    this.pending.delete(e.convId)
    const motivo = v.motivo || 'a cobrança não teve resposta'
    const message = scrumCutMessage({ etapaN: e.n, vezes, motivo, cobranca: v.cobranca, pendenteMs: this.now() - p.desde })
    this.record(e, 'interrompeu', { ...base, cobranca: message })
    this.notice(e, vezes, v, 'O Scrum Master interrompeu o turno e mandou a cobrança como mensagem nova (o pedido não foi cancelado).')
    try {
      await this.deps.send(e.convId, message)
    } catch (err) {
      this.warn('send', err)
    }
  }

  takeCharge(convId: string): string | null {
    const p = this.pending.get(convId)
    if (!p) return null
    this.pending.delete(convId)
    if (!this.cfg()?.enabled) return null
    this.record(p.etapa, 'entregue', { marco: p.gatilho, cobranca: p.texto, decorridoMs: Math.max(0, this.now() - p.desde) })
    return p.texto
  }

  takeStopNote(convId: string): string | null {
    const note = this.stopNotes.get(convId) ?? null
    this.stopNotes.delete(convId)
    return note
  }

  /** As declarações acima do teto que esperam o usuário (o Aprovar/Recusar do painel). */
  pendingDeclarations(): ScrumDeclaracao[] {
    return [...this.declaracoes.values()].filter((d) => d.acimaDoTeto && !d.decidida).map((d) => ({ ...d }))
  }

  /** O usuário decidiu no painel: aprovada, o pedido inteiro passa a valer. `null` = não há o que decidir. */
  decideDeclaration(envioId: string, entregaId: string, aprovar: boolean): ScrumDeclaracao | null {
    const d = this.declaracoes.get(`${envioId}:${entregaId}`)
    if (!d || !d.acimaDoTeto || d.decidida) return null
    d.decidida = aprovar ? 'aprovou' : 'recusou'
    if (aprovar) d.validoMin = d.pedidoMin
    return { ...d }
  }

  async declare(convId: string, pedido: ScrumDeclaracaoPedido): Promise<string> {
    try {
      const invalid = declaracaoInputError(pedido.minutos, pedido.motivo)
      if (invalid) return `Nada registrado. ${invalid}`
      const minutos = pedido.minutos as number
      const motivo = String(pedido.motivo).trim()
      const envio = await this.deps.tracker.currentEnvio(convId, true)
      const entrega = envio ? noticeEntrega(envio) : null
      if (!envio || !entrega) return SEM_ETAPA
      const e = this.etapa(convId, envio, entrega)
      const tetoMin = (SCRUM_TETO_DECLARACAO * e.prazoMs) / MIN_MS
      const validoMin = Math.min(minutos, tetoMin)
      const acimaDoTeto = minutos > tetoMin
      const enabled = !!this.cfg()?.enabled
      this.declaracoes.set(`${envio.id}:${entrega.id}`, { envioId: envio.id, entregaId: entrega.id, pedidoMin: minutos, validoMin, motivo, at: this.now(), acimaDoTeto })
      this.record(e, 'declarou', { declaradoMin: validoMin, motivo: acimaDoTeto ? `pediu ${minutos} min (acima do teto): ${motivo}` : motivo })
      if (acimaDoTeto && enabled) {
        this.notice(
          e,
          vezesText(e.tempoMs, e.prazoMs),
          null,
          `O agente declarou ${minutos} min para "${motivo}", acima do teto de ${SCRUM_TETO_DECLARACAO}× o prazo: valeu ${minText(tetoMin * MIN_MS)}. O resto precisa da sua aprovação.`
        )
      }
      return declaracaoAnswer({ etapaN: e.n, etapaId: entrega.etapaId, pedidoMin: minutos, validoMin, tetoMin, motivo, enabled })
    } catch (err) {
      this.warn('declare', err)
      return 'entrega_aviso_demora falhou agora: nada foi registrado. Siga com a tarefa, avisando no texto quanto tempo ela leva.'
    }
  }
}
