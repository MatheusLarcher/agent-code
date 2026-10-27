/**
 * O cliente da ponte do PC: pareamento, conexão (LAN × relay), o estado espelhado
 * do `/api/state`, o SSE ao vivo e a conversa aberta. Porta fiel do www/app.js
 * antigo — cada regra abaixo tem um porquê medido no app anterior:
 *
 *  - auto-conexão ao abrir NUNCA toma o lugar de outro celular; só o QR (gesto do
 *    usuário) faz `POST /api/pair` (takeover; o reload da troca de filial o leva
 *    num sinal de uso único, em pcs.ts);
 *  - o pareamento salvo nunca é descartado por erro: tenta de novo com backoff até
 *    o usuário esquecer a filial;
 *  - o SSE cai sem dizer por quê: antes de religar, reavalia LAN × relay e confere
 *    com uma chamada normal, que devolve um status legível (503/401/409);
 *  - `historyReq`: só a resposta MAIS RECENTE do `/api/history` atualiza a tela.
 */
import type { ChatEvent, PermissionResponse, RateLimitStatus } from '@shared/ipc'
import { isProjectColor, type ProjectColorMap } from '@shared/projectColor'
import { HANDOFF_NOTICE_EVENT, handoffNoticeText, isHandoffNotice } from '@shared/handoffNotice'
import type { TarefaVista } from '@shared/tarefas'
import { deviceId, deviceName, configFromLocation, type PairConfig } from './config'
import { ModelHold } from './modelHold'
import { apiUrl, errorText, fetchJson, pickBestBase, statusOf, HttpError, type FetchOpts } from './net'
import { activePc, loadPcs, namePcIfUnnamed, otherPcs, pcConfig, pcLabel, removePc, saveLastConv, setActivePc, setPendingSwitch, takePendingSwitch, upsertPc, type PendingNotice } from './pcs'
import { isSubagentEvent, keepDetails, mergeDetails, reduce, STATE_ONLY, syncQueued } from './reducer'
import { createStore, type Store } from './store'
import type { BridgeEvent, ChatMsg, ConvSummary, FileAttachment, HistoryResponse, ImageAttachment, ModelOption, SearchResult, StateResponse, ToastTipo } from './types'
import { setVocabulary } from '../voice/vocabulary'

export const CENTRAL_CONV_ID = 'central'
/** Avisos do escritório na ponte (officeCallsBridge): fase 2, o chat ignora. */
const OFFICE_CONV_ID = 'office'
const POLL_MS = 4000
/** Uma página do histórico (as últimas, e cada "carregar anteriores"); a ressincronização em silêncio pede até HISTORY_REFRESH_MAX para não encolher o que já está na tela. */
export const HISTORY_PAGE = 50
const HISTORY_REFRESH_MAX = 200

export type Screen = 'boot' | 'pair' | 'pairing' | 'blocked' | 'main'

export interface AppState {
  screen: Screen
  pairingDetail: string
  pairingStatus: string
  blockedName: string
  online: boolean
  /** Faixa "reconectando…" (null = escondida). */
  reconnectText: string | null
  base: string
  token: string
  /** Já houve um `/api/state` com sucesso nesta sessão. */
  loaded: boolean
  conversations: ConvSummary[]
  projects: string[]
  usage: Record<string, RateLimitStatus>
  /** Cor fixa de cada projeto por cwd (`/api/state`): acumula, a ponte só manda as já resolvidas. */
  projectColors?: ProjectColorMap
  /** Tarefas agendadas visíveis (`/api/state`; o aviso `tarefasChanged` do SSE adianta). */
  tarefas: TarefaVista[]
  voiceReady: boolean
  skipPerms: boolean
  models: ModelOption[]
  modelEffort: Record<string, string[]>
  effortLabels: Record<string, string>
  convId: string | null
  messages: ChatMsg[]
  historyLoading: boolean
  /** Há mensagens mais antigas que a primeira da tela (o botão "carregar anteriores" no topo). */
  hasOlder: boolean
  olderLoading: boolean
  /** A tela mostra uma janela do mapa de perguntas e há mensagens depois dela ("ir para o final" recarrega as últimas). */
  hasNewer: boolean
  /** Ids (ferramenta/pensamento) cujo detalhe inteiro falhou ao carregar: a tela oferece tentar de novo. */
  detailsFailed: ReadonlySet<string>
  /** Mensagem a centralizar quando o histórico carregar (busca, mapa de perguntas, Central). */
  scrollToMsg: string | null
}

export interface ClientOptions {
  /** Qual conversa abrir ao conectar (a navegação guarda a última). */
  pickInitialConv: (conversations: ConvSummary[]) => string | null
  /** Recarrega o app — trocar de filial zera SSE, timers, Central e Escritório. Padrão: window.location.reload(). Injetável nos testes. */
  reload?: () => void
  /** Aviso curto com tipo (o toast do app). */
  notify?: (text: string, tipo?: ToastTipo) => void
  /** Cada vez que conecta ao PC (abrir o app, parear, voltar a conexão): o push registra o token. */
  onConnected?: () => void
}

export interface SendInput {
  text: string
  images: ImageAttachment[]
  files: FileAttachment[]
  replyTo?: string | null
}

/** Junta as cores novas (válidas) às já recebidas; a mesma referência se nada mudou (o escritório não refaz à toa). */
export function mergeProjectColors(prev: ProjectColorMap | undefined, next: unknown): ProjectColorMap {
  const base = prev ?? {}
  if (!next || typeof next !== 'object') return base
  let out: ProjectColorMap | null = null
  for (const [cwd, c] of Object.entries(next as Record<string, unknown>)) {
    if (!isProjectColor(c) || (base[cwd]?.hex === c.hex && base[cwd]?.source === c.source)) continue
    out ??= { ...base }
    out[cwd] = { hex: c.hex, source: c.source, ...(c.file ? { file: c.file } : {}) }
  }
  return out ?? base
}

const INITIAL: AppState = {
  screen: 'boot', pairingDetail: '', pairingStatus: '', blockedName: '', online: false, reconnectText: null,
  base: '', token: '', loaded: false, conversations: [], projects: [], usage: {}, tarefas: [], voiceReady: false, skipPerms: false,
  models: [], modelEffort: {}, effortLabels: {}, convId: null, messages: [], historyLoading: false,
  hasOlder: false, olderLoading: false, hasNewer: false, detailsFailed: new Set<string>(), scrollToMsg: null
}

export class RemoteClient {
  readonly store: Store<AppState> = createStore<AppState>({ ...INITIAL })
  private cfg: PairConfig | null = null
  private es: EventSource | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pairingRetry: ReturnType<typeof setTimeout> | null = null
  private otherConvTimer: ReturnType<typeof setTimeout> | null = null
  private pairingAttempt = 0
  private retry = 0
  private failures = 0
  private repicking = false
  private historyReq = 0
  /** Detalhes em voo (`/api/history-details`), por id: o passo aberto e a ferramenta aberta não pedem o mesmo duas vezes. */
  private readonly detailsInFlight = new Set<string>()
  private wakeLock: WakeLockSentinel | null = null
  private announce: PendingNotice[] | null = null // avisos da troca/adição para a 1ª conexão desta carga (null = não veio de uma troca)

  constructor(private readonly opts: ClientOptions) {}

  get state(): AppState {
    return this.store.get()
  }

  /** Abre o app: conecta na filial ativa (a última usada) ou no `/app/?token=` do navegador. */
  start(): void {
    const onResume = (): void => this.onResume()
    document.addEventListener('visibilitychange', onResume)
    window.addEventListener('focus', onResume)
    window.addEventListener('online', onResume)
    const pending = takePendingSwitch() // sempre lido: o sinal nunca sobrevive a uma 2ª carga
    const pc = activePc(loadPcs()) // na 1ª abertura, migra o pareamento do app antigo
    const cfg = pc ? pcConfig(pc) : configFromLocation(window.location)
    if (cfg && cfg.base && cfg.token) {
      this.cfg = cfg
      this.store.set({ base: cfg.base, token: cfg.token })
      const signal = pending && pc && pending.pcId === pc.id ? pending : null // vale só para a filial que ele nomeia
      this.announce = signal ? signal.notices : null
      this.beginPairing(signal?.explicit ?? false)
    } else this.showPair()
  }

  /** QR lido (tela do QR ou "Abrir filial"): salva a filial — ou atualiza base/lan, se o token já está salvo —, ativa e recarrega pareando de forma explícita. */
  addPc(cfg: PairConfig): void {
    if (!cfg.base || !cfg.token) return
    const { pc, existed } = upsertPc(cfg)
    this.activate(pc.id, true, existed ? [{ tipo: 'aviso', text: 'Esta filial já estava salva' }] : [])
  }

  /** "Usar este celular": equivale a escanear o QR de novo. */
  takeover(): void {
    this.beginPairing(true)
  }

  /** Troca para outra filial salva: grava a ativa e recarrega (nada da anterior sobrevive na tela). */
  switchPc(id: string): void {
    this.activate(id, false, [])
  }

  /** Esquece a filial (a tela já pediu confirmação). Era a ativa: vai para a usada mais recentemente; sem nenhuma, tela do QR. `null` = conexão que não é uma filial salva (navegador). */
  forgetPc(id: string | null): void {
    if (id === null) return this.disconnect()
    const before = loadPcs() // o rótulo "PC N" conta a posição na lista de ANTES de remover
    const { removed, wasActive, next } = removePc(id)
    if (!removed) return // já esquecida
    const aviso: PendingNotice = { tipo: 'aviso', text: `Filial ${pcLabel(removed, before)} esquecida` }
    if (wasActive && next) return this.activate(next.id, false, [aviso]) // o aviso sai depois do reload
    if (wasActive) this.disconnect()
    this.opts.notify?.(aviso.text, aviso.tipo)
  }

  /** "Cancelar" em Outro celular pareado: vai para outra filial salva SEM apagar esta; sem outra, tela do QR (também sem apagar — ao reabrir o app, tenta esta de novo). */
  leaveBlocked(): void {
    const other = otherPcs(loadPcs())[0]
    return other ? this.switchPc(other.id) : this.disconnect()
  }

  private activate(id: string, explicit: boolean, notices: PendingNotice[]): void {
    if (!setActivePc(id)) return // toda troca de filial passa por aqui; id desconhecido: nada muda
    setPendingSwitch({ pcId: id, explicit, notices }) // o sinal de uso único, lido UMA vez pela carga seguinte
    this.opts.reload ? this.opts.reload() : window.location.reload()
  }

  private disconnect(): void {
    this.cfg = null
    this.pairingAttempt = 0
    this.announce = null
    this.store.set({ base: '', token: '' })
    this.showPair() // só para de conectar e mostra a tela do QR: nada do que está salvo é apagado
  }

  current(): ConvSummary | null {
    const { conversations, convId } = this.state
    return conversations.find((c) => c.id === convId) ?? null
  }

  // ---- HTTP ------------------------------------------------------------------

  url(path: string): string {
    return apiUrl({ base: this.state.base, token: this.state.token, dev: deviceId(), devName: deviceName() }, path)
  }

  /** Chamada à ponte; 409 = outro celular pareado (a tela própria assume). */
  async request<T>(path: string, opts?: FetchOpts): Promise<T> {
    try {
      return await fetchJson<T>(this.url(path), opts)
    } catch (err) {
      if (statusOf(err) === 409) {
        const body = (err as HttpError).body as { pairedName?: string } | null
        this.onAnotherDevice(body?.pairedName || 'outro celular')
      }
      throw err
    }
  }

  post<T = { ok?: boolean }>(path: string, body: unknown, timeout?: number): Promise<T> {
    return this.request<T>(path, { method: 'POST', body, timeout })
  }

  // ---- estado ------------------------------------------------------------------

  async fetchState(): Promise<StateResponse> {
    let data: StateResponse
    try {
      data = await this.request<StateResponse>('/api/state')
    } catch (err) {
      // Duas falhas seguidas no chat: o endereço em uso pode ter morrido (saímos da
      // Wi‑Fi do PC) — reavalia LAN × relay antes da próxima tentativa.
      this.failures++
      if (this.failures >= 2 && this.state.screen === 'main') void this.repickBase()
      throw err
    }
    this.failures = 0
    // PC antigo não manda a lista: o celular segue com a última que guardou.
    if (Array.isArray(data.vocabulary)) setVocabulary(data.vocabulary)
    const conversations = this.modelHold.apply(Array.isArray(data.conversations) ? data.conversations : [])
    this.store.set((s) => {
      const cur = conversations.find((c) => c.id === s.convId) ?? null
      return {
        loaded: true,
        conversations,
        projects: data.projects ?? [],
        usage: data.usage ?? {},
        projectColors: mergeProjectColors(s.projectColors, data.projectColors),
        tarefas: Array.isArray(data.tarefas) ? data.tarefas : [],
        voiceReady: !!data.voiceReady,
        skipPerms: !!data.skipPerms,
        models: data.models ?? [],
        modelEffort: data.modelEffort ?? {},
        effortLabels: data.effortLabels ?? {},
        messages: s.convId === CENTRAL_CONV_ID ? s.messages : syncQueued(s.messages, cur)
      }
    })
    return data
  }

  /** Reescolhe entre a LAN e o relay; religa o SSE se o endereço mudou. Nunca rejeita. */
  async repickBase(): Promise<string> {
    if (this.repicking || !this.cfg) return this.state.base
    this.repicking = true
    try {
      const base = await pickBestBase(this.cfg.base, this.cfg.lan, this.cfg.token)
      if (base !== this.state.base) {
        this.store.set({ base })
        this.failures = 0
        if (this.state.screen === 'main') this.openEvents()
      }
      return base
    } finally {
      this.repicking = false
    }
  }

  // ---- pareamento ----------------------------------------------------------------

  /** `explicit` = veio de um QR agora: faz `POST /api/pair` (takeover). A auto-conexão nunca toma o lugar de ninguém. */
  private beginPairing(explicit: boolean): void {
    const cfg = this.cfg
    if (!cfg) return this.showPair()
    this.store.set({ screen: 'pairing', blockedName: '', pairingDetail: 'Procurando a ponte do seu PC…', pairingStatus: 'Conectando…' })
    void pickBestBase(cfg.base, cfg.lan, cfg.token).then(async (base) => {
      if (this.cfg !== cfg) return
      this.store.set({ base })
      if (explicit) {
        try {
          await this.post('/api/pair', { deviceId: deviceId(), name: deviceName() })
        } catch (err) {
          if (statusOf(err) === 409) return
        }
      }
      this.attemptPairing()
    })
  }

  /** Tenta o pareamento salvo sem nunca descartá-lo; a tela do QR só volta por ação explícita. */
  private attemptPairing(): void {
    this.clearPairingRetry()
    const cfg = this.cfg
    if (!cfg || this.state.screen !== 'pairing') return
    this.fetchState().then(
      (data) => {
        if (this.cfg !== cfg) return // filial esquecida (ou conexão encerrada) com a resposta em voo: já não vale
        this.pairingAttempt = 0
        this.showConnected(data)
      },
      (err) => {
        if (statusOf(err) === 409 || this.cfg !== cfg) return
        const delay = Math.min(15000, 1000 * Math.pow(2, this.pairingAttempt))
        this.pairingAttempt++
        this.store.set({
          pairingDetail: errorText(err) + ' Vou tentar de novo automaticamente.',
          pairingStatus: `Tentando novamente em ${Math.ceil(delay / 1000)} s…`
        })
        // Cada tentativa reavalia LAN × relay: o celular pode ter trocado de rede.
        this.pairingRetry = setTimeout(() => {
          void pickBestBase(cfg.base, cfg.lan, cfg.token).then((base) => {
            if (this.cfg !== cfg) return
            this.store.set({ base })
            this.attemptPairing()
          })
        }, delay)
      }
    )
  }

  private showConnected(data: StateResponse): void {
    this.clearPairingRetry()
    this.retry = 0
    this.store.set({ screen: 'main', blockedName: '' })
    void this.requestWakeLock()
    const pick = this.opts.pickInitialConv(data.conversations ?? [])
    if (pick) this.selectConv(pick)
    this.openEvents()
    if (this.poll) clearInterval(this.poll)
    this.poll = setInterval(() => void this.fetchState().catch(() => undefined), POLL_MS)
    if (this.cfg) namePcIfUnnamed(this.cfg.token, data.pcName) // nome padrão: o hostname do PC, só se a filial ainda não tem nome
    if (this.announce) {
      const list = loadPcs() // lida depois do nome padrão: a filial nova já sai com o hostname
      const pc = list.pcs.find((p) => p.token === this.cfg?.token)
      for (const n of this.announce) this.opts.notify?.(n.text, n.tipo)
      if (pc) this.opts.notify?.(`Filial ${pcLabel(pc, list)} conectada`, 'sucesso')
      this.announce = null // uma vez só
    }
    try {
      this.opts.onConnected?.()
    } catch {
      /* o gancho não derruba a conexão */
    }
  }

  private showPair(): void {
    this.stopLive()
    this.clearPairingRetry()
    this.releaseWakeLock()
    this.store.set({ screen: 'pair', online: false, reconnectText: null, blockedName: '' })
  }

  /** O PC respondeu 409: outro celular é o pareado. */
  private onAnotherDevice(name: string): void {
    if (this.state.screen === 'blocked') return
    this.stopLive()
    this.clearPairingRetry()
    this.store.set({ screen: 'blocked', blockedName: name, reconnectText: null })
  }

  private stopLive(): void {
    if (this.es) this.es.close()
    this.es = null
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private clearPairingRetry(): void {
    if (this.pairingRetry) clearTimeout(this.pairingRetry)
    this.pairingRetry = null
  }

  // ---- SSE -----------------------------------------------------------------------

  private openEvents(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.es) this.es.close()
    const es = new EventSource(this.url('/api/events'))
    this.es = es
    es.onopen = () => {
      this.retry = 0
      this.store.set({ online: true, reconnectText: null })
      // (Re)conectou: o histórico pode ter mudado offline — ressincroniza em silêncio.
      const id = this.state.convId
      if (id && id !== CENTRAL_CONV_ID) void this.loadHistory(id, true).catch(() => undefined)
    }
    es.onerror = () => {
      this.store.set({ online: false })
      // O EventSource tenta sozinho, mas um stream fechado (ponte reiniciada) precisa
      // de conexão nova — o religamento é nosso, para voltar sempre.
      es.close()
      if (this.es === es) this.es = null
      this.scheduleReconnect()
    }
    es.onmessage = (ev) => {
      let msg: BridgeEvent
      try {
        msg = JSON.parse(ev.data as string) as BridgeEvent
      } catch {
        return
      }
      if (msg && msg.event) this.onEvent(msg)
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.state.screen !== 'main') return
    if (this.state.reconnectText === null) this.store.set({ reconnectText: 'reconectando…' })
    // Backoff exponencial até 8 s — insiste enquanto o app estiver aberto.
    const delay = Math.min(8000, 800 * Math.pow(2, this.retry))
    this.retry++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      const attempt = this.retry
      this.repickBase()
        .then(() => this.fetchState())
        .then(
          () => this.openEvents(),
          (err) => {
            if (statusOf(err) === 409) return
            this.store.set({ reconnectText: 'reconectando… ' + errorText(err) })
            if (attempt === this.retry) this.scheduleReconnect()
          }
        )
    }, delay)
  }

  /** Quem quer ver TODO evento da ponte, de qualquer conversa (o escritório 3D: o que cada agente está fazendo). */
  readonly eventTaps = new Set<(msg: BridgeEvent) => void>()

  private onEvent(msg: BridgeEvent): void {
    for (const tap of this.eventTaps) {
      try {
        tap(msg)
      } catch {
        /* um assinante com defeito não derruba o chat */
      }
    }
    const ev = msg.event as ChatEvent
    if (ev.kind === 'rate-limit') {
      const l = ev.limits
      if (l && l.rateLimitType) this.store.set((s) => ({ usage: { ...s.usage, [l.rateLimitType]: l } }))
      return
    }
    if (ev.kind === 'stall-status') {
      this.patchConv(msg.convId, { stalledSince: ev.stalled ? ev.since : undefined })
      return
    }
    if (ev.kind === 'compacting') {
      this.patchConv(msg.convId, { compactingSince: ev.active ? ev.since : undefined })
      return
    }
    if (ev.kind === 'api-retry') {
      this.patchConv(msg.convId, {
        apiRetry: ev.active ? { attempt: ev.attempt, maxRetries: ev.maxRetries, retryAt: ev.retryAt, status: ev.status, error: ev.error } : undefined
      })
      return
    }
    // Sugestão do próximo prompt (null = começou um turno): só o chip, nunca o feed.
    if (ev.kind === 'prompt-suggestion') {
      this.patchConv(msg.convId, { suggestion: ev.text ?? undefined })
      return
    }
    // Último sinal do CLI (qualquer conversa): a linha ao vivo conta a partir dele (só avança)
    // e sabe se há um bloco de raciocínio aberto (o resumo só chega no fim dele).
    if (ev.kind === 'heartbeat') {
      const cur = this.state.conversations.find((c) => c.id === msg.convId)?.lastSignalAt ?? 0
      this.patchConv(msg.convId, { lastSignalAt: Math.max(cur, ev.lastActivityAt), thinkingSince: ev.thinkingSince ?? undefined })
      return
    }
    if (msg.convId === OFFICE_CONV_ID) {
      // Aviso de handoff (handoffNoticeBridge): só toast, com o app aberto.
      const notice = msg.event as unknown as { kind?: string }
      if (notice.kind === HANDOFF_NOTICE_EVENT && isHandoffNotice(notice)) {
        const title = this.state.conversations.find((c) => c.id === notice.convId)?.title
        this.opts.notify?.(handoffNoticeText(notice, title), 'aviso')
      }
      return
    }
    if (msg.convId !== this.state.convId) {
      // Evento de outra conversa: atualiza a lista (ocupada/título), no máximo 1×/s.
      if (!this.otherConvTimer) {
        this.otherConvTimer = setTimeout(() => {
          this.otherConvTimer = null
          void this.fetchState().catch(() => undefined)
        }, 1000)
      }
      return
    }
    if (isSubagentEvent(ev) || STATE_ONLY.has(ev.kind)) {
      if (ev.kind === 'task-list') void this.fetchState().catch(() => undefined)
      return
    }
    if (msg.convId === CENTRAL_CONV_ID) return
    this.store.set((s) => ({ messages: reduce(s.messages, ev as ChatMsg) }))
    const ended = ev.kind === 'result' || ev.kind === 'error'
    // Saída do modelo também é sinal de vida (no mesmo patch do busy, sem custo extra por delta).
    const output = ev.kind === 'assistant-text' || ev.kind === 'thinking' || ev.kind === 'tool-use' || ev.kind === 'tool-result'
    this.patchConv(msg.convId, output ? { busy: true, lastSignalAt: Date.now() } : { busy: !ended })
    // Uma chamada de ferramenta costuma vir antes de permissão/pergunta/plano: lê já.
    if (ended || ev.kind === 'tool-use') void this.fetchState().catch(() => undefined)
  }

  private patchConv(convId: string, patch: Partial<ConvSummary>): void {
    this.store.set((s) => ({ conversations: s.conversations.map((c) => (c.id === convId ? { ...c, ...patch } : c)) }))
  }

  // ---- conversa aberta ----------------------------------------------------------------

  selectConv(convId: string): void {
    if (convId !== CENTRAL_CONV_ID) saveLastConv(this.state.token, convId)
    const same = convId === this.state.convId
    this.store.set({ convId, ...(same ? {} : { messages: [], hasOlder: false, hasNewer: false, olderLoading: false, detailsFailed: new Set<string>() }) })
    if (convId === CENTRAL_CONV_ID) {
      this.historyReq++
      this.store.set({ historyLoading: false })
      return
    }
    void this.loadHistory(convId, same && this.state.messages.length > 0).catch(() => undefined)
  }

  /**
   * As últimas mensagens da conversa (uma página; a tela mostra "carregar anteriores"
   * enquanto `hasOlder`). `silent`: ressincronização de fundo (pull-to-refresh,
   * reconexão) sem apagar a tela — pede o tanto que já estava nela (até
   * HISTORY_REFRESH_MAX) e guarda o detalhe das respostas já abertas.
   */
  async loadHistory(convId: string, silent = false): Promise<void> {
    const reqId = ++this.historyReq
    if (!silent) this.store.set({ historyLoading: true })
    const shown = silent && convId === this.state.convId ? this.state.messages.length : 0
    const limit = Math.min(HISTORY_REFRESH_MAX, Math.max(HISTORY_PAGE, shown))
    try {
      const data = await this.request<HistoryResponse>(`/api/history?conv=${encodeURIComponent(convId)}&limit=${limit}`)
      if (reqId !== this.historyReq) return // uma chamada mais nova já assumiu a tela
      const cur = this.state.conversations.find((c) => c.id === convId) ?? null
      const prev = convId === this.state.convId ? this.state.messages : []
      this.store.set({
        messages: keepDetails(prev, syncQueued((data.messages ?? []).slice(), cur)),
        historyLoading: false,
        hasOlder: !!data.hasOlder,
        hasNewer: false,
        olderLoading: false
      })
    } catch (err) {
      if (reqId === this.historyReq) this.store.set({ historyLoading: false })
      throw err
    }
  }

  /** "Carregar anteriores": a página antes da primeira mensagem da tela, posta na frente dela. */
  async loadOlder(): Promise<void> {
    const { convId, hasOlder, olderLoading, messages } = this.state
    if (!convId || convId === CENTRAL_CONV_ID || !hasOlder || olderLoading) return
    const before = messages.find((m) => m.id && !(m.kind === 'user' && (m as { queued?: boolean }).queued))?.id
    if (!before) return
    const reqId = this.historyReq // não é uma carga nova da tela: só vale enquanto nenhuma outra assumir
    this.store.set({ olderLoading: true })
    try {
      const data = await this.request<HistoryResponse>(
        `/api/history?conv=${encodeURIComponent(convId)}&limit=${HISTORY_PAGE}&before=${encodeURIComponent(before)}`
      )
      if (reqId !== this.historyReq || this.state.convId !== convId) return
      const older = data.messages ?? []
      this.store.set((s) => ({ messages: older.length ? [...older, ...s.messages] : s.messages, hasOlder: !!data.hasOlder, olderLoading: false }))
    } catch (err) {
      if (reqId === this.historyReq && this.state.convId === convId) this.store.set({ olderLoading: false })
      throw err
    }
  }

  /**
   * O detalhe inteiro (entrada, resultado, pensamento) das mensagens leves de ids
   * dados — o que o PC cortou do histórico. Pedido ao expandir; ignora o que já
   * está inteiro ou em voo. Falhou: os ids ficam em `detailsFailed` (tentar de novo).
   */
  async loadDetails(ids: readonly string[]): Promise<void> {
    const convId = this.state.convId
    if (!convId || convId === CENTRAL_CONV_ID) return
    const light = new Set(this.state.messages.filter((m) => m.light && m.id).map((m) => m.id as string))
    const want = [...new Set(ids)].filter((id) => light.has(id) && !this.detailsInFlight.has(id))
    if (!want.length) return
    for (const id of want) this.detailsInFlight.add(id)
    if (want.some((id) => this.state.detailsFailed.has(id))) {
      this.store.set((s) => ({ detailsFailed: new Set([...s.detailsFailed].filter((id) => !want.includes(id))) }))
    }
    try {
      const data = await this.request<{ messages?: ChatMsg[] }>(
        `/api/history-details?conv=${encodeURIComponent(convId)}&ids=${encodeURIComponent(want.join(','))}`
      )
      if (this.state.convId !== convId) return
      const got = data.messages ?? []
      const missing = want.filter((id) => !got.some((m) => m.id === id))
      this.store.set((s) => ({
        messages: mergeDetails(s.messages, got),
        ...(missing.length ? { detailsFailed: new Set([...s.detailsFailed, ...missing]) } : {})
      }))
    } catch (err) {
      if (this.state.convId === convId) this.store.set((s) => ({ detailsFailed: new Set([...s.detailsFailed, ...want]) }))
      throw err
    } finally {
      for (const id of want) this.detailsInFlight.delete(id)
    }
  }

  /** Vai até uma pergunta do mapa: já carregada, só rola; senão, a janela em volta dela (com "anteriores"/"ir para o final" conforme sobre o quê). */
  async goToMessage(msgId: string): Promise<void> {
    this.store.set({ scrollToMsg: msgId })
    if (this.state.messages.some((m) => m.id === msgId)) return
    const convId = this.state.convId
    if (!convId) return
    const reqId = ++this.historyReq
    try {
      const data = await this.request<HistoryResponse>(
        `/api/history-window?conv=${encodeURIComponent(convId)}&message=${encodeURIComponent(msgId)}`
      )
      if (reqId !== this.historyReq) return
      this.store.set((s) => ({
        messages: keepDetails(s.messages, (data.messages ?? []).slice()),
        hasOlder: !!data.hasOlder,
        hasNewer: !!data.hasNewer,
        olderLoading: false
      }))
    } catch {
      this.store.set({ scrollToMsg: null })
    }
  }

  clearScrollTarget(): void {
    this.store.set({ scrollToMsg: null })
  }

  setScrollTarget(msgId: string | null): void {
    this.store.set({ scrollToMsg: msgId })
  }

  /**
   * Envia para a conversa aberta. Eco otimista (o SSE só traz eventos do agente,
   * então não duplica); na Central o pedido vira bolha "enviando…" no central/.
   * Rejeita com HttpError — quem chama decide a mensagem e devolve o texto ao campo.
   */
  async send(input: SendInput): Promise<void> {
    const convId = this.state.convId
    if (!convId) return
    const central = convId === CENTRAL_CONV_ID
    if (!central) {
      const cur = this.current()
      const echo: ChatMsg = {
        kind: 'user', id: 'u' + Date.now(), text: input.text, ts: Date.now(), queued: !!cur?.busy,
        images: input.images.map((im) => `data:${im.mediaType};base64,${im.data}`),
        files: input.files.map((f) => ({ name: f.name, size: f.size }))
      }
      this.store.set((s) => ({ messages: reduce(s.messages, echo) }))
      this.patchConv(convId, { busy: true })
    }
    const body: Record<string, unknown> = { convId, text: input.text, images: input.images, files: input.files }
    if (central && input.replyTo) body.replyTo = input.replyTo
    try {
      await this.post('/api/send', body, 60000)
    } catch (err) {
      if (statusOf(err) === 0) this.store.set({ online: false })
      throw err
    }
  }

  // ---- ações (o PC confirma no próximo /api/state) ------------------------------------

  interrupt(): Promise<unknown> {
    const convId = this.state.convId
    if (!convId) return Promise.resolve()
    return this.post('/api/interrupt', { convId }).then(() => this.fetchState())
  }

  /** Para UMA tarefa de fundo da conversa aberta (o turno segue); true se o PC confirmou. */
  async stopTask(taskId: string): Promise<boolean> {
    const convId = this.state.convId
    if (!convId) return false
    const r = await this.post('/api/stop-task', { convId, taskId })
    void this.fetchState().catch(() => undefined)
    return r.ok === true
  }

  /** Rápido da conversa aberta (otimista). */
  setMode(mode: 'fast', on: boolean): void {
    const convId = this.state.convId
    if (!convId) return
    this.patchConv(convId, { fastMode: on })
    void this.post('/api/set-mode', { convId, mode, on })
      .then(() => this.fetchState())
      .catch(() => this.fetchState().catch(() => undefined))
  }

  /**
   * Modelo/esforço da conversa aberta (otimista). Com a conversa ocupada também:
   * o PC guarda a troca e ela entra na próxima mensagem da fila, como no seletor
   * dele. Até o retrato do PC trazer o valor novo (ou MODEL_HOLD_MS), um retrato
   * que já estava a caminho não desfaz a escolha na tela.
   */
  setModel(patch: { model?: string; effort?: string }): void {
    const cur = this.current()
    if (!cur || (!patch.model && !patch.effort)) return
    const next: Partial<ConvSummary> = patch.model ? { model: patch.model, effort: undefined } : {}
    if (patch.effort) next.effort = patch.effort
    this.patchConv(cur.id, next)
    this.modelHold.set(cur.id, patch)
    void this.post('/api/set-model', { convId: cur.id, model: patch.model, effort: patch.effort })
      .then(() => this.fetchState())
      .catch(() => {
        // O PC não recebeu: a tela volta ao que ele tem.
        this.modelHold.clear()
        return this.fetchState().catch(() => undefined)
      })
  }

  /** A troca de modelo/esforço ainda não confirmada pelo retrato do PC (core/modelHold). */
  private readonly modelHold = new ModelHold()

  setSkipPerms(on: boolean): void {
    this.store.set({ skipPerms: on })
    void this.post('/api/skip-perms', { on }).catch(() => undefined)
  }

  recoveryAction(action: 'retry' | 'cancel'): void {
    const convId = this.state.convId
    if (!convId) return
    void this.post('/api/recovery', { convId, action })
      .then(() => this.fetchState())
      .catch(() => this.store.set({ online: false }))
  }

  /** Responde permissão/pergunta. `convId` é o da conversa dona do pedido (na Central, a do destino). */
  permissionRespond(convId: string, res: PermissionResponse): Promise<unknown> {
    return this.post('/api/permission-respond', { convId, ...res }).then(() => this.fetchState())
  }

  centralChoose(entryId: string, option: number): Promise<unknown> {
    return this.post('/api/central-choose', { entryId, option })
  }

  /** Criar (num projeto que o PC conhece), renomear ou excluir conversa. */
  async conversationAction(body: { type: 'create'; cwd: string } | { type: 'create'; sandbox: true } | { type: 'rename'; convId: string; title: string } | { type: 'delete'; convId: string }): Promise<string | null> {
    const r = await this.post<{ ok?: boolean; convId?: string; cwd?: string }>('/api/conversation', body)
    if (body.type === 'rename') this.patchConv(body.convId, { title: body.title })
    if (body.type === 'delete') this.store.set((s) => ({ conversations: s.conversations.filter((c) => c.id !== body.convId) }))
    if (body.type === 'create' && r.convId) {
      // No sandbox a pasta nasce no PC: ele devolve qual é.
      const cwd = 'cwd' in body ? body.cwd : r.cwd || ''
      const optimistic: ConvSummary = { id: r.convId, title: 'Nova conversa', cwd, busy: false, connected: false, updatedAt: Date.now(), queued: [] }
      this.store.set((s) => ({ conversations: [optimistic, ...s.conversations] }))
    }
    // O PC aplica de forma assíncrona; um retrato logo depois confirma.
    setTimeout(() => void this.fetchState().catch(() => undefined), 600)
    return r.convId ?? null
  }

  async search(q: string): Promise<SearchResult[]> {
    const data = await this.request<{ results?: SearchResult[] }>(`/api/search?q=${encodeURIComponent(q)}`)
    return data.results ?? []
  }

  /** URL que a ponte serve para baixar um arquivo entregue pelo agente. */
  fileUrl(path: string): string {
    return this.url(`/api/file?path=${encodeURIComponent(path)}`)
  }

  // ---- manter vivo ------------------------------------------------------------------

  private async requestWakeLock(): Promise<void> {
    if (!('wakeLock' in navigator) || this.wakeLock) return
    try {
      const lock = await navigator.wakeLock.request('screen')
      this.wakeLock = lock
      lock.addEventListener('release', () => {
        if (this.wakeLock === lock) this.wakeLock = null
      })
    } catch {
      /* negado / sem suporte */
    }
  }

  private releaseWakeLock(): void {
    if (this.wakeLock) void this.wakeLock.release().catch(() => undefined)
    this.wakeLock = null
  }

  /** Voltou ao primeiro plano: reacende o wake lock e confere o stream (o Android pode tê-lo derrubado). */
  private onResume(): void {
    if (document.visibilityState !== 'visible') return
    const { screen } = this.state
    if (screen === 'pairing') return this.beginPairing(false)
    if (screen !== 'main') return
    void this.requestWakeLock()
    if (!this.es && !this.reconnectTimer) {
      this.openEvents()
      void this.fetchState().catch(() => undefined)
    }
  }
}

export { errorText, statusOf }
