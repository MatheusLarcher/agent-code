import type { HandoffEnvio } from '../../shared/handoffTracking'
import type { BoardItem } from '../../shared/ipc'
import type { HandoffEntregaPatch, HandoffEnvioPatch, HandoffRepository } from '../persistence/types'
import * as deadline from './handoffDeadline'
import * as rules from './handoffRules'
import type { ConvState, SeenSend } from './handoffState'

/**
 * Os jobs do acompanhamento: o que lê e grava no banco. Rodam SEMPRE na fila
 * da conversa (HandoffTracker.exclusive) — nunca dois ao mesmo tempo na mesma
 * conversa —, então cada um relê os envios e decide sobre a leitura fresca. As
 * decisões são de handoffRules.ts; aqui só a ordem de leitura e escrita.
 */

/** O que o acompanhamento lê do Quadro (o BoardService real cumpre). */
export interface HandoffBoard {
  list(cwd: string, options: { conversationId?: string }): Promise<BoardItem[] | null>
  /** Fila de escrita do snapshot (`task-list`) da conversa. */
  settled(convId: string): Promise<void>
  /** Fechamento do turno (espera o PO até o teto dele). */
  turnClosed(convId: string): Promise<void>
}

export interface HandoffJobContext {
  repo(): HandoffRepository | null
  board: HandoffBoard
  now(): number
  poEnabled(): boolean
  /** Avisa a tela (handoff:changed). */
  changed(convId: string): void
  state(convId: string): ConvState | undefined
  stallMs: number
}

export interface HandoffCorrection {
  entregaId: string
  acao: rules.HandoffCorrecao
  motivo?: string
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

export class HandoffJobs {
  constructor(private readonly ctx: HandoffJobContext) {}

  async currentEnvio(convId: string): Promise<HandoffEnvio | null> {
    const repo = this.ctx.repo()
    return repo ? rules.currentEnvio(await this.load(repo, convId)) : null
  }

  async turnStart(convId: string, at: number): Promise<void> {
    const repo = this.ctx.repo()
    if (!repo) return
    const current = rules.currentEnvio(await this.load(repo, convId))
    if (!current) return
    const pending = (this.ctx.state(convId)?.pending.size ?? 0) > 0
    await this.writeEnvio(repo, convId, current, rules.turnStartPatch(current, iso(at), pending))
  }

  async result(convId: string, at: number, turnError: string | null): Promise<void> {
    // O fechamento de turno do Quadro (que já espera o PO) vem antes: é depois
    // dele que o cartão diz o que ficou feito.
    await this.ctx.board.turnClosed(convId)
    const repo = this.ctx.repo()
    if (!repo) return
    const loaded = await this.load(repo, convId)
    if (!rules.currentEnvio(loaded)) return
    const cards = (await this.cards(convId)) ?? []
    const { envios } = await this.syncCards(repo, convId, loaded, cards)
    const current = rules.currentEnvio(envios)
    if (!current || current.status === 'concluida') return
    const outcome = rules.turnEndOutcome(current, cards, { now: iso(at), turnError })
    for (const { id, patch } of outcome.entregas) await repo.updateHandoffEntrega(id, patch)
    await this.writeEnvio(repo, convId, current, outcome.envio)
  }

  async error(convId: string, text: string, recoverable: boolean): Promise<void> {
    const repo = this.ctx.repo()
    if (!repo) return
    const current = rules.currentEnvio(await this.load(repo, convId))
    if (!current) return
    // O que o app retoma sozinho não é falha: o status fica (só sai de
    // "aguardando você", porque as pendências morreram com o turno).
    const patch = recoverable ? rules.permissionPatch(current, false) : rules.errorPatch(current, text)
    await this.writeEnvio(repo, convId, current, patch)
  }

  /** Pergunta aberta ↔ rodando, pelo estado de AGORA (o job pode ter esperado). */
  async permission(convId: string): Promise<void> {
    const repo = this.ctx.repo()
    if (!repo) return
    const current = rules.currentEnvio(await this.load(repo, convId))
    if (!current) return
    const pending = (this.ctx.state(convId)?.pending.size ?? 0) > 0
    await this.writeEnvio(repo, convId, current, rules.permissionPatch(current, pending))
  }

  /**
   * Casa textos vistos no agent:send com os envios que esperam na fila.
   * `only` (o agent:send): só aquele texto, e o turno dele ainda vai começar —
   * o turn-start entra na fila DEPOIS deste job. `null` (o registro chegou):
   * todo texto ainda não casado, e o turno dele pode já estar rodando.
   */
  async matchSent(convId: string, only: SeenSend | null): Promise<void> {
    const s = this.ctx.state(convId)
    const repo = this.ctx.repo()
    const candidates = only ? [only] : (s?.seen ?? [])
    if (!s || !repo || !candidates.some((seen) => !seen.used)) return
    let envios = await this.load(repo, convId)
    const oldest = this.ctx.now() - this.ctx.stallMs
    let wrote = false
    for (const seen of candidates) {
      if (seen.used || seen.at < oldest) continue
      const envio = rules.envioForHash(envios, seen.hash)
      if (!envio) continue
      seen.used = true
      const patch: HandoffEnvioPatch = { status: 'enviado', enviadoEm: iso(seen.at), motivo: null }
      // Registro atrasado: o turno do prompt já pode estar rodando.
      if (!only && s.turnRunning) {
        patch.status = s.pending.size > 0 ? 'aguardando_voce' : 'em_execucao'
        patch.iniciadoEm = iso(s.turnStartedAt ?? seen.at)
      }
      const updated = await repo.updateHandoffEnvio(envio.id, patch)
      envios = envios.map((e) => (e.id === updated.id ? updated : e))
      wrote = true
    }
    if (!wrote) return
    this.ctx.changed(convId)
    if (s.carryMs > 0) await this.addTime(convId, 0, envios)
  }

  /** Releitura dos cartões da conversa (task-list, mudança no Quadro). */
  async refreshCards(convId: string): Promise<void> {
    const s = this.ctx.state(convId)
    const repo = this.ctx.repo()
    if (!s || !repo) return
    await this.ctx.board.settled(convId)
    const loaded = await this.load(repo, convId)
    if (loaded.length === 0) return
    const cards = await this.cards(convId)
    if (!cards) return
    const { envios, completedNow } = await this.syncCards(repo, convId, loaded, cards)
    const current = rules.currentEnvio(envios)
    for (const envio of envios) {
      const patch = rules.incompleteRefresh(envio, cards, {
        now: iso(this.ctx.now()),
        completedNow: completedNow.has(envio.id),
        // O turno rodando é do envio corrente; o incompleto anterior pode concluir.
        turnRunning: envio.id === current?.id && s.turnRunning
      })
      await this.writeEnvio(repo, convId, envio, patch)
    }
  }

  /** Grava `ms` de tempo ativo (+ o que esperava um envio corrente). */
  async addTime(convId: string, ms: number, loaded?: readonly HandoffEnvio[]): Promise<void> {
    const s = this.ctx.state(convId)
    if (!s || ms + s.carryMs <= 0) return
    const repo = this.ctx.repo()
    if (!repo) return
    const total = ms + s.carryMs
    const current = rules.currentEnvio(loaded ?? (await this.load(repo, convId)))
    if (!current) {
      // Registro atrasado: o turno do 1º prompt pode começar antes de o envio
      // existir. O tempo espera por ele em vez de se perder.
      s.carryMs = total
      return
    }
    s.carryMs = 0
    const add = rules.timeDistribution(current, total, s.cardInProgress)
    if (!add) return
    await repo.addHandoffTime(add)
    try {
      // O prazo: o envio lido + a fatia que acabou de entrar, sem reler o banco.
      await this.writeDeadline(repo, current.id, deadline.lateMarks(deadline.withTimeAdded(current, add)), null)
    } catch {
      // Engolida de propósito: quem chama encadeia o fim do turno depois desta
      // gravação, e a marca de atraso não pode impedi-lo. Ela se refaz sozinha na
      // próxima gravação de tempo (lateMarks recalcula a partir do envio lido).
    } finally {
      this.ctx.changed(convId)
    }
  }

  /**
   * O aviso de prazo ao agente (hook PostToolUse): decide sobre o envio corrente
   * lido AGORA mais o tempo ativo ainda não gravado (`unflushedMs`, distribuído
   * como a próxima gravação o distribuiria) e grava o marco ANTES de devolver o
   * texto — uma vez por marco. A marca de atraso vai na mesma passada, para o
   * toast do usuário sair junto. Guarda em `noticeAt` até quando não há o que
   * reler.
   */
  async deadlineNotice(convId: string, unflushedMs: number): Promise<string | null> {
    const s = this.ctx.state(convId)
    const repo = this.ctx.repo()
    if (!s || !repo) return null
    const loaded = rules.currentEnvio(await this.load(repo, convId))
    const at = this.ctx.now()
    if (!loaded) {
      s.noticeAt = Infinity
      return null
    }
    const envio = deadline.withTimeAdded(loaded, rules.timeDistribution(loaded, unflushedMs, s.cardInProgress))
    const notice = deadline.deadlineNoticeFor(envio, iso(at))
    if (await this.writeDeadline(repo, envio.id, deadline.lateMarks(envio), notice)) this.ctx.changed(convId)
    // Depois da escrita: o `changed` dela zera o `noticeAt`.
    const next = deadline.msToNextMark(deadline.withNotice(envio, notice))
    s.noticeAt = next === null ? Infinity : at + next
    return notice?.text ?? null
  }

  /** Marca `parada` o que passou do limite sem turno (contado desde a última
   *  atividade da CONVERSA — a deste processo e a escrita mais recente em
   *  qualquer envio dela —, nunca antes de `notBefore`, o início do tracker). */
  async markStalled(convId: string, notBefore: number): Promise<number> {
    const s = this.ctx.state(convId)
    const repo = this.ctx.repo()
    if (!s || !repo || s.turnRunning || s.pending.size > 0) return 0
    const envios = await this.load(repo, convId)
    const lastActivityMs = Math.max(s.lastActivity, notBefore, rules.conversationLastWriteMs(envios))
    const stall = { turnRunning: false, pending: false, lastActivityMs, now: this.ctx.now(), limitMs: this.ctx.stallMs }
    let stalled = 0
    let open = 0
    for (const envio of envios) {
      const motivo = rules.stallReason(envio, stall)
      if (motivo) {
        await repo.updateHandoffEnvio(envio.id, { status: 'parada', motivo })
        stalled++
      } else if (rules.isStallable(envio.status)) {
        open++
      }
    }
    if (stalled > 0) this.ctx.changed(convId)
    // Nada que possa parar: só volta a olhar quando houver atividade nova.
    if (open === 0) s.dormantAt = s.lastActivity
    return stalled
  }

  /** A correção do usuário (a entrega já leva a marca `corrigido_por`). */
  async correct(convId: string, envioId: string, req: HandoffCorrection, at: string): Promise<HandoffEnvio> {
    const repo = this.ctx.repo()
    if (!repo) throw new Error('O banco está indisponível agora.')
    const [envio] = await repo.listHandoffEnvios({ ids: [envioId] })
    const entrega = envio?.entregas.find((e) => e.id === req.entregaId)
    if (!envio || !entrega) throw new Error('Entrega não encontrada.')
    let updated = await repo.updateHandoffEntrega(entrega.id, rules.correctionPatch(entrega, req.acao, req.motivo, at))
    const cards = (await this.cards(convId, this.ctx.state(convId)?.cwd || updated.projectCwd)) ?? []
    const patch = rules.envioAfterCorrection(updated, req.acao, cards, at)
    if (patch) updated = await repo.updateHandoffEnvio(updated.id, patch)
    this.ctx.changed(convId)
    return updated
  }

  /** As entregas de todo envio não concluído da conversa acompanham os cartões. */
  private async syncCards(
    repo: HandoffRepository,
    convId: string,
    loaded: readonly HandoffEnvio[],
    cards: readonly BoardItem[]
  ): Promise<{ envios: HandoffEnvio[]; completedNow: Set<string> }> {
    const sync = { now: iso(this.ctx.now()), poEnabled: this.ctx.poEnabled() }
    const completedNow = new Set<string>()
    const envios: HandoffEnvio[] = []
    let wrote = false
    for (let envio of loaded) {
      if (envio.status !== 'concluida') {
        for (const { id, patch } of rules.syncEntregas(envio, cards, sync)) {
          envio = await repo.updateHandoffEntrega(id, patch)
          if (patch.status === 'concluida') completedNow.add(envio.id)
          wrote = true
        }
      }
      envios.push(envio)
    }
    const s = this.ctx.state(convId)
    const current = rules.currentEnvio(envios)
    if (s) s.cardInProgress = new Set(current ? rules.entregasWithCardInProgress(current, cards) : [])
    if (wrote) this.ctx.changed(convId)
    return { envios, completedNow }
  }

  private async load(repo: HandoffRepository, convId: string): Promise<HandoffEnvio[]> {
    const envios = await repo.listHandoffEnvios({ conversationId: convId })
    const s = this.ctx.state(convId)
    if (s && !s.projectId && envios[0]) s.projectId = envios[0].projectId
    return envios
  }

  /** Os cartões da conversa; `null` = Quadro indisponível. */
  private async cards(convId: string, cwd?: string): Promise<BoardItem[] | null> {
    const dir = cwd ?? this.ctx.state(convId)?.cwd
    if (!dir) return null
    const items = await this.ctx.board.list(dir, { conversationId: convId })
    return items ? items.filter((card) => card.conversationId === convId) : null
  }

  /**
   * Grava o prazo (marcas de atraso e o marco do aviso). O envio primeiro e a
   * entrega do aviso por ÚLTIMO: se algo falhar antes, o marco não fica gravado
   * e o aviso volta na próxima ferramenta — nunca é dado como enviado sem ter
   * saído. Devolve se gravou algo.
   */
  private async writeDeadline(
    repo: HandoffRepository,
    envioId: string,
    marks: deadline.LateMarks,
    notice: deadline.DeadlineNotice | null
  ): Promise<boolean> {
    const patches = new Map<string, HandoffEntregaPatch>()
    for (const { id, patch } of marks.entregas) patches.set(id, patch)
    if (notice) {
      const merged = { ...patches.get(notice.entregaId), ...notice.patch }
      patches.delete(notice.entregaId)
      patches.set(notice.entregaId, merged)
    }
    if (marks.envio) await repo.updateHandoffEnvio(envioId, marks.envio)
    for (const [id, patch] of patches) await repo.updateHandoffEntrega(id, patch)
    return marks.envio !== null || patches.size > 0
  }

  private async writeEnvio(
    repo: HandoffRepository,
    convId: string,
    envio: HandoffEnvio,
    patch: HandoffEnvioPatch | null
  ): Promise<void> {
    if (!patch) return
    await repo.updateHandoffEnvio(envio.id, patch)
    this.ctx.changed(convId)
  }
}
