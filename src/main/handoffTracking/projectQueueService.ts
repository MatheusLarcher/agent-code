import { resolve } from 'node:path'
import { currentEnvio, type HandoffEnvio, type HandoffQueueDecision } from '../../shared/handoffTracking'
import {
  projectFolderKey,
  type HandoffProjectAction,
  type HandoffProjectFolder,
  type HandoffProjectPlan,
  type HandoffProjectSnapshot
} from '../../shared/handoffProject'
import type { HandoffRepository } from '../persistence/types'
import { decideQueue, queuedEnvios } from './handoffQueue'
import type { ProjectEvaluator } from './projectQueueEvaluation'
import type { ProjectGit } from './projectQueueGit'
import { ProjectQueueJudge } from './projectQueueJudge'
import { dirtyReason, moveTo, passTurn, projectStep, queuedPrompt, remainingMinutes, startDecision, viewFolder, type PlanView } from './projectQueueRules'
import type { FolderRecord, ProjectQueueData, ProjectQueueStore } from './projectQueueStore'

/**
 * O SERVIÇO da fila do projeto: guarda a ordem dos planos de cada pasta neste
 * PC (projectQueueStore.ts), lê os envios do banco, confere a pasta (git) e
 * aplica as regras puras (projectQueueRules.ts). É ele que o gate da fila do
 * quadro consulta antes de soltar um prompt — a decisão continua num lugar só.
 * O PO entra pelo juiz (projectQueueJudge.ts), nos dois casos raros.
 *
 * Plano que não está na fila deste PC (enviado antes desta fila, ou por outro
 * PC) segue só a regra da fila do quadro, como antes.
 */

export interface ProjectQueueServiceDeps {
  repository(): HandoffRepository | null
  store: ProjectQueueStore
  git: ProjectGit
  evaluate: ProjectEvaluator
  /** handoff:changed de uma conversa: o despachante dela confere a fila. */
  notify(conversationId: string): void
  /** A foto nova da fila (handoff:projectChanged). */
  publish(snapshot: HandoffProjectSnapshot): void
  now?(): number
  caseInsensitive?: boolean
  log?(line: string): void
  /** Intervalo do vigia dos 30 min; padrão 60 s. */
  tickMs?: number
  /** Espera para juntar os avisos do acompanhamento; padrão 250 ms. */
  debounceMs?: number
}

type Located = { key: string; record: FolderRecord }

export interface ProjectDescription {
  decision: HandoffQueueDecision
  posicao: number | null
  estado: 'esperando' | 'parada' | null
}

const iso = (ms: number): string => new Date(ms).toISOString()

export class ProjectQueueService {
  private readonly dirtyCount = new Map<string, number>()
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly signatures = new Map<string, string>()
  private readonly judge: ProjectQueueJudge
  private readonly caseInsensitive: boolean
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: ProjectQueueServiceDeps) {
    this.caseInsensitive = deps.caseInsensitive ?? process.platform === 'win32'
    this.judge = new ProjectQueueJudge({
      store: deps.store,
      git: deps.git,
      evaluate: deps.evaluate,
      now: () => this.now(),
      views: (key) => this.views(key),
      touched: (key) => this.touched(key),
      publish: () => this.publish(),
      ...(deps.log ? { log: deps.log } : {})
    })
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  key(cwd: string): string {
    return projectFolderKey(resolve(cwd), this.caseInsensitive)
  }

  // -------------------------------------------------------------------------
  // Leitura
  // -------------------------------------------------------------------------

  private data(): Promise<ProjectQueueData> {
    return this.deps.store.read()
  }

  private async locate(match: (plan: FolderRecord['plans'][number]) => boolean): Promise<Located | null> {
    for (const [key, record] of Object.entries((await this.data()).folders)) {
      if (record.plans.some(match)) return { key, record }
    }
    return null
  }

  /** Os planos da pasta com os envios lidos agora; `null` sem banco (nada se decide nem se poda). */
  async views(key: string): Promise<PlanView[] | null> {
    const repo = this.deps.repository()
    const record = (await this.data()).folders[key]
    if (!repo || !record) return null
    try {
      const byConv = new Map<string, HandoffEnvio[]>()
      for (const plan of record.plans) {
        if (!byConv.has(plan.conversationId)) byConv.set(plan.conversationId, await repo.listHandoffEnvios({ conversationId: plan.conversationId }))
      }
      const conv = new Map(record.plans.map((p) => [p.loteId, p.conversationId]))
      return viewFolder(record.plans, (loteId) => (byConv.get(conv.get(loteId) ?? '') ?? []).filter((e) => e.loteId === loteId))
    } catch (err) {
      this.deps.log?.(`[fila do projeto] não consegui ler os envios: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  async snapshot(): Promise<HandoffProjectSnapshot> {
    const folders: HandoffProjectFolder[] = []
    for (const [key, record] of Object.entries((await this.data()).folders)) {
      const views = (await this.views(key)) ?? []
      const plans = views.map(
        (v, i): HandoffProjectPlan => ({
          loteId: v.plan.loteId,
          conversationId: v.plan.conversationId,
          planTitulo: v.plan.planTitulo,
          posicao: i + 1,
          estado: v.state as HandoffProjectPlan['estado'],
          comecou: v.started,
          comecarMesmoAssim: v.plan.startAnyway?.by ?? null,
          arquivosDoAnterior: v.plan.dirtyFromPrevious?.files ?? [],
          sujo: this.dirtyCount.get(v.plan.loteId) ?? null,
          restanteMin: remainingMinutes(v.envios)
        })
      )
      const { signature: _s, ...evaluation } = record.evaluation ?? { signature: '' }
      const { texto: _t, ...reply } = record.reply ?? { texto: '' }
      folders.push({
        key,
        cwd: record.cwd,
        plans,
        implantacaoEmCurso: !!views[0]?.started,
        avaliacao: record.evaluation ? (evaluation as HandoffProjectFolder['avaliacao']) : null,
        avaliando: this.judge.evaluating(key),
        resposta: record.reply ? (reply as HandoffProjectFolder['resposta']) : null
      })
    }
    return { caseInsensitive: this.caseInsensitive, folders }
  }

  private async publish(): Promise<void> {
    try {
      this.deps.publish(await this.snapshot())
    } catch (err) {
      this.deps.log?.(`[fila do projeto] foto falhou: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // -------------------------------------------------------------------------
  // O registro, o gate e a leitura da faixa
  // -------------------------------------------------------------------------

  /** Um "Enviar para implementação" registrado neste PC: o plano entra no fim da fila da pasta. */
  async addPlan(envios: readonly HandoffEnvio[]): Promise<void> {
    const first = envios[0]
    if (!first) return
    const key = this.key(first.projectCwd)
    await this.deps.store.update((data) => {
      const record = (data.folders[key] ??= { cwd: first.projectCwd, plans: [] })
      if (record.plans.some((p) => p.loteId === first.loteId)) return
      record.plans.push({ loteId: first.loteId, conversationId: first.conversationId, planTitulo: first.planTitulo, addedAt: iso(this.now()) })
    })
    await this.touched(key)
  }

  private async locateConversation(conversationId: string, envios: readonly HandoffEnvio[]): Promise<(Located & { loteId: string }) | null> {
    const loteId = (queuedEnvios(envios)[0] ?? currentEnvio(envios))?.loteId
    if (!loteId) return null
    const located = await this.locate((p) => p.loteId === loteId && p.conversationId === conversationId)
    return located ? { ...located, loteId } : null
  }

  /** O gate de uma conversa de implantação (o despachante pergunta antes de soltar um prompt). */
  async gate(conversationId: string, envios: readonly HandoffEnvio[], force = false): Promise<HandoffQueueDecision> {
    const located = await this.locateConversation(conversationId, envios)
    if (!located) return decideQueue(envios, { force })
    const views = await this.views(located.key)
    if (!views) return { kind: 'none' }
    const step = projectStep(views, located.loteId, { force })
    if (step.kind === 'decided') return step.decision
    // "Começar mesmo assim" (o plano) ou "Enviar mesmo assim" (o prompt, `force`): o usuário já decidiu, a pasta suja não segura.
    const dirty = step.view.plan.startAnyway || force ? null : await this.deps.git.dirty(located.record.cwd)
    const decision = startDecision(step.view, step.first, dirty)
    const before = this.dirtyCount.get(located.loteId)
    if (decision.kind === 'hold' && dirty) this.dirtyCount.set(located.loteId, dirty.length)
    else this.dirtyCount.delete(located.loteId)
    if (before !== this.dirtyCount.get(located.loteId)) await this.publish()
    return decision
  }

  /**
   * A mesma decisão, para a faixa "Próximos prompts" — sem rodar o git: o plano
   * que espera a pasta limpa mostra a última contagem conhecida. `estado`:
   * `esperando` (a vez é de outro plano), `parada` (a pasta suja segura) ou
   * `null` (a regra da fila do quadro decide).
   */
  async describe(conversationId: string, envios: readonly HandoffEnvio[]): Promise<ProjectDescription> {
    const located = await this.locateConversation(conversationId, envios)
    if (!located) return { decision: decideQueue(envios), posicao: null, estado: null }
    const views = (await this.views(located.key)) ?? []
    const index = views.findIndex((v) => v.plan.loteId === located.loteId)
    const step = projectStep(views, located.loteId)
    const posicao = index >= 0 ? index + 1 : null
    if (step.kind === 'decided') {
      const otherTurn = index > 0 || views.some((v, i) => i !== index && v.state === 'rodando')
      return { decision: step.decision, posicao, estado: step.decision.kind === 'hold' && otherTurn ? 'esperando' : null }
    }
    const dirty = this.dirtyCount.get(located.loteId)
    if (dirty && !step.view.plan.startAnyway) {
      return { decision: { kind: 'hold', envio: queuedPrompt(step.first), motivo: dirtyReason(dirty) }, posicao, estado: 'parada' }
    }
    return { decision: { kind: 'next', envio: queuedPrompt(step.first) }, posicao, estado: null }
  }

  // -------------------------------------------------------------------------
  // O acompanhamento mudou: poda, cancela, avisa
  // -------------------------------------------------------------------------

  /** Um envio da conversa mudou (o tracker escreveu): a pasta dela é revista em seguida. */
  changed(conversationId: string): void {
    void this.locate((p) => p.conversationId === conversationId).then((located) => {
      if (!located) return
      const key = located.key
      const old = this.pending.get(key)
      if (old) clearTimeout(old)
      const timer = setTimeout(() => {
        this.pending.delete(key)
        void this.refresh(key)
      }, this.deps.debounceMs ?? 250)
      timer.unref?.()
      this.pending.set(key, timer)
    })
  }

  /** Revê a pasta: tira os planos terminados, consome a resposta que saiu, cancela a avaliação vencida. */
  async refresh(key: string): Promise<void> {
    const views = await this.views(key)
    if (!views) return
    const live = new Set(views.map((v) => v.plan.loteId))
    this.judge.observe(key, views)
    await this.deps.store.update((data) => {
      const record = data.folders[key]
      if (!record) return
      record.plans = record.plans.filter((p) => live.has(p.loteId))
      const reply = record.reply
      if (reply) {
        // Solta: o A roda, ou tem a vez com ninguém mais rodando — a fila do chat dele sai.
        const index = views.findIndex((v) => v.plan.conversationId === reply.conversationId)
        const others = views.some((v, i) => i !== index && v.state === 'rodando')
        if (index < 0 || views[index].state === 'rodando' || (index === 0 && !others)) delete record.reply
      }
    })
    // Só avisa quando a fila mudou de verdade (a contagem de tempo do turno não muda nada).
    const signature = views.map((v) => `${v.plan.loteId}:${v.state}:${currentEnvio(v.envios)?.id ?? ''}`).join('|')
    if (this.signatures.get(key) === signature) return
    this.signatures.set(key, signature)
    for (const view of views) this.deps.notify(view.plan.conversationId)
    await this.publish()
  }

  /** Mudança feita aqui (ação, decisão): revê e avisa sempre. */
  private async touched(key: string): Promise<void> {
    this.signatures.delete(key)
    await this.refresh(key)
    await this.publish()
  }

  // -------------------------------------------------------------------------
  // As ações do usuário (ele vence sempre)
  // -------------------------------------------------------------------------

  async action(conversationId: string, acao: HandoffProjectAction): Promise<{ ok: true } | { ok: false; message: string }> {
    const located = await this.locate((p) => p.conversationId === conversationId)
    if (!located) return { ok: false, message: 'Esta conversa não está na fila do projeto.' }
    const { key } = located
    const views = await this.views(key)
    if (!views) return { ok: false, message: 'O banco está indisponível agora.' }
    const view = views.find((v) => v.plan.conversationId === conversationId)
    if (!view) return { ok: false, message: 'Este plano já terminou.' }
    const lote = view.plan.loteId
    const at = iso(this.now())
    if (acao === 'retomar_a' || acao === 'esperar_b') {
      this.judge.cancel(key, 'resposta')
      const retomar = acao === 'retomar_a'
      await this.judge.applyReply(key, conversationId, retomar ? 'RETOMAR_A' : 'ESPERAR_B', 'escolha sua', null, true)
    } else {
      this.judge.cancel(key)
      if (acao === 'comecar') this.dirtyCount.delete(lote)
      await this.deps.store.update((data) => {
        const record = data.folders[key]
        if (!record) return
        if (acao === 'passar') {
          record.plans = passTurn(record.plans, views, lote)
          return
        }
        record.plans = moveTo(record.plans, lote, 0)
        if (acao === 'comecar') {
          const plan = record.plans.find((p) => p.loteId === lote)
          if (plan) plan.startAnyway = { by: 'usuario', at }
          return
        }
        // "Enviar agora mesmo assim": a resposta guardada sai já, mesmo com o outro rodando.
        const texto = record.reply?.conversationId === conversationId ? record.reply.texto : ''
        record.reply = { conversationId, at, estado: 'agora', motivo: 'você mandou sair agora', pergunta: null, por: 'usuario', texto }
      })
    }
    await this.touched(key)
    return { ok: true }
  }

  /**
   * O usuário escreveu no A enquanto outro plano tem a vez (ou ainda roda): a
   * mensagem fica guardada na fila do chat e, com o B na vez, o PO decide.
   * `stored: false` = a conversa está livre e a mensagem pode sair.
   */
  async reply(conversationId: string, texto: string): Promise<{ stored: boolean }> {
    const located = await this.locate((p) => p.conversationId === conversationId)
    if (!located) return { stored: false }
    const { key, record } = located
    const views = await this.views(key)
    const index = views ? views.findIndex((v) => v.plan.conversationId === conversationId) : -1
    if (!views || index < 0 || !views[index].started) return { stored: false }
    const otherRunning = views.some((v, i) => i !== index && v.state === 'rodando')
    if (index === 0 && !otherRunning) return { stored: false }
    if (record.reply?.conversationId === conversationId && record.reply.estado === 'agora') return { stored: false }
    // Já há uma resposta guardada nesta pasta: esta espera junto, sem outra decisão.
    if (record.reply) return { stored: true }
    // O A já tem a vez (RETOMAR_A) e só espera o prompt atual do B: nada a decidir.
    const deciding = index > 0
    await this.deps.store.update((data) => {
      const target = data.folders[key]
      if (target) target.reply = { conversationId, at: iso(this.now()), estado: deciding ? 'decidindo' : 'retomar_a', motivo: null, pergunta: null, por: null, texto }
    })
    if (deciding) this.judge.decideReply(key, record.cwd, views[index], views[0], texto)
    else this.judge.cancel(key, 'vez')
    await this.publish()
    return { stored: true }
  }

  /** A faixa: arrastar planos inteiros. Os de fora da lista ficam no fim, na ordem de antes. */
  async reorder(projectCwd: string, loteIds: readonly string[]): Promise<{ ok: true } | { ok: false; message: string }> {
    const key = this.key(projectCwd)
    if (!(await this.data()).folders[key]) return { ok: false, message: 'Esta pasta não tem fila de planos.' }
    this.judge.cancel(key, 'vez')
    await this.deps.store.update((data) => {
      const record = data.folders[key]
      if (!record) return
      const rank = new Map(loteIds.map((id, i) => [id, i]))
      record.plans = [...record.plans].sort((a, b) => (rank.get(a.loteId) ?? Infinity) - (rank.get(b.loteId) ?? Infinity))
    })
    await this.touched(key)
    return { ok: true }
  }

  /** O que a pasta do plano tem sem commit (o "Passar a vez" mostra antes). `null` sem git. */
  async dirtyFiles(conversationId: string): Promise<string[] | null> {
    const located = await this.locate((p) => p.conversationId === conversationId)
    return located ? this.deps.git.dirty(located.record.cwd) : null
  }

  // -------------------------------------------------------------------------
  // O vigia
  // -------------------------------------------------------------------------

  async tick(): Promise<void> {
    await this.judge.tick(await this.data())
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.deps.tickMs ?? 60_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    this.judge.cancelAll()
  }
}
