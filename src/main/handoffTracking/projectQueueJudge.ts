import { randomUUID } from 'node:crypto'
import type { HandoffProjectReplyVerdict } from '../../shared/handoffProject'
import type { ProjectEvaluationOutcome, ProjectEvaluator } from './projectQueueEvaluation'
import type { ProjectGit } from './projectQueueGit'
import { moveTo, stopKey, stopReason, turnEvaluationDue, type PlanView } from './projectQueueRules'
import type { ProjectQueueData, ProjectQueueStore, StoredEvaluation } from './projectQueueStore'

/**
 * O PO DECIDE A VEZ — a parte da fila do projeto em que o modelo entra, sempre
 * com saída fixa na falha:
 * - o plano com a vez está parado há 30 min e outro espera → COMECAR/ESPERAR
 *   (falha → ESPERAR); reavalia só com algo mudado e no máximo a cada 30 min;
 * - o usuário respondeu o A com o B na vez → RETOMAR_A/ESPERAR_B/PERGUNTAR
 *   (falha → RETOMAR_A).
 *
 * Uma avaliação por pasta de cada vez. O usuário vence sempre: o serviço
 * cancela a avaliação quando ele responde no A, passa a vez ou começa mesmo
 * assim, e a decisão que chega depois de uma ação dele não vale.
 */

export interface ProjectJudgeContext {
  store: ProjectQueueStore
  git: ProjectGit
  evaluate: ProjectEvaluator
  now(): number
  views(key: string): Promise<PlanView[] | null>
  /** A pasta mudou: revê, avisa as conversas e publica a foto. */
  touched(key: string): Promise<void>
  publish(): Promise<void>
  log?(line: string): void
}

interface RunningEvaluation {
  kind: 'vez' | 'resposta'
  abort: AbortController
  loteA: string
  loteB: string
}

const iso = (ms: number): string => new Date(ms).toISOString()

export class ProjectQueueJudge {
  private readonly stopped = new Map<string, { key: string; since: number }>()
  private readonly running = new Map<string, RunningEvaluation>()

  constructor(private readonly ctx: ProjectJudgeContext) {}

  /** O PO está avaliando esta pasta agora? */
  evaluating(key: string): 'vez' | 'resposta' | null {
    return this.running.get(key)?.kind ?? null
  }

  /** Cancela a avaliação da pasta (de um tipo, ou qualquer uma). */
  cancel(key: string, kind?: 'vez' | 'resposta'): void {
    const ev = this.running.get(key)
    if (ev && (!kind || ev.kind === kind)) ev.abort.abort()
  }

  cancelAll(): void {
    for (const ev of this.running.values()) ev.abort.abort()
  }

  /** A pasta foi revista: o relógio da parada e a avaliação que perdeu o sentido. */
  observe(key: string, views: readonly PlanView[]): void {
    const stop = views[0] ? stopKey(views[0]) : null
    if (!stop) this.stopped.delete(key)
    else if (this.stopped.get(key)?.key !== stop) this.stopped.set(key, { key: stop, since: this.ctx.now() })
    const ev = this.running.get(key)
    if (ev?.kind !== 'vez') return
    const [holder, next] = views
    if (!holder || holder.plan.loteId !== ev.loteA || holder.state !== 'parado' || next?.plan.loteId !== ev.loteB) ev.abort.abort()
  }

  /** O vigia dos 30 min: plano com a vez parado e outro esperando → avaliação. */
  async tick(data: ProjectQueueData): Promise<void> {
    for (const [key, record] of Object.entries(data.folders)) {
      // Com uma resposta guardada, o usuário está presente: a vez é dele.
      if (this.running.has(key) || record.reply) continue
      const views = await this.ctx.views(key)
      if (!views) continue
      this.observe(key, views)
      const last = record.evaluation?.kind === 'vez' ? { ...record.evaluation, at: Date.parse(record.evaluation.at) } : null
      const base = { views, stoppedSince: this.stopped.get(key)?.since ?? null, now: this.ctx.now(), last }
      if (!turnEvaluationDue(base)) continue
      const signature = await this.signature(record.cwd, views[0])
      if (!turnEvaluationDue({ ...base, signature })) continue
      void this.run(key, record.cwd, 'vez', views[0], views[1], undefined, signature)
    }
  }

  /** A resposta guardada do usuário no A, com o B na vez: o PO decide o que acontece com ela. */
  decideReply(key: string, cwd: string, a: PlanView, b: PlanView, texto: string): void {
    this.cancel(key, 'vez')
    void this.run(key, cwd, 'resposta', a, b, texto)
  }

  /** O que muda o quadro da avaliação: um commit, a pasta, o A andar. */
  private async signature(cwd: string, holder: PlanView): Promise<string> {
    const [head, dirty] = await Promise.all([this.ctx.git.head(cwd), this.ctx.git.dirty(cwd)])
    return [head ?? '-', (dirty ?? []).join('\n'), stopKey(holder) ?? '-'].join('|')
  }

  private async run(key: string, cwd: string, kind: 'vez' | 'resposta', a: PlanView, b: PlanView, reply?: string, signature = ''): Promise<void> {
    if (this.running.has(key)) return
    const abort = new AbortController()
    this.running.set(key, { kind, abort, loteA: a.plan.loteId, loteB: b.plan.loteId })
    await this.ctx.publish()
    let outcome: ProjectEvaluationOutcome | null = null
    try {
      const since = this.stopped.get(key)?.since
      outcome = await this.ctx.evaluate({
        kind,
        cwd,
        a: { plan: a.plan, envios: a.envios, motivo: stopReason(a), ...(since ? { stoppedMinutes: Math.round((this.ctx.now() - since) / 60_000) } : {}) },
        b: { plan: b.plan, envios: b.envios },
        ...(reply !== undefined ? { reply } : {}),
        signal: abort.signal
      })
    } catch (err) {
      this.ctx.log?.(`[fila do projeto] avaliação falhou: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (this.running.get(key)?.abort === abort) this.running.delete(key)
    }
    if (!abort.signal.aborted && !outcome?.cancelled) {
      // Falha que nem chegou ao avaliador: a saída fixa de cada caso.
      outcome ??= { cancelled: false, decisao: kind === 'vez' ? 'ESPERAR' : 'RETOMAR_A', motivo: 'o PO não conseguiu avaliar', falhou: true, alterados: [], registro: null }
      if (kind === 'vez') await this.applyTurn(key, cwd, a, b, outcome, signature)
      else {
        await this.applyReply(key, a.plan.conversationId, outcome.decisao as HandoffProjectReplyVerdict, outcome.motivo, outcome.pergunta ?? null)
        await this.remember(key, kind, a, b, outcome, '')
      }
    }
    await this.ctx.touched(key)
  }

  private async applyTurn(key: string, cwd: string, a: PlanView, b: PlanView, outcome: ProjectEvaluationOutcome, signature: string): Promise<void> {
    const fresh = await this.ctx.views(key)
    // A situação mudou durante a avaliação (o A andou, alguém passou a vez): a decisão não vale.
    const same = !!fresh && fresh[0]?.plan.loteId === a.plan.loteId && fresh[0].state === 'parado' && fresh[1]?.plan.loteId === b.plan.loteId
    if (!same) return
    const start = outcome.decisao === 'COMECAR'
    const dirty = start && !b.started ? await this.ctx.git.dirty(cwd) : null
    if (start) {
      await this.ctx.store.update((data) => {
        const record = data.folders[key]
        if (!record) return
        record.plans = moveTo(record.plans, b.plan.loteId, 0)
        const plan = record.plans[0]
        plan.startAnyway = { by: 'po', at: iso(this.ctx.now()) }
        if (dirty && dirty.length > 0) plan.dirtyFromPrevious = { planTitulo: a.plan.planTitulo, files: dirty }
      })
    }
    await this.remember(key, 'vez', a, b, outcome, signature)
  }

  /** Aplica a decisão sobre a resposta guardada (do PO ou dos botões da pergunta). */
  async applyReply(key: string, conversationId: string, decisao: HandoffProjectReplyVerdict, motivo: string, pergunta: string | null, byUser = false): Promise<void> {
    await this.ctx.store.update((data) => {
      const record = data.folders[key]
      const reply = record?.reply
      if (!record || !reply || reply.conversationId !== conversationId) return
      // A decisão do PO chegou depois de uma ação do usuário: a dele vale.
      if (!byUser && reply.estado !== 'decidindo') return
      const lote = record.plans.find((p) => p.conversationId === conversationId)?.loteId
      if (decisao === 'RETOMAR_A' && lote) record.plans = moveTo(record.plans, lote, 0)
      reply.estado = decisao === 'RETOMAR_A' ? 'retomar_a' : decisao === 'ESPERAR_B' ? 'esperar_b' : 'pergunta'
      reply.motivo = decisao === 'PERGUNTAR' ? null : motivo
      reply.pergunta = decisao === 'PERGUNTAR' ? (pergunta ?? motivo) : null
      reply.por = byUser ? 'usuario' : 'po'
    })
  }

  private async remember(key: string, kind: 'vez' | 'resposta', a: PlanView, b: PlanView, outcome: ProjectEvaluationOutcome, signature: string): Promise<void> {
    const evaluation: StoredEvaluation = {
      id: randomUUID(),
      kind,
      at: iso(this.ctx.now()),
      decisao: outcome.decisao,
      motivo: outcome.motivo,
      ...(outcome.pergunta ? { pergunta: outcome.pergunta } : {}),
      falhou: outcome.falhou,
      alterados: outcome.alterados,
      registro: outcome.registro,
      loteA: a.plan.loteId,
      loteB: b.plan.loteId,
      signature
    }
    await this.ctx.store.update((data) => {
      const record = data.folders[key]
      if (record) record.evaluation = evaluation
    })
    if (outcome.alterados.length > 0) this.ctx.log?.(`[fila do projeto] o PO alterou: ${outcome.alterados.join(', ')}`)
  }
}
