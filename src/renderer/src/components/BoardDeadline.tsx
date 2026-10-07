import { useEffect, useRef, useState } from 'react'
import type { AgentCodeApi } from '@shared/api'
import { tempoAtivoMinutos, type HandoffEnvio } from '@shared/handoffTracking'

/**
 * O PRAZO DA ETAPA no cartão `[etapa]` do quadro: "12 de 40 min" e a marca de
 * atrasada, lidos da entrega ligada ao cartão (`boardItemId`) — a estimativa do
 * plano é o prazo, o tempo ativo é o que o app mediu. Cartão sem entrega ligada
 * não mostra nada.
 */

export interface CardDeadline {
  /** Tempo ativo em minutos inteiros (arredondado para cima, como o "levou Y min"). */
  minutos: number
  /** A estimativa do plano (minutos); `null` sem prazo. */
  prazo: number | null
  atrasada: boolean
}

/** cartão → prazo, de todas as entregas ligadas a algum cartão. */
export function cardDeadlines(envios: readonly HandoffEnvio[]): Map<string, CardDeadline> {
  const out = new Map<string, CardDeadline>()
  for (const envio of envios) {
    for (const entrega of envio.entregas) {
      if (!entrega.boardItemId) continue
      out.set(entrega.boardItemId, {
        minutos: tempoAtivoMinutos(entrega.tempoAtivoMs),
        prazo: entrega.estimativaPlano,
        atrasada: entrega.atrasada
      })
    }
  }
  return out
}

export type DeadlineApi = Pick<AgentCodeApi, 'handoffList' | 'onHandoffChanged'>

const RELOAD_MS = 300

/** Os prazos das etapas da pasta; relê quando o acompanhamento grava (handoff:changed). */
export function useCardDeadlines(projectCwd: string | null, api: DeadlineApi | null): Map<string, CardDeadline> {
  const [map, setMap] = useState<Map<string, CardDeadline>>(() => new Map())
  const apiRef = useRef(api)
  apiRef.current = api
  useEffect(() => {
    const a = apiRef.current
    if (!projectCwd || !a || typeof a.handoffList !== 'function') {
      setMap(new Map())
      return
    }
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const load = (): void => {
      void Promise.resolve(a.handoffList({ projectCwd }))
        .then((res) => {
          if (alive && res?.ok) setMap(cardDeadlines(res.envios))
        })
        .catch(() => undefined)
    }
    load()
    const off =
      typeof a.onHandoffChanged === 'function'
        ? a.onHandoffChanged(() => {
            if (timer) clearTimeout(timer)
            timer = setTimeout(load, RELOAD_MS)
          })
        : undefined
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      off?.()
    }
  }, [projectCwd])
  return map
}

/** "12 de 40 min" (ou "12 min" sem prazo), em vermelho quando atrasada. */
export function DeadlineTag({ deadline }: { deadline: CardDeadline }): JSX.Element {
  const late = deadline.atrasada || (deadline.prazo !== null && deadline.minutos > deadline.prazo)
  const text = deadline.prazo !== null ? `${deadline.minutos} de ${deadline.prazo} min` : `${deadline.minutos} min`
  return (
    <span
      className={`board-tag deadline${late ? ' late' : ''}`}
      title={late ? 'Passou do prazo da etapa (a estimativa do plano)' : 'Tempo ativo da etapa × prazo (a estimativa do plano)'}
    >
      {text}
      {late ? ' · atrasada' : ''}
    </span>
  )
}
