// "Atualizar agora" (ou o disparo do agendamento): fecha o app de forma
// ordenada, confere que não sobrou processo com arquivo da pasta de
// instalação e só então sobe o instalador silencioso, que troca a pasta e
// reabre o app. O instalador NUNCA pode encontrar o app em fechamento: no modo
// --updated o NSIS espera ~2,6 s, mata só o "Agent Code.exe" e, com qualquer
// outro arquivo em uso, aborta e restaura a versão antiga sem reabrir nada.
//
// Garantias: falhou ANTES de o fechamento começar → o app continua aberto e
// o chamador recebe o motivo (toast). Falhou DEPOIS (listagem de processos
// morreu, instalador não subiu) → o app sai sem instalar; o setup fica no
// cache e a abertura seguinte mostra "pronta" de novo. Nada aqui usa o
// relançador por PowerShell do app_restart: quem reabre é o instalador.
export interface ShutdownStep {
  name: string
  timeoutMs: number
  /** Síncrono ou com Promise; o valor devolvido é ignorado. */
  run: () => unknown
}

export interface InstallDirProcessInfo {
  pid: number
  path: string
}

/** `transient`: recusa passageira (agente trabalhando) — o agendamento pode continuar esperando. */
export type InstallResult = { ok: true } | { ok: false; message: string; transient?: boolean }
export type InstallOrigin = 'botão' | 'agendamento'

export interface UpdateInstallerDeps {
  log: (line: string) => void
  /** O que segura agora (agente trabalhando, tarefa agendada ativa); null = livre. */
  blockedBy: () => string | null
  /** O setup baixado e conferido (null = nada pronto) e a versão dele. */
  pendingInstaller: () => string | null
  pendingVersion: () => string | null
  fileExists: (file: string) => boolean
  /** Fases na tela: `instalando`, ou de volta a `pronta` com o motivo. */
  markInstalling: () => boolean
  markReady: (error?: string) => void
  /** Retenção no coordenador de reinício: trabalho novo recusado durante o fechamento. */
  hold: () => void
  /** Os passos do fechamento, na ordem (index.ts). */
  steps: () => ShutdownStep[]
  /** Processos vivos com executável na pasta de instalação, sem o próprio app. */
  listProcesses: () => Promise<InstallDirProcessInfo[]>
  killProcess: (pid: number) => Promise<void>
  /** Grava o marcador que a abertura seguinte lê (installMarker.ts). */
  rememberAttempt: (version: string) => void
  /** `quitReady`/`closeReady` no index.ts: o app.quit() seguinte não pede flush nem segura a janela. */
  markQuitReady: () => void
  /** `autoUpdater.quitAndInstall(true, true)`: o instalador sobe e o app sai. */
  quitAndInstall: () => void
  /** Ainda está `instalando` depois do disparo? (o updater avisa falha síncrona mudando a fase) */
  stillInstalling: () => boolean
  quitApp: () => void
  /** Espera o log chegar ao disco antes de o app sair (as últimas linhas são as que explicam a falha). */
  flushLog?: () => Promise<void>
  /** Ensaio: tudo menos o instalador; o app sai sem instalar. */
  dryRun: boolean
  wait?: (ms: number) => Promise<void>
  orphanGraceMs?: number
  orphanPollMs?: number
}

/** Quanto tempo os processos da pasta têm para sumir sozinhos antes de serem forçados. */
export const ORPHAN_GRACE_MS = 10_000
const ORPHAN_POLL_MS = 500

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 300)
}

const defaultWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class UpdateInstaller {
  private running = false

  constructor(private readonly deps: UpdateInstallerDeps) {}

  get busy(): boolean {
    return this.running
  }

  async installNow(origin: InstallOrigin): Promise<InstallResult> {
    const { deps } = this
    if (this.running) return this.refuse('Já há uma instalação em andamento.')
    const blocked = deps.blockedBy()
    if (blocked) return this.refuse(blocked, true)
    const file = deps.pendingInstaller()
    if (!file) return this.refuse('Nenhuma atualização pronta para instalar.')
    if (!deps.fileExists(file)) {
      const message = 'O arquivo da atualização não está mais no disco; a próxima verificação baixa de novo.'
      deps.markReady(message)
      return this.refuse(message)
    }
    // A sonda vem ANTES de fechar qualquer coisa: se a listagem de processos
    // não funciona nesta máquina, melhor saber com o app inteiro.
    try {
      await deps.listProcesses()
    } catch (error) {
      return this.refuse(`Não foi possível conferir os processos da pasta de instalação: ${errorText(error)}`)
    }
    // A sonda leva ~1-2 s e ainda não há retenção: um turno pode ter começado nesse
    // meio (celular, tarefa agendada). Reconfere antes de fechar qualquer coisa; daqui
    // até o hold() não há mais await.
    const blockedAfterProbe = deps.blockedBy()
    if (blockedAfterProbe) return this.refuse(blockedAfterProbe, true)
    if (!deps.markInstalling()) return this.refuse('A atualização não está mais pronta.')

    this.running = true
    deps.hold()
    const version = deps.pendingVersion() ?? '?'
    const steps = deps.steps()
    deps.log(`instalação da ${version} (${origin}): fechamento ordenado em ${steps.length} passos`)
    for (const step of steps) await this.runStep(step)

    let alive: InstallDirProcessInfo[]
    let forced: InstallDirProcessInfo[] = []
    try {
      alive = await this.waitForProcesses()
      if (alive.length) forced = await this.forceOrphans(alive)
      else deps.log('nenhum processo da pasta de instalação vivo')
    } catch (error) {
      deps.log(`conferência de processos falhou depois do fechamento: ${errorText(error)}; saindo SEM instalar (o setup fica pronto para a próxima abertura)`)
      deps.markReady('Não foi possível conferir os processos; o app vai fechar sem instalar.')
      await this.flushLog()
      deps.markQuitReady()
      deps.quitApp()
      return { ok: false, message: 'Não foi possível conferir os processos da pasta de instalação.' }
    }

    if (deps.dryRun) {
      deps.log(
        `ensaio: ${forced.length ? `foi preciso forçar ${forced.map((p) => `${p.pid} (${p.path})`).join(', ')}` : 'nenhum processo da pasta de instalação vivo'}; saindo do app SEM chamar o instalador`
      )
      await this.flushLog()
      deps.markQuitReady()
      deps.quitApp()
      return { ok: true }
    }

    deps.rememberAttempt(version)
    deps.log('instalador disparado; o app sai agora e volta na versão nova')
    await this.flushLog()
    deps.markQuitReady()
    try {
      deps.quitAndInstall()
      if (!deps.stillInstalling()) throw new Error('o updater recusou a instalação (ver as linhas "updater" acima)')
      return { ok: true }
    } catch (error) {
      const message = `O instalador não subiu: ${errorText(error)}`
      deps.log(`${message}; saindo do app (o setup fica pronto para a próxima abertura)`)
      deps.markReady(message)
      await this.flushLog()
      deps.quitApp()
      return { ok: false, message }
    }
  }

  /** O log é assíncrono: sem isto, a linha que explica o fim some com o app. Nunca segura a saída por mais de 2 s. */
  private async flushLog(): Promise<void> {
    const flush = this.deps.flushLog
    if (!flush) return
    const wait = this.deps.wait ?? defaultWait
    await Promise.race([flush().catch(() => undefined), wait(2_000)])
  }

  private refuse(message: string, transient = false): InstallResult {
    this.deps.log(`instalação recusada: ${message}`)
    return transient ? { ok: false, message, transient: true } : { ok: false, message }
  }

  /** Cada passo com prazo e log; nenhum lança além do que já lança hoje. */
  private async runStep(step: ShutdownStep): Promise<void> {
    const started = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'prazo'>((resolve) => {
      timer = setTimeout(() => resolve('prazo'), step.timeoutMs)
      timer.unref?.()
    })
    try {
      const outcome = await Promise.race([Promise.resolve().then(() => step.run()).then(() => 'ok' as const), timeout])
      if (outcome === 'prazo') this.deps.log(`passo "${step.name}": estourou o prazo de ${step.timeoutMs} ms; seguindo`)
      else this.deps.log(`passo "${step.name}": ok em ${Date.now() - started} ms`)
    } catch (error) {
      this.deps.log(`passo "${step.name}": falhou (${errorText(error)}); seguindo`)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Espera até `orphanGraceMs` os processos da pasta sumirem sozinhos. */
  private async waitForProcesses(): Promise<InstallDirProcessInfo[]> {
    const { deps } = this
    const wait = deps.wait ?? defaultWait
    const grace = deps.orphanGraceMs ?? ORPHAN_GRACE_MS
    const poll = deps.orphanPollMs ?? ORPHAN_POLL_MS
    const deadline = Date.now() + grace
    let alive = await deps.listProcesses()
    while (alive.length && Date.now() < deadline) {
      await wait(poll)
      alive = await deps.listProcesses()
    }
    return alive
  }

  /** O que sobrou depois do prazo é órfão: encerrado à força (Postgres só chega aqui depois do pg_ctl stop). */
  private async forceOrphans(alive: InstallDirProcessInfo[]): Promise<InstallDirProcessInfo[]> {
    const { deps } = this
    deps.log(`órfãos após o prazo: ${alive.map((p) => `${p.pid} (${p.path})`).join(', ')}`)
    for (const process of alive) {
      try {
        await deps.killProcess(process.pid)
        deps.log(`órfão ${process.pid} encerrado à força`)
      } catch (error) {
        deps.log(`órfão ${process.pid} não encerrou: ${errorText(error)}`)
      }
    }
    const left = await deps.listProcesses()
    if (left.length) deps.log(`ainda vivos depois da força: ${left.map((p) => `${p.pid} (${p.path})`).join(', ')}; o instalador pode encontrar arquivo em uso`)
    return alive
  }
}
