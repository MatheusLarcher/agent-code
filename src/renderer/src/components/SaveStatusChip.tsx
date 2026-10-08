import { useEffect, useRef, useState } from 'react'
import type { ConversationSaveStatusDto, StorageStatusDto } from '@shared/ipc'
import type { StorageTransitionResultDto } from '@shared/databaseBackup'

/** Troca de banco ou restauração em andamento: o passo atual, para o indicador. */
type Transition = { state: 'switching-postgres' | 'restoring-postgres'; step?: string } | null
/** O aviso de uma troca que terminou em segundo plano fica este tempo no topo. */
const RESULT_VISIBLE_MS = 20_000

function transitionOf(status: StorageStatusDto): Transition {
  return status.state === 'switching-postgres' || status.state === 'restoring-postgres'
    ? { state: status.state, step: status.transitionStep }
    : null
}

function shownForTransition(transition: Transition, result: StorageTransitionResultDto | null): Shown {
  if (transition) {
    return {
      tone: 'warn',
      label: transition.state === 'switching-postgres' ? 'trocando de banco…' : 'restaurando backup…',
      title:
        `${transition.step ? `${transition.step}. ` : ''}Pode continuar lendo e escrevendo: o que você fizer fica ` +
        'guardado e vai para o banco quando terminar. Agentes novos esperam o fim.'
    }
  }
  if (result && !result.ok) return { tone: 'err', label: 'troca de banco cancelada', title: result.message }
  return null
}

/** "pendente" só aparece quando a gravação passa disto: no uso normal ela sai em
 *  menos de 1 s, e o indicador piscaria a cada mensagem do streaming. */
const PENDING_VISIBLE_MS = 1_500
/** Depois de um estado visível, "salvo" fica este tempo e some. */
const SAVED_VISIBLE_MS = 2_000

type Shown = { tone: 'ok' | 'warn' | 'err'; label: string; title: string } | null

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function shownFor(status: ConversationSaveStatusDto | null, storageOffline: boolean): Shown {
  const pending = status?.pending ?? 0
  if (status?.state === 'error') {
    return {
      tone: 'err',
      label: 'não salvo',
      title: `O banco recusou a gravação${status.error ? `: ${status.error}` : '.'} A próxima mudança tenta de novo.`
    }
  }
  if (storageOffline || status?.state === 'offline') {
    return {
      tone: 'warn',
      label: pending ? `sem banco · ${pending} pendente${pending === 1 ? '' : 's'}` : 'sem banco',
      title: pending
        ? `O banco está fora do ar. ${plural(pending, 'conversa espera', 'conversas esperam')} para ser gravada${pending === 1 ? '' : 's'}: fica guardado neste PC e vai quando ele voltar.`
        : 'O banco está fora do ar. O que você fizer fica guardado neste PC e é gravado quando ele voltar.'
    }
  }
  if (status?.state === 'pending' && status.oldestMs >= PENDING_VISIBLE_MS) {
    return {
      tone: 'warn',
      label: `pendente (${pending})`,
      title: `${plural(pending, 'conversa', 'conversas')} esperando o banco há ${Math.round(status.oldestMs / 1000)} s. Pode continuar usando.`
    }
  }
  return null
}

/**
 * O estado da fila de gravação do main, discreto no topo: nada com tudo salvo;
 * "pendente (n)" quando a gravação demora; "sem banco" com o banco fora do ar;
 * "não salvo" quando o banco recusou. Nunca bloqueia nada.
 */
export function SaveStatusChip({ storageOffline }: { storageOffline: boolean }): JSX.Element | null {
  const [status, setStatus] = useState<ConversationSaveStatusDto | null>(null)
  const [transition, setTransition] = useState<Transition>(null)
  const [result, setResult] = useState<StorageTransitionResultDto | null>(null)
  const [justSaved, setJustSaved] = useState(false)
  const wasShown = useRef(false)
  useEffect(() => {
    let alive = true
    const off = window.api.onConversationSaveStatus((next) => {
      if (alive) setStatus(next)
    })
    void window.api
      .getConversationSaveStatus()
      .then((next) => alive && setStatus((current) => current ?? next))
      .catch(() => undefined)
    // Troca de banco/restauração: o passo no lugar de "sem banco" (as gravações
    // estão retidas de propósito, não perdidas).
    let storageEventSeen = false
    const offStorage = window.api.onStorageStatusChanged?.((next) => {
      storageEventSeen = true
      if (alive) setTransition(transitionOf(next))
    })
    void window.api
      .getStorageStatus?.()
      // A leitura inicial não passa por cima de um aviso que chegou depois dela.
      .then((next) => alive && !storageEventSeen && setTransition(transitionOf(next)))
      .catch(() => undefined)
    const offResult = window.api.onStorageTransitionResult?.((next) => {
      if (alive) setResult(next)
    })
    return () => {
      alive = false
      off()
      offStorage?.()
      offResult?.()
    }
  }, [])
  useEffect(() => {
    if (!result) return
    const timer = setTimeout(() => setResult(null), RESULT_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [result])
  const shown = shownForTransition(transition, result) ?? shownFor(status, storageOffline)
  useEffect(() => {
    if (shown) {
      wasShown.current = true
      setJustSaved(false)
      return
    }
    if (!wasShown.current || status?.state !== 'saved') return
    wasShown.current = false
    setJustSaved(true)
    const timer = setTimeout(() => setJustSaved(false), SAVED_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [shown?.label, status?.state])
  const visible = shown ?? (justSaved ? { tone: 'ok' as const, label: 'salvo', title: 'Tudo gravado no banco.' } : null)
  if (!visible) return null
  return (
    <span className={`save-status ${visible.tone}`} title={visible.title} role="status" aria-live="polite">
      <span className="save-status-dot" aria-hidden="true" />
      {visible.label}
    </span>
  )
}
