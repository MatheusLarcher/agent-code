export interface RestartActivity {
  busy: boolean
  unsafe?: string
  /**
   * Há chamada de ferramenta autônoma ainda sem resultado (PreToolUse sem o
   * PostToolUse correspondente). Só isso: um comando destacado já concluído
   * (`restartUncertain`) ou um loop ativo não ligam este sinal.
   */
  autonomousCallOpen?: boolean
  /** Tarefas em background que o SDK diz estarem rodando agora (null: ainda não disse). */
  backgroundTasks?: number | null
  /** O histórico do último turno ainda não foi confirmado no banco. */
  persistenceUnverified?: boolean
  /**
   * Trabalho vivo fora do turno — subagente ou comando em segundo plano que o
   * SDK diz estar rodando, ou ferramenta autônoma sem resultado — numa sessão
   * ainda aberta. É o que o bloqueio de suspensão soma ao `busy`.
   */
  workingOutsideTurn?: boolean
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

/** A recusa de trabalho novo durante a retenção da atualização — a mesma no `assertOpen` e no hook do turno. */
export const UPDATE_HOLD_MESSAGE =
  'Atualização agendada: o app reinicia quando os agentes terminarem. Cancele no indicador para continuar.'
/** Reconferência periódica da retenção: nem todo fim de trabalho passa por `changed()`. */
export const UPDATE_HOLD_RECHECK_MS = 5_000

interface UpdateHold {
  onIdle: () => void
  /** Outro motivo para esperar (tarefa agendada ativa); undefined = nada. */
  extraBusy: () => string | undefined
  onBlockedChange?: (blockedBy: string | undefined) => void
  fired: boolean
  lastBlockedBy: string | undefined
  timer: ReturnType<typeof setInterval>
}

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
  private hold?: UpdateHold
  constructor(private readonly host: RestartHost, private readonly timeoutMs = 60_000) {}

  /**
   * "Atualizar quando os agentes terminarem": trabalho NOVO é recusado (`enter`/
   * `assertOpen` e o hook UserPromptSubmit da sessão) e `onIdle` dispara UMA vez
   * no instante em que nada trabalha — `working()` vazio e `extraBusy()` vazio.
   * Diferente da reserva do app_restart, não nega ferramentas nem permissões do
   * turno em curso: `reserved` continua falso. Sem prazo de validade; só
   * `releaseHold()` (cancelamento na tela, fechamento do app) a desfaz. Um timer
   * reconfere enquanto ela existir: nem todo fim de trabalho chama `changed()`.
   * Já existindo uma retenção, a chamada é ignorada.
   */
  holdForUpdate(
    onIdle: () => void,
    extraBusy: () => string | undefined = () => undefined,
    onBlockedChange?: (blockedBy: string | undefined) => void,
    recheckMs = UPDATE_HOLD_RECHECK_MS
  ): void {
    if (this.hold) return
    const timer = setInterval(() => this.checkHold(), recheckMs)
    timer.unref?.()
    this.hold = { onIdle, extraBusy, onBlockedChange, fired: false, lastBlockedBy: undefined, timer }
    // Nunca dispara dentro da chamada de quem agendou: mesmo ocioso, cede primeiro.
    setImmediate(() => this.checkHold())
  }

  releaseHold(): void {
    if (!this.hold) return
    clearInterval(this.hold.timer)
    this.hold = undefined
  }

  /** A instalação agendada foi recusada por motivo passageiro: volta a esperar o próximo instante ocioso. */
  rearmHold(): boolean {
    const hold = this.hold
    if (!hold) return false
    hold.fired = false
    clearInterval(hold.timer)
    hold.timer = setInterval(() => this.checkHold(), UPDATE_HOLD_RECHECK_MS)
    hold.timer.unref?.()
    return true
  }

  get updateHold(): boolean { return !!this.hold }

  /** O que segura a retenção agora (para a tela); undefined = livre ou sem retenção. */
  holdBlockedBy(label: (convId: string) => string = String): string | undefined {
    if (!this.hold) return undefined
    return this.working(label) ?? this.hold.extraBusy()
  }

  private checkHold(): void {
    const hold = this.hold
    if (!hold) return
    const blockedBy = this.working(String) ?? hold.extraBusy()
    if (blockedBy !== hold.lastBlockedBy) {
      hold.lastBlockedBy = blockedBy
      try { hold.onBlockedChange?.(blockedBy) } catch { /* a tela pode já ter ido embora */ }
    }
    if (hold.fired || blockedBy) return
    hold.fired = true
    clearInterval(hold.timer)
    // A retenção continua (trabalho novo segue recusado) até releaseHold() ou o fim do app.
    try { hold.onIdle() } catch (error) {
      this.host.report(`Atualização agendada: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  register(id: string, read: () => RestartActivity): {
    request: (reason: string, checkOnly?: boolean) => RestartReply
    /** O que as OUTRAS conversas estão fazendo de verdade agora (`working`); undefined = nada. */
    othersWorking: () => string | undefined
    remove: () => void
  } {
    const key = Symbol(id)
    this.sessions.set(key, { id, read })
    return {
      request: (reason, checkOnly = false) => this.request(key, reason, checkOnly),
      othersWorking: () => this.working(String, key),
      remove: () => { this.sessions.delete(key); if (this.reservation?.caller === key) this.cancel('Sessão solicitante desconectada.') }
    }
  }

  /**
   * A guarda da troca e da restauração de banco: só trabalho DE VERDADE agora —
   * turno vivo, permissão pendente, start/send em andamento, ferramenta autônoma
   * sem resultado, tarefa em background que o SDK diz estar rodando ou histórico
   * ainda não confirmado no banco. Ao contrário de `status()`, ignora o latch de
   * incerteza de `unsafe` ("sem prova de término", "background desconhecido" de
   * uma conversa retomada): ele sobrevive ao fim do trabalho e segurava a troca
   * para sempre, com "agente trabalhando" sem agente nenhum. `label` dá o nome
   * da conversa para a mensagem.
   */
  workStatus(label: (convId: string) => string = String): RestartGuardStatus {
    const blockedBy = this.working(label) ?? null
    return { idle: !blockedBy, blockedBy, sessions: this.sessions.size, at: new Date().toISOString() }
  }

  private working(label: (convId: string) => string, caller?: symbol): string | undefined {
    if (this.operations.size) return 'Uma conversa está começando ou enviando uma mensagem.'
    if (this.reservation) return 'Já existe uma reserva de reinício.'
    for (const [key, session] of this.sessions) {
      if (key === caller) continue
      let state: RestartActivity
      try { state = session.read() } catch { return `Estado da conversa "${label(session.id)}" ilegível.` }
      const name = `"${label(session.id)}"`
      if (state.busy) return `A conversa ${name} está com um turno em andamento.`
      if (state.autonomousCallOpen) return `A conversa ${name} tem uma ferramenta ainda rodando.`
      if ((state.backgroundTasks ?? 0) > 0) return `A conversa ${name} tem tarefas em background rodando.`
      if (state.persistenceUnverified) return `O histórico da conversa ${name} ainda não foi confirmado no banco.`
    }
    return undefined
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
    if (this.hold) throw new Error(UPDATE_HOLD_MESSAGE)
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
   * máquina para sempre. Aqui conta turno vivo, permissão pendente, start/send
   * em andamento e trabalho vivo fora do turno (`workingOutsideTurn`): o turno
   * principal termina enquanto o subagente ou o comando em segundo plano segue.
   */
  busyNow(): boolean {
    if (this.operations.size) return true
    for (const session of this.sessions.values()) {
      try {
        const state = session.read()
        if (state.busy || state.workingOutsideTurn) return true
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
    this.checkHold()
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
