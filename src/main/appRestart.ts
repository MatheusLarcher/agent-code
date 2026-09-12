export interface RestartActivity {
  busy: boolean
  unsafe?: string
}
export interface ArmedRestart {
  commit(): Promise<void>
  cancel(): Promise<void>
}
export interface RestartHost {
  arm(): Promise<ArmedRestart>
  flush(): Promise<void>
  quit(): void
  report(message: string): void
}
export interface RestartReply { ok: boolean; prepared: boolean; message: string }

/** Same question `blocker()` answers, exposed for an outside restarter script. */
export interface RestartGuardStatus {
  /** True only when NO conversation is busy and nothing is starting/sending. */
  idle: boolean
  /** What is holding it, when not idle. */
  blockedBy: string | null
  /** How many sessions were registered — 0 means the app just started. */
  sessions: number
  /** ISO time this snapshot was produced; a stale file must not be trusted. */
  at: string
}

/** Main-process authority. Models only receive a closure bound to a live registration. */
export class AppRestartCoordinator {
  private sessions = new Map<symbol, { id: string; read: () => RestartActivity }>()
  private operations = new Set<symbol>()
  private reservation?: { caller: symbol; timer: ReturnType<typeof setTimeout>; running: boolean }
  constructor(private readonly host: RestartHost, private readonly timeoutMs = 60_000) {}

  register(id: string, read: () => RestartActivity): { request: (reason: string, checkOnly?: boolean) => RestartReply; remove: () => void } {
    const key = Symbol(id)
    this.sessions.set(key, { id, read })
    return {
      request: (reason, checkOnly = false) => this.request(key, reason, checkOnly),
      remove: () => { this.sessions.delete(key); if (this.reservation?.caller === key) this.cancel('Sessão solicitante desconectada.') }
    }
  }

  /** Acquire synchronously BEFORE the first await in every external start/send. */
  enter(): () => void {
    this.assertOpen()
    const key = Symbol()
    this.operations.add(key)
    return () => { this.operations.delete(key); this.changed() }
  }
  assertOpen(): void {
    if (this.reservation) throw new Error('Reinício preparado: novo trabalho recusado. Tente novamente após o reinício ou cancelamento.')
  }
  get reserved(): boolean { return !!this.reservation }

  /**
   * Guard state for a caller OUTSIDE the app (the restarter script). Uses the
   * same rule as an internal request, but with no caller to exempt: every busy
   * conversation counts, including the one that would be asking.
   */
  status(): RestartGuardStatus {
    const blockedBy = this.operations.size ? 'Inicialização ou envio pendente.' : this.anySessionBusy()
    return {
      idle: !blockedBy && !this.reservation,
      blockedBy: blockedBy ?? (this.reservation ? 'Já existe uma reserva de reinício.' : null),
      sessions: this.sessions.size,
      at: new Date().toISOString()
    }
  }

  /**
   * "Existe trabalho acontecendo AGORA?" — usado pelo bloqueio de suspensão.
   * Deliberadamente ignora `unsafe`: aquele campo é um latch (loop ativo,
   * trabalho destacado) que sobrevive ao fim do turno, e mantê-lo acordaria a
   * máquina para sempre. Aqui só conta turno vivo, permissão pendente e
   * start/send em andamento.
   */
  busyNow(): boolean {
    if (this.operations.size) return true
    for (const session of this.sessions.values()) {
      try {
        if (session.read().busy) return true
      } catch {
        /* Estado ilegível não vira latch de "acordado": o próximo tique reavalia. */
      }
    }
    return false
  }

  private anySessionBusy(): string | undefined {
    for (const session of this.sessions.values()) {
      let state: RestartActivity
      try { state = session.read() } catch { return `Estado desconhecido: ${session.id}.` }
      if (state.unsafe) return `${session.id}: ${state.unsafe}`
      if (state.busy) return `Conversa ocupada: ${session.id}.`
    }
    return undefined
  }

  private blocker(caller: symbol, includeCaller: boolean): string | undefined {
    if (!this.sessions.has(caller)) return 'Sessão solicitante desconhecida.'
    if (this.operations.size) return 'Inicialização ou envio pendente.'
    for (const [key, session] of this.sessions) {
      let state: RestartActivity
      try { state = session.read() } catch { return `Estado desconhecido: ${session.id}.` }
      if (state.unsafe) return `${session.id}: ${state.unsafe}`
      if (state.busy && (includeCaller || key !== caller)) return `Conversa ocupada: ${session.id}.`
    }
    return undefined
  }
  private request(caller: symbol, reason: string, checkOnly: boolean): RestartReply {
    const reject = (message: string): RestartReply => ({ ok: false, prepared: false, message })
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) return reject('Informe um motivo de 1 a 500 caracteres.')
    if (this.reservation) return reject('Já existe uma reserva de reinício.')
    const blocked = this.blocker(caller, false)
    if (blocked) return reject(blocked)
    if (checkOnly) return { ok: true, prepared: false, message: 'Guard livre neste instante; consulta não valida a rota de relançamento nem reserva o app.' }
    const timer = setTimeout(() => this.cancel('Prazo para reinício seguro expirou.'), this.timeoutMs)
    timer.unref?.()
    this.reservation = { caller, timer, running: false }
    // No shutdown in the tool call: even synchronously idle fakes yield first.
    setImmediate(() => this.changed())
    return { ok: true, prepared: true, message: 'Reinício preparado. Termine este turno; o app só fechará após verificar ociosidade, relançador armado e histórico salvo. Pode ser cancelado se a verificação falhar.' }
  }
  cancel(message: string): void {
    if (!this.reservation) return
    clearTimeout(this.reservation.timer)
    this.reservation = undefined
    this.host.report(message)
  }
  changed(): void {
    const reservation = this.reservation
    if (!reservation || reservation.running || this.blocker(reservation.caller, true)) return
    reservation.running = true
    void this.finish(reservation)
  }
  private async finish(reservation: NonNullable<AppRestartCoordinator['reservation']>): Promise<void> {
    let armed: ArmedRestart | undefined
    const validate = (): void => {
      if (this.reservation !== reservation) throw new Error('Reserva cancelada.')
      const blocked = this.blocker(reservation.caller, true)
      if (blocked) throw new Error(blocked)
    }
    try {
      armed = await this.host.arm()
      validate()
      await this.host.flush()
      validate()
      await armed.commit()
      validate()
      clearTimeout(reservation.timer)
      this.host.quit()
    } catch (error) {
      await armed?.cancel().catch(() => undefined)
      this.cancel(`Reinício cancelado: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
