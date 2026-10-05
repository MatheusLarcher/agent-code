/**
 * O cliente da ponte do PC: pareamento, conexão (LAN × relay), o estado espelhado
 * do `/api/state`, o SSE ao vivo e a conversa aberta. Porta fiel do www/app.js
 * antigo — cada regra abaixo tem um porquê medido no app anterior:
 *
 *  - auto-conexão ao abrir NUNCA toma o lugar de outro celular; só o QR (gesto do
 *    usuário) faz `POST /api/pair` (takeover);
 *  - o pareamento salvo nunca é descartado por erro: tenta de novo com backoff até
 *    o usuário cancelar;
 *  - o SSE cai sem dizer por quê: antes de religar, reavalia LAN × relay e confere
 *    com uma chamada normal, que devolve um status legível (503/401/409);
 *  - `historyReq`: só a resposta MAIS RECENTE do `/api/history` atualiza a tela.
 */
import type { ChatEvent, PermissionResponse, RateLimitStatus } from '@shared/ipc'
import { deviceId, deviceName, loadConfig, configFromLocation, saveConfig, clearConfig, saveLastConv, type PairConfig } from './config'
import { apiUrl, errorText, fetchJson, pickBestBase, statusOf, HttpError, type FetchOpts } from './net'
import { isSubagentEvent, reduce, STATE_ONLY, syncQueued } from './reducer'
import { createStore, type Store } from './store'
import type { BridgeEvent, ChatMsg, ConvSummary, FileAttachment, ImageAttachment, ModelOption, SearchResult, StateResponse } from './types'

export const CENTRAL_CONV_ID = 'central'
/** Avisos do escritório na ponte (officeCallsBridge): fase 2, o chat ignora. */
const OFFICE_CONV_ID = 'office'
const POLL_MS = 4000

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
  voiceReady: boolean
  skipPerms: boolean
  models: ModelOption[]
  modelEffort: Record<string, string[]>
  effortLabels: Record<string, string>
  convId: string | null
  messages: ChatMsg[]
  historyLoading: boolean
  /** Mensagem a centralizar quando o histórico carregar (busca, mapa de perguntas, Central). */
  scrollToMsg: string | null
}

export interface ClientOptions {
  /** Qual conversa abrir ao conectar (a navegação guarda a última). */
  pickInitialConv: (conversations: ConvSummary[]) => string | null
}

export interface SendInput {
  text: string
  images: ImageAttachment[]
  files: FileAttachment[]
  replyTo?: string | null
}

const INITIAL: AppState = {
  screen: 'boot', pairingDetail: '', pairingStatus: '', blockedName: '', online: false, reconnectText: null,
  base: '', token: '', loaded: false, conversations: [], projects: [], usage: {}, voiceReady: false, skipPerms: false,
  models: [], modelEffort: {}, effortLabels: {}, convId: null, messages: [], historyLoading: false, scrollToMsg: null
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
  private wakeLock: WakeLockSentinel | null = null

  constructor(private readonly opts: ClientOptions) {}

  get state(): AppState {
    return this.store.get()
  }

  /** Abre o app: conecta no pareamento salvo (ou no `/app/?token=` do navegador). */
  start(): void {
    const onResume = (): void => this.onResume()
    document.addEventListener('visibilitychange', onResume)
    window.addEventListener('focus', onResume)
    window.addEventListener('online', onResume)
    const cfg = loadConfig() ?? configFromLocation(window.location)
    if (cfg && cfg.base && cfg.token) {
      this.cfg = cfg
      this.store.set({ base: cfg.base, token: cfg.token })
      this.beginPairing(false)
    } else this.showPair()
  }

  /** QR lido agora: pareia ESTE celular no PC (tomando o lugar de outro, se houver). */
  applyConfig(cfg: PairConfig): void {
    this.cfg = cfg
    saveConfig(cfg)
    this.store.set({ base: cfg.base, token: cfg.token })
    this.beginPairing(true)
  }

  /** "Usar este celular": equivale a escanear o QR de novo. */
  takeover(): void {
    this.beginPairing(true)
  }

  /** Sair da conexão / cancelar: apaga o pareamento e volta ao QR. */
  logout(): void {
    clearConfig()
    this.cfg = null
    this.pairingAttempt = 0
    this.store.set({ base: '', token: '' })
    this.showPair()
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
    const conversations = Array.isArray(data.conversations) ? data.conversations : []
    this.store.set((s) => {
      const cur = conversations.find((c) => c.id === s.convId) ?? null
      return {
        loaded: true,
        conversations,
        projects: data.projects ?? [],
        usage: data.usage ?? {},
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

  private onEvent(msg: BridgeEvent): void {
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
    if (msg.convId === OFFICE_CONV_ID) return
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
    this.patchConv(msg.convId, { busy: !ended })
    // Uma chamada de ferramenta costuma vir antes de permissão/pergunta/plano: lê já.
    if (ended || ev.kind === 'tool-use') void this.fetchState().catch(() => undefined)
  }

  private patchConv(convId: string, patch: Partial<ConvSummary>): void {
    this.store.set((s) => ({ conversations: s.conversations.map((c) => (c.id === convId ? { ...c, ...patch } : c)) }))
  }

  // ---- conversa aberta ----------------------------------------------------------------

  selectConv(convId: string): void {
    if (convId !== CENTRAL_CONV_ID) saveLastConv(convId)
    const same = convId === this.state.convId
    this.store.set({ convId, ...(same ? {} : { messages: [] }) })
    if (convId === CENTRAL_CONV_ID) {
      this.historyReq++
      this.store.set({ historyLoading: false })
      return
    }
    void this.loadHistory(convId, same && this.state.messages.length > 0).catch(() => undefined)
  }

  /** `silent`: ressincronização de fundo (pull-to-refresh, reconexão) sem apagar a tela. */
  async loadHistory(convId: string, silent = false): Promise<void> {
    const reqId = ++this.historyReq
    if (!silent) this.store.set({ historyLoading: true })
    try {
      const data = await this.request<{ messages?: ChatMsg[] }>(`/api/history?conv=${encodeURIComponent(convId)}`)
      if (reqId !== this.historyReq) return // uma chamada mais nova já assumiu a tela
      const cur = this.state.conversations.find((c) => c.id === convId) ?? null
      this.store.set({ messages: syncQueued((data.messages ?? []).slice(), cur), historyLoading: false })
    } catch (err) {
      if (reqId === this.historyReq) this.store.set({ historyLoading: false })
      throw err
    }
  }

  /** Vai até uma pergunta do mapa: já carregada, só rola; senão, a janela em volta dela. */
  async goToMessage(msgId: string): Promise<void> {
    this.store.set({ scrollToMsg: msgId })
    if (this.state.messages.some((m) => m.id === msgId)) return
    const convId = this.state.convId
    if (!convId) return
    const reqId = ++this.historyReq
    try {
      const data = await this.request<{ messages?: ChatMsg[] }>(
        `/api/history-window?conv=${encodeURIComponent(convId)}&message=${encodeURIComponent(msgId)}`
      )
      if (reqId === this.historyReq) this.store.set({ messages: (data.messages ?? []).slice() })
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

  /** Econ. / Loop / Rápido da conversa aberta (otimista). */
  setMode(mode: 'economy' | 'loop' | 'fast', on: boolean): void {
    const convId = this.state.convId
    if (!convId) return
    const key = mode === 'economy' ? 'economyMode' : mode === 'loop' ? 'loopEnabled' : 'fastMode'
    const patch: Partial<ConvSummary> = { [key]: on }
    if (on && mode === 'economy') patch.loopEnabled = false
    if (on && mode === 'loop') patch.economyMode = false
    this.patchConv(convId, patch)
    void this.post('/api/set-mode', { convId, mode, on })
      .then(() => this.fetchState())
      .catch(() => this.fetchState().catch(() => undefined))
  }

  /** Modelo/esforço da conversa aberta (otimista; travado com a conversa ocupada). */
  setModel(patch: { model?: string; effort?: string }): void {
    const cur = this.current()
    if (!cur || cur.busy) return
    const next: Partial<ConvSummary> = patch.model ? { model: patch.model, effort: undefined } : {}
    if (patch.effort) next.effort = patch.effort
    this.patchConv(cur.id, next)
    void this.post('/api/set-model', { convId: cur.id, model: patch.model, effort: patch.effort })
      .then(() => this.fetchState())
      .catch(() => undefined)
  }

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
  async conversationAction(body: { type: 'create'; cwd: string } | { type: 'rename'; convId: string; title: string } | { type: 'delete'; convId: string }): Promise<string | null> {
    const r = await this.post<{ ok?: boolean; convId?: string }>('/api/conversation', body)
    if (body.type === 'rename') this.patchConv(body.convId, { title: body.title })
    if (body.type === 'delete') this.store.set((s) => ({ conversations: s.conversations.filter((c) => c.id !== body.convId) }))
    if (body.type === 'create' && r.convId) {
      const optimistic: ConvSummary = { id: r.convId, title: 'Nova conversa', cwd: body.cwd, busy: false, connected: false, updatedAt: Date.now(), queued: [] }
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
