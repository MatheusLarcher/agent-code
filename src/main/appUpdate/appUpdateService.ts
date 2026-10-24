// Serviço de atualização automática do app: checa o feed (Releases do GitHub,
// pelo app-update.yml do instalador), baixa a versão nova em segundo plano,
// deixa o electron-updater conferir o sha512 e publica o estado para a tela.
//
// Instalar NUNCA acontece sozinho: nem ao fechar o app (o Windows pode encerrar
// o instalador destacado no logoff e deixar o app pela metade), nem na abertura
// seguinte. É sempre pedido explícito — "Atualizar agora" ou o agendamento
// "quando os agentes terminarem" (updateInstaller.ts e appRestart.ts).
import type { AppUpdatePhase, AppUpdateState } from '../../shared/ipc'

/** Primeira checagem: 30 s depois de janela e banco prontos. */
export const FIRST_CHECK_DELAY_MS = 30_000
/** Depois, de hora em hora enquanto o app estiver aberto. */
export const CHECK_INTERVAL_MS = 60 * 60_000
const ERROR_MAX_CHARS = 300
const UPDATER_LOG_MAX_CHARS = 500

export interface UpdaterLogger {
  info(message?: unknown): void
  warn(message?: unknown): void
  error(message?: unknown): void
}

/**
 * O pedaço do `autoUpdater` (electron-updater) que o serviço usa; nos testes, um
 * falso que emite os mesmos eventos. `on` é método (não propriedade-função) de
 * propósito: a checagem bivariante aceita o TypedEmitter do pacote.
 */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowDowngrade: boolean
  forceDevUpdateConfig: boolean
  updateConfigPath: string | null
  logger: UpdaterLogger | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface AppUpdateServiceDeps {
  updater: UpdaterLike
  /** A versão em execução (app.getVersion()). */
  currentVersion: string
  log: (line: string) => void
  /** O que segura a instalação agora (agente trabalhando, tarefa agendada ativa); null = livre. */
  blockedBy: () => string | null
  /** Recebe cada estado novo (o main manda à tela por IPC). */
  onChange: (state: AppUpdateState) => void
  /** Só em desenvolvimento com AGENT_CODE_DEV_UPDATE_FEED=1 (devUpdateFeed.ts). */
  devFeedConfigPath?: string | null
  now?: () => Date
  firstCheckDelayMs?: number
  checkIntervalMs?: number
}

type CheckOrigin = 'abertura' | 'periódica' | 'pedida'

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/g, ' ').trim().slice(0, ERROR_MAX_CHARS) || 'erro desconhecido'
}

function updaterText(message: unknown): string {
  const text = typeof message === 'string' ? message : message instanceof Error ? message.message : String(message)
  return text.replace(/\s+/g, ' ').trim().slice(0, UPDATER_LOG_MAX_CHARS)
}

export class AppUpdateService {
  private phase: AppUpdatePhase = 'ocioso'
  private version: string | null = null
  private percent: number | null = null
  private checkedAt: string | null = null
  private error: string | null = null
  /** O setup baixado e conferido pelo updater (a partir de `pronta`). */
  private pendingFile: string | null = null
  private firstTimer: ReturnType<typeof setTimeout> | null = null
  private intervalTimer: ReturnType<typeof setInterval> | null = null
  private lastLoggedPercent = -1

  constructor(private readonly deps: AppUpdateServiceDeps) {
    const { updater } = deps
    updater.autoDownload = true
    // Instalar é SEMPRE pedido explícito (botão ou agendamento). O plano chamava
    // isto de `autoInstallEvent: 'manual'`; no electron-updater 6.8 a opção é esta.
    updater.autoInstallOnAppQuit = false
    updater.allowDowngrade = false
    updater.logger = {
      info: (message) => this.log(`updater: ${updaterText(message)}`),
      warn: (message) => this.log(`updater (aviso): ${updaterText(message)}`),
      error: (message) => this.log(`updater (erro): ${updaterText(message)}`)
    }
    if (deps.devFeedConfigPath) {
      updater.forceDevUpdateConfig = true
      updater.updateConfigPath = deps.devFeedConfigPath
      this.log(`feed de desenvolvimento: ${deps.devFeedConfigPath}`)
    }
    updater.on('checking-for-update', () => this.onChecking())
    updater.on('update-available', (info: { version?: unknown }) => this.onAvailable(info))
    updater.on('update-not-available', (info: { version?: unknown }) => this.onNotAvailable(info))
    updater.on('download-progress', (info: { percent?: unknown }) => this.onProgress(info))
    updater.on('update-downloaded', (event: { version?: unknown; downloadedFile?: unknown }) => this.onDownloaded(event))
    updater.on('error', (error: unknown) => this.noteError(error, 'updater'))
  }

  /** Liga as checagens (uma vez): a primeira depois do atraso, depois periódicas. */
  start(): void {
    if (this.firstTimer || this.intervalTimer) return
    const first = this.deps.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS
    const every = this.deps.checkIntervalMs ?? CHECK_INTERVAL_MS
    this.firstTimer = setTimeout(() => {
      this.firstTimer = null
      void this.check('abertura')
    }, first)
    this.firstTimer.unref?.()
    this.intervalTimer = setInterval(() => void this.check('periódica'), every)
    this.intervalTimer.unref?.()
    this.log(
      `serviço ligado: versão atual ${this.deps.currentVersion}; primeira verificação em ${Math.round(first / 1000)} s, depois a cada ${Math.round(every / 60_000)} min`
    )
  }

  stop(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer)
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    this.firstTimer = null
    this.intervalTimer = null
  }

  snapshot(): AppUpdateState {
    const blockedBy = this.deps.blockedBy()
    return {
      phase: this.phase,
      version: this.version,
      percent: this.percent,
      checkedAt: this.checkedAt,
      error: this.error,
      canInstallNow: this.phase === 'pronta' && !blockedBy,
      blockedBy
    }
  }

  /** O setup pronto para instalar (null fora de pronta/agendada/instalando). */
  pendingInstaller(): string | null {
    return this.phase === 'pronta' || this.phase === 'agendada' || this.phase === 'instalando' ? this.pendingFile : null
  }

  /** "Verificar agora" (Configurações). Durante verificação/download não duplica. */
  checkNow(): Promise<AppUpdateState> {
    return this.check('pedida')
  }

  /** Etapa "quando os agentes terminarem": só de `pronta`. */
  markScheduled(): boolean {
    if (this.phase !== 'pronta') return false
    this.phase = 'agendada'
    this.log(`agendada: a ${this.version} instala quando os agentes terminarem`)
    this.publish()
    return true
  }

  /** A sequência de fechamento começou (de `pronta` ou `agendada`). */
  markInstalling(): boolean {
    if (this.phase !== 'pronta' && this.phase !== 'agendada') return false
    this.phase = 'instalando'
    this.error = null
    this.log(`instalando a ${this.version}: fechamento ordenado começou`)
    this.publish()
    return true
  }

  /** Volta a `pronta` (agendamento cancelado ou instalação que não disparou), com o motivo da falha se houver. */
  markReady(error?: string): void {
    this.phase = this.pendingFile ? 'pronta' : 'ocioso'
    this.error = error ?? null
    this.log(error ? `volta a ${this.phase}: ${error}` : `volta a ${this.phase}`)
    this.publish()
  }

  /** Último passo da instalação: o instalador silencioso sobe (`--updated /S --force-run`) e reabre o app. */
  quitAndInstall(): void {
    this.log(`disparando o instalador da ${this.version} (silencioso, reabre o app)`)
    this.deps.updater.quitAndInstall(true, true)
  }

  private async check(origin: CheckOrigin): Promise<AppUpdateState> {
    if (this.phase === 'verificando' || this.phase === 'baixando' || this.phase === 'agendada' || this.phase === 'instalando') {
      this.log(`verificação ${origin} ignorada: ${this.phase}`)
      return this.snapshot()
    }
    this.log(`verificação ${origin} (atual ${this.deps.currentVersion})`)
    try {
      const result = await this.deps.updater.checkForUpdates()
      if (result === null) this.log('verificação ignorada pelo updater (app não empacotado e sem feed de desenvolvimento)')
      // Sem evento terminal (não deveria acontecer): não fica "verificando" para sempre.
      // (Os eventos do updater mudam `phase` durante o await; o cast desfaz o estreitamento do TS.)
      if ((this.phase as AppUpdatePhase) === 'verificando') {
        this.phase = 'ocioso'
        this.checkedAt = this.now()
        this.publish()
      }
    } catch (error) {
      // O updater também emite 'error' para a mesma falha; noteError não duplica.
      this.noteError(error, origin)
    }
    return this.snapshot()
  }

  private onChecking(): void {
    if (this.phase !== 'ocioso' && this.phase !== 'erro') return
    this.phase = 'verificando'
    this.publish()
  }

  private onAvailable(info: { version?: unknown }): void {
    const version = typeof info?.version === 'string' ? info.version : '?'
    if (this.phase === 'pronta' || this.phase === 'agendada' || this.phase === 'instalando') {
      this.log(`versão ${version} disponível com a ${this.version} já baixada; o updater reaproveita o arquivo se for a mesma`)
      return
    }
    this.phase = 'baixando'
    this.version = version
    this.percent = 0
    this.error = null
    this.lastLoggedPercent = -1
    this.log(`versão nova ${version} encontrada (atual ${this.deps.currentVersion}); baixando em segundo plano`)
    this.publish()
  }

  private onNotAvailable(info: { version?: unknown }): void {
    this.checkedAt = this.now()
    const seen = typeof info?.version === 'string' ? info.version : '?'
    this.log(`nenhuma versão nova (feed ${seen}, atual ${this.deps.currentVersion})`)
    if (this.phase === 'verificando' || this.phase === 'erro' || this.phase === 'ocioso') {
      this.phase = 'ocioso'
      this.error = null
      this.version = null
      this.percent = null
    }
    this.publish()
  }

  private onProgress(info: { percent?: unknown }): void {
    if (this.phase !== 'baixando') return
    const raw = typeof info?.percent === 'number' && Number.isFinite(info.percent) ? info.percent : 0
    const percent = Math.max(0, Math.min(100, Math.floor(raw)))
    if (percent === this.percent) return
    this.percent = percent
    if (percent >= this.lastLoggedPercent + 10 || percent === 100) {
      this.lastLoggedPercent = percent
      this.log(`download da ${this.version}: ${percent}%`)
    }
    this.publish()
  }

  private onDownloaded(event: { version?: unknown; downloadedFile?: unknown }): void {
    this.checkedAt = this.now()
    if (typeof event?.version === 'string') this.version = event.version
    this.pendingFile = typeof event?.downloadedFile === 'string' ? event.downloadedFile : null
    this.percent = 100
    this.error = null
    // Agendada ou instalando: a versão/arquivo atualizam, a fase fica.
    if (this.phase !== 'agendada' && this.phase !== 'instalando') this.phase = 'pronta'
    this.log(`pronta ${this.version}: ${this.pendingFile ?? 'arquivo não informado'} (sha512 conferido pelo updater)`)
    this.publish()
  }

  private noteError(error: unknown, origin: CheckOrigin | 'updater'): void {
    const message = errorText(error)
    // Evento 'error' + rejeição da mesma falha: a segunda não muda nada.
    if (this.error === message && this.phase !== 'verificando' && this.phase !== 'baixando') return
    this.checkedAt = this.now()
    this.error = message
    this.log(`erro (${origin}): ${message}`)
    if (this.phase === 'verificando' || this.phase === 'baixando' || this.phase === 'ocioso') {
      this.phase = 'erro'
      this.percent = null
      if (!this.pendingFile) this.version = null
    } else if (this.phase === 'instalando') {
      // O instalador não subiu: o app continua aberto e o indicador volta.
      this.phase = this.pendingFile ? 'pronta' : 'erro'
    }
    // pronta/agendada: a falha de uma checagem periódica não some com o setup já baixado.
    this.publish()
  }

  private now(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString()
  }

  private log(line: string): void {
    try {
      this.deps.log(line)
    } catch {
      /* o log nunca derruba o serviço */
    }
  }

  private publish(): void {
    try {
      this.deps.onChange(this.snapshot())
    } catch {
      /* a tela pode já ter ido embora */
    }
  }
}
