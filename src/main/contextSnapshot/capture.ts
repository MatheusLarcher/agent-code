import type { ContextHistoryRepository, ContextTurnWrite } from '../persistence/types'
import type { PromptContext, RequestContext } from '../promptEnvelope'
import { isAutoModel } from '../../shared/ipc'
import {
  memoryNamesFromBlock,
  type ContextBlock,
  type ContextExactCount,
  type ContextTurnChanged,
  type ContextTurnDetail,
  type ContextUsageSnapshot
} from '../../shared/contextSnapshot'
import {
  finalizeBlock, hookBlocks, imagesBlock, maskText, promptBlocks,
  subagentBlocks, subagentTag, summarizeRequest, usageFromSdk, withTimeout,
  type RawBlock, type SecretValue
} from './blocks'

export interface UsageQuery {
  getContextUsage(options: { detail: 'summary' | 'full' }): Promise<unknown>
}
interface Identity {
  convId: string
  pc: string
  model: string
  provider: ContextTurnWrite['provider']
}
const live = new Map<string, ContextCapture>()
/** O turno mais recente de cada conversa (cópia mascarada). Sobrevive à troca
 *  de sessão — a troca por cota/conta descarta a captura antiga e cria outra —
 *  para a continuação adotar o turno em vez de abrir um novo. */
const lastTurns = new Map<string, ContextTurnWrite>()
const SUMMARY_TIMEOUT = 1500
const EXACT_TIMEOUT = 8000
const CONTINUATION_LABEL = 'Continuação automática'

/** Id de modelo que vale registrar: nunca vazio nem o sentinela do Automático. */
const realModel = (model: string | undefined): string => {
  const id = typeof model === 'string' ? model.trim() : ''
  return id && !isAutoModel(id) ? id : ''
}

/** Sem ChatEvent, sem ponte LAN. A sessão nova substitui a antiga no registro;
 *  dispose tardio da antiga não pode remover a nova. */
export class ContextCapture {
  private secrets: SecretValue[] = []
  private system: ContextBlock | null = null
  private agents: Record<string, { prompt: string }> = {}
  private turns = new Map<string, ContextTurnWrite>()
  /** uuid da mensagem de continuação → turno adotado. */
  private aliases = new Map<string, string>()
  /** Turnos adotados por uma continuação: o contexto do hook entra como tal. */
  private continued = new Set<string>()
  private active: string | null = null
  private pending: string[] = []
  private writes: Promise<void> = Promise.resolve()
  private lastUsage: ContextUsageSnapshot | null = null

  constructor(
    private readonly identity: Identity,
    private readonly repository: ContextHistoryRepository | undefined,
    private readonly changed: ((event: ContextTurnChanged) => void) | undefined,
    private readonly query: () => UsageQuery | null,
    private readonly now: () => number = Date.now
  ) {}

  configure(append: string, secrets: SecretValue[], agents: Record<string, { prompt: string }>): void {
    this.secrets = [...secrets]
    this.agents = agents
    this.system = append ? finalizeBlock({ kind: 'system-append', label: 'System prompt — append do app', text: append }, 'system', this.now(), secrets) : null
    live.set(this.identity.convId, this)
  }

  /** `kind` = AgentMessageKind do envio: 'recovery' continua o último turno. */
  sent(uuid: string, request: string, body: string, parts: PromptContext, cancelNote?: string, imageCount = 0, fallback = false, kind?: string): void {
    live.set(this.identity.convId, this)
    const at = this.now()
    const raw = promptBlocks(body, parts, cancelNote)
    const images = imagesBlock(imageCount, fallback)
    if (images) raw.push(images)
    if (kind === 'recovery' && this.adopt(uuid, raw, at)) return
    const turn: ContextTurnWrite = {
      ...this.identity, model: realModel(this.identity.model), models: [], turnId: uuid, startedAt: at,
      request: summarizeRequest(request, this.secrets), memoriesSent: [], complete: false,
      blocks: [...(this.system ? [this.system] : []), ...raw.map((b) => finalizeBlock(b, 'prompt', at, this.secrets))],
      usage: null, secrets: this.secrets.map((s) => ({ name: s.name, length: s.value.length }))
    }
    this.track(uuid, turn)
  }

  activate(uuid: string): void {
    const id = this.resolve(uuid)
    if (!this.turns.has(id)) return
    // Empurrar outra mensagem ao stream não significa que o CLI começou a
    // processá-la. Os hooks intermediários ainda pertencem ao turno anterior.
    if (this.current() && !this.current()!.complete && this.active !== id) return
    this.active = id
    this.pending = this.pending.filter((p) => p !== id)
  }

  /** Hook de início pode ser disparado sem eco de uuid: entrada já ativada no
   *  push ao SDK; fallback FIFO cobre sessões/testes sem esse push. */
  hook(parts: RequestContext, source: 'hook-start' | 'hook-mid'): void {
    if (!this.active && this.pending[0]) this.activate(this.pending[0])
    const turn = this.current()
    if (!turn || turn.complete) return
    const at = this.now()
    const from = source === 'hook-start' && this.continued.has(turn.turnId) ? 'continuation' : source
    turn.blocks.push(...hookBlocks(parts).map((b) => finalizeBlock(b, from, at, this.secrets)))
    for (const name of memoryNamesFromBlock(parts.memory)) {
      const safe = maskText(name, 'memory-excerpts', this.secrets)
      if (!turn.memoriesSent.includes(safe)) turn.memoriesSent.push(safe)
    }
    this.save(turn)
    // Aviso na hora (sem esperar o banco): a tela mostra "contexto reenviado".
    if (source === 'hook-mid') this.changed?.({ convId: turn.convId, turnId: turn.turnId, resent: true })
  }

  /** Uma resposta do modelo no turno ativo (`node` null = agente principal; senão
   *  o tool-use que abriu o subagente). Só grava no próximo save; avisa a tela
   *  quando entra um (nó, modelo) novo. */
  llmCall(model: string, node: string | null): void {
    const id = realModel(model)
    const turn = this.current()
    if (!id || !turn || turn.complete) return
    const key = node ?? null
    const entry = turn.models.find((m) => m.model === id && m.node === key)
    if (entry) {
      entry.calls += 1
      return
    }
    turn.models.push({ model: id, calls: 1, node: key })
    this.changed?.({ convId: turn.convId, turnId: turn.turnId })
  }

  subagent(toolUseId: string, input: unknown): void {
    const turn = this.current()
    if (!turn || !input || typeof input !== 'object') return
    if (turn.blocks.some((b) => b.source === 'subagent' && b.label.endsWith(subagentTag(toolUseId)))) return
    const i = input as Record<string, unknown>
    const type = typeof i.subagent_type === 'string' ? i.subagent_type : 'agente'
    const request = typeof i.prompt === 'string' ? i.prompt : ''
    turn.blocks.push(...subagentBlocks(toolUseId, type, this.agents[type]?.prompt, request)
      .map((b) => finalizeBlock(b, 'subagent', this.now(), this.secrets)))
    this.save(turn)
  }

  /** Chamado sem await pelo result principal. Captura a query e o turno antes
   *  de qualquer await para a próxima mensagem não roubar o resultado. */
  async finish(ids: string[] | null): Promise<void> {
    const wanted = ids?.length ? [...new Set(ids.map((id) => this.resolve(id)))] : null
    const targets = wanted ? wanted.map((id) => this.turns.get(id)).filter((t): t is ContextTurnWrite => !!t) : [this.current()].filter((t): t is ContextTurnWrite => !!t)
    if (!targets.length) return
    const q = this.query()
    if (targets.some((t) => t.turnId === this.active)) this.active = null
    for (const turn of targets) { turn.complete = true; this.save(turn) }
    if (!q) return
    try {
      const measured = usageFromSdk(await withTimeout(q.getContextUsage({ detail: 'summary' }), SUMMARY_TIMEOUT, 'Contexto'), 'summary', this.now())
      if (!measured) return
      const usage = this.safeUsage(measured)
      this.lastUsage = usage
      for (const turn of targets) { turn.usage = usage; this.save(turn) }
    } catch { console.warn('[context-snapshot] medição de resumo indisponível') }
  }

  async countExact(): Promise<ContextExactCount> {
    if (this.identity.provider !== 'claude') return { ok: false, usage: this.lastUsage, reason: `Contagem exata indisponível na rota ${this.identity.provider}.` }
    const q = this.query()
    if (!q) return { ok: false, usage: this.lastUsage, reason: 'Sessão sem conexão viva com o SDK.' }
    try {
      const measured = usageFromSdk(await withTimeout(q.getContextUsage({ detail: 'full' }), EXACT_TIMEOUT, 'Contagem exata'), 'full', this.now())
      if (!measured) throw new Error('empty')
      return { ok: true, usage: this.safeUsage(measured) }
    } catch { return { ok: false, usage: this.lastUsage, reason: 'O SDK não respondeu à contagem exata. Mostrando o último resumo.' } }
  }

  read(turnId: string, parentToolUseId?: string): ContextTurnDetail | null {
    const turn = this.turns.get(this.resolve(turnId))
    return turn ? filterDetail(detailOf(turn), parentToolUseId) : null
  }

  /**
   * A continuação (troca de sessão por cota/conta, retomada) segue o turno do
   * usuário: mesmo turnId, blocos novos como `continuation`, modelos somados.
   * Sem turno anterior conhecido neste processo, abre turno novo (false).
   */
  private adopt(uuid: string, raw: RawBlock[], at: number): boolean {
    const last = lastTurns.get(this.identity.convId)
    if (!last) return false
    const turn = this.turns.get(last.turnId) ?? structuredClone(last)
    turn.complete = false
    if (this.system && !turn.blocks.some((b) => b.hash === this.system!.hash)) {
      turn.blocks.push({ ...this.system, at, label: `${this.system.label} (sessão nova)` })
    }
    turn.blocks.push(...raw.map((b) => finalizeBlock(b.kind === 'user-request' ? { ...b, label: CONTINUATION_LABEL } : b, 'continuation', at, this.secrets)))
    for (const s of this.secrets) {
      if (!turn.secrets.some((m) => m.name === s.name)) turn.secrets.push({ name: s.name, length: s.value.length })
    }
    this.aliases.set(uuid, turn.turnId)
    this.continued.add(turn.turnId)
    if (this.active === turn.turnId) this.active = null
    this.track(turn.turnId, turn)
    return true
  }

  private track(id: string, turn: ContextTurnWrite): void {
    this.turns.set(id, turn)
    if (!this.pending.includes(id)) this.pending.push(id)
    // Só cópias mascaradas ficam aqui. A fila de entrada é dona dos prompts crus.
    if (this.turns.size > 100) {
      const old = [...this.turns].find(([key, item]) => item.complete && key !== this.active)
      if (old) this.turns.delete(old[0])
    }
    this.save(turn)
  }
  private resolve(id: string): string { return this.aliases.get(id) ?? id }
  private current(): ContextTurnWrite | undefined { return this.active ? this.turns.get(this.active) : undefined }
  private safeUsage(usage: ContextUsageSnapshot): ContextUsageSnapshot {
    return maskStrings(usage, this.secrets)
  }
  private save(turn: ContextTurnWrite): void {
    // Snapshot imutável por escrita; serializa início→hook→fim, mas não bloqueia
    // send/hooks/result nem deixa uma escrita lenta sobrescrever o fim do turno.
    const copy = structuredClone(turn)
    const last = lastTurns.get(copy.convId)
    if (!last || last.turnId === copy.turnId || copy.startedAt >= last.startedAt) lastTurns.set(copy.convId, copy)
    this.writes = this.writes.then(async () => {
      try {
        await this.repository?.saveContextTurn(copy)
        this.changed?.({ convId: copy.convId, turnId: copy.turnId })
      } catch { console.warn('[context-snapshot] histórico indisponível; turno continua') }
    })
  }
  flush(): Promise<void> { return this.writes }
  dispose(): void {
    if (live.get(this.identity.convId) === this) live.delete(this.identity.convId)
  }
}

function maskStrings<T>(value: T, secrets: SecretValue[]): T {
  if (typeof value === 'string') return maskText(value, 'docs', secrets) as T
  if (Array.isArray(value)) return value.map((v) => maskStrings(v, secrets)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskStrings(v, secrets)])) as T
  return value
}
export function detailOf(turn: ContextTurnWrite): ContextTurnDetail {
  return { ...structuredClone(turn), blockCount: turn.blocks.length, totalBytes: turn.blocks.reduce((n, b) => n + b.bytes, 0) }
}
/** Monitor de subagente: só os blocos e os modelos daquele nó. Principal: todos
 *  os modelos (cada um com o nó, para a tela escolher). */
export function filterDetail(detail: ContextTurnDetail, parentToolUseId?: string): ContextTurnDetail {
  const blocks = detail.blocks.filter((b) => parentToolUseId
    ? b.source === 'subagent' && b.label.endsWith(subagentTag(parentToolUseId))
    : b.source !== 'subagent')
  const models = parentToolUseId ? detail.models.filter((m) => m.node === parentToolUseId) : detail.models
  return { ...detail, blocks, models, blockCount: blocks.length, totalBytes: blocks.reduce((n, b) => n + b.bytes, 0) }
}
export function readLiveContext(convId: string, turnId: string, parentToolUseId?: string): ContextTurnDetail | null {
  return live.get(convId)?.read(turnId, parentToolUseId) ?? null
}
export function countLiveContext(convId: string): Promise<ContextExactCount> | null {
  return live.get(convId)?.countExact() ?? null
}
