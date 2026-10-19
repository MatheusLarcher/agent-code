import { execFile, spawn } from 'node:child_process'

/**
 * O PC acordado para as tarefas agendadas (reaproveita o sleepGuard.ts): o
 * pedido de DISPLAY + EXECUÇÃO fica de pé com um turno rodando (como sempre) OU
 * com tarefa ativa NA TOMADA e o interruptor "Manter o PC acordado para as
 * tarefas agendadas" ligado. Cada interruptor vale para o seu motivo. Na bateria
 * não segura: a tarefa vencida roda uma vez quando o PC acorda.
 *
 * Segurando SÓ pelas tarefas, com o usuário longe do PC, a tela interna vai ao
 * brilho mínimo (WMI) e o anterior volta quando ele retorna, quando solta e ao
 * fechar o app. Monitor externo/sem WMI: falha ignorada. Nada aqui lança.
 */

export type MotivoAcordado = 'turno' | 'tarefas' | null

/** Usuário longe: sem teclado/mouse há este tempo (a tela apagaria por volta disso). */
export const OCIOSO_PARA_ESCURECER_S = 5 * 60

export interface EstadoAcordado {
  turnoOcupado: boolean
  /** "Impedir suspensão com agente trabalhando" (padrão ligado). */
  turnoLigado: boolean
  tarefaAtiva: boolean
  naBateria: boolean
  /** "Manter o PC acordado para as tarefas agendadas" (padrão ligado). */
  tarefasLigado: boolean
}

export function motivoAcordado(s: EstadoAcordado): MotivoAcordado {
  if (s.turnoLigado && s.turnoOcupado) return 'turno'
  if (s.tarefasLigado && s.tarefaAtiva && !s.naBateria) return 'tarefas'
  return null
}

export interface BrilhoIo {
  ler(): Promise<number | null>
  definir(nivel: number): Promise<boolean>
  /** Fechamento: restaura sem esperar (o processo do app está saindo). */
  definirAoSair?(nivel: number): void
}

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']
const LER = "(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1).CurrentBrightness"
const definirCmd = (nivel: number): string =>
  `Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]0; Brightness = [byte]${Math.round(nivel)} } | Out-Null`

function powershell(command: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    try {
      execFile('powershell.exe', [...PS_ARGS, command], { windowsHide: true, timeout: 15_000 }, (error, stdout) =>
        resolve({ ok: !error, out: String(stdout ?? '').trim() })
      )
    } catch {
      resolve({ ok: false, out: '' })
    }
  })
}

/** O brilho da tela interna pelo WMI do Windows. */
export const brilhoWmi: BrilhoIo = {
  async ler() {
    if (process.platform !== 'win32') return null
    const r = await powershell(LER)
    const n = Number(r.out)
    return r.ok && r.out !== '' && Number.isFinite(n) ? n : null
  },
  async definir(nivel) {
    if (process.platform !== 'win32') return false
    return (await powershell(definirCmd(nivel))).ok
  },
  definirAoSair(nivel) {
    if (process.platform !== 'win32') return
    try {
      const child = spawn('powershell.exe', [...PS_ARGS, definirCmd(nivel)], { windowsHide: true, detached: true, stdio: 'ignore' })
      child.unref()
    } catch {
      // sem PowerShell: o brilho fica como está
    }
  }
}

/** O brilho mínimo enquanto o PC fica acordado só pelas tarefas, com o anterior guardado. */
export class BrilhoDasTarefas {
  private anterior: number | null = null
  private querMinimo = false
  private fila: Promise<void> = Promise.resolve()
  private indisponivel = false

  constructor(
    private readonly io: BrilhoIo,
    private readonly log: (line: string) => void = () => undefined,
    private readonly minimo = 0
  ) {}

  /** Chamado a cada tique do guard; só age quando o desejo muda. */
  atualizar(querMinimo: boolean): void {
    if (querMinimo === this.querMinimo || this.indisponivel) return
    this.querMinimo = querMinimo
    this.fila = this.fila.then(() => (querMinimo ? this.escurecer() : this.restaurar())).catch(() => undefined)
  }

  /** Espera o que estiver na fila (teste e fechamento). */
  async ocioso(): Promise<void> {
    await this.fila
  }

  /** Fechamento do app: devolve o brilho anterior sem esperar. */
  restaurarAoSair(): void {
    if (this.anterior === null) return
    const nivel = this.anterior
    this.anterior = null
    try {
      if (this.io.definirAoSair) this.io.definirAoSair(nivel)
      else void this.io.definir(nivel)
    } catch {
      // nada a fazer no fechamento
    }
  }

  private async escurecer(): Promise<void> {
    if (!this.querMinimo || this.anterior !== null) return
    const atual = await this.io.ler().catch(() => null)
    if (atual === null) {
      this.indisponivel = true
      this.log('[tarefas] brilho da tela indisponível (sem WMI de brilho): o PC fica acordado com o brilho atual')
      return
    }
    if (!this.querMinimo) return
    if (atual <= this.minimo) return
    if (await this.io.definir(this.minimo).catch(() => false)) this.anterior = atual
  }

  private async restaurar(): Promise<void> {
    if (this.anterior === null) return
    const nivel = this.anterior
    if (await this.io.definir(nivel).catch(() => false)) this.anterior = null
  }
}

export interface IsBusyDeps {
  turnoOcupado(): boolean
  config(): { preventSleepWhileBusy?: boolean; manterAcordadoTarefas?: boolean }
  tarefaAtiva(): boolean
  naBateria(): boolean
  /** Segundos sem teclado/mouse (powerMonitor.getSystemIdleTime). */
  ociosoSegundos(): number
  brilho?: BrilhoDasTarefas
}

/** O `isBusy` do sleepGuard com os dois motivos; ajusta o brilho de quebra. Nunca lança. */
export function criarIsBusy(deps: IsBusyDeps): () => boolean {
  const seguro = <T>(fn: () => T, padrao: T): T => {
    try {
      return fn()
    } catch {
      return padrao
    }
  }
  return () => {
    const cfg = seguro(() => deps.config(), {})
    const motivo = motivoAcordado({
      turnoOcupado: seguro(() => deps.turnoOcupado(), false),
      turnoLigado: cfg.preventSleepWhileBusy !== false,
      tarefaAtiva: seguro(() => deps.tarefaAtiva(), false),
      naBateria: seguro(() => deps.naBateria(), false),
      tarefasLigado: cfg.manterAcordadoTarefas !== false
    })
    deps.brilho?.atualizar(motivo === 'tarefas' && seguro(() => deps.ociosoSegundos(), 0) >= OCIOSO_PARA_ESCURECER_S)
    return motivo !== null
  }
}
