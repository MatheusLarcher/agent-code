/**
 * Impede o PC de dormir ENQUANTO um agente está trabalhando.
 *
 * O problema real: o Windows suspende por inatividade contando teclado/mouse —
 * um turno longo do agente não é "atividade" para ele, então a máquina dorme no
 * meio do trabalho e o app volta parado. Bloquear a suspensão o tempo todo
 * seria pior (o PC do usuário nunca mais dormiria); o bloqueio é ligado e
 * desligado conforme a ocupação real das conversas.
 *
 * **Por que DOIS pedidos, e por que o óbvio não bastava** (medido em 11/09/2026
 * nesta máquina, com `powercfg /requests` elevado):
 *
 * - `prevent-app-suspension` sozinho — o candidato natural — registra apenas um
 *   pedido de **EXECUÇÃO** (`ExecutionRequired`). Com ele ativo num processo
 *   vivo, `SYSTEM` continuava "Nenhuma". Ele não segura a máquina acordada: só
 *   pede que o processo continue rodando *depois* que ela entra em standby.
 * - `ES_SYSTEM_REQUIRED` (o que seguraria a máquina em PCs antigos) **não
 *   aparece** em `powercfg /requests` nem com o processo vivo: `powercfg /a`
 *   mostra só **S0 Modern Standby** (S3/hibernação indisponíveis), e nesse modo
 *   o Windows ignora pedido de SYSTEM.
 * - `prevent-display-sleep` registra um pedido de **DISPLAY**, e é o único que
 *   de fato impede a entrada em standby aqui. O preço é a tela ficar acesa
 *   durante o turno — ela apaga sozinha assim que o agente termina.
 *
 * Daí os dois juntos: DISPLAY é a garantia, EXECUÇÃO é a rede de segurança para
 * quando algo força o standby mesmo assim (tampa fechada, "Suspender" no menu).
 */

/** Os dois pedidos, nessa ordem: a garantia primeiro, a rede de segurança depois. */
export const SLEEP_GUARD_BLOCKERS = ['prevent-display-sleep', 'prevent-app-suspension'] as const
export type SleepBlockerType = (typeof SLEEP_GUARD_BLOCKERS)[number]

/** Só o pedaço do `powerSaveBlocker` do Electron que usamos (testável sem Electron). */
export interface PowerSaveBlockerLike {
  start(type: SleepBlockerType): number
  stop(id: number): void
  isStarted(id: number): boolean
}

/** Ociosidade do Windows é contada em minutos, então 5 s de granularidade sobra. */
export const SLEEP_GUARD_POLL_MS = 5_000

export interface SleepGuardOptions {
  blocker: PowerSaveBlockerLike
  /** Alguma conversa está no meio de um turno neste instante? */
  isBusy: () => boolean
  /** Interruptor do usuário (Configurações → Geral). Ligado por padrão. */
  isEnabled: () => boolean
  pollMs?: number
  /** Quais pedidos registrar. Trocável só para teste. */
  types?: readonly SleepBlockerType[]
  /** Diagnóstico opcional: chamado só quando o estado do bloqueio muda. */
  onChange?: (blocking: boolean) => void
}

/**
 * Liga/desliga os bloqueios por polling e devolve a função que os encerra.
 * Nada aqui pode derrubar o app: uma falha do `powerSaveBlocker` só significa
 * que o PC pode dormir, e o próximo tique tenta de novo.
 */
export function startSleepGuard({
  blocker,
  isBusy,
  isEnabled,
  pollMs = SLEEP_GUARD_POLL_MS,
  types = SLEEP_GUARD_BLOCKERS,
  onChange
}: SleepGuardOptions): () => void {
  const held = new Map<SleepBlockerType, number>()

  const release = (): void => {
    if (!held.size) return
    for (const id of held.values()) {
      try {
        if (blocker.isStarted(id)) blocker.stop(id)
      } catch {
        /* já parado / id inválido */
      }
    }
    held.clear()
    onChange?.(false)
  }

  const tick = (): void => {
    let want = false
    try {
      want = isEnabled() && isBusy()
    } catch {
      want = false
    }
    if (!want) {
      release()
      return
    }
    const had = held.size > 0
    for (const type of types) {
      const id = held.get(type)
      // Reemitir quando o sistema derruba o pedido é barato, e é o que evita um
      // guard que se acha ativo enquanto a máquina dorme.
      let alive = false
      try {
        alive = id !== undefined && blocker.isStarted(id)
      } catch {
        alive = id !== undefined
      }
      if (alive) continue
      try {
        held.set(type, blocker.start(type))
      } catch {
        held.delete(type)
      }
    }
    if (!had && held.size) onChange?.(true)
  }

  tick()
  const timer = setInterval(tick, pollMs)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    release()
  }
}
