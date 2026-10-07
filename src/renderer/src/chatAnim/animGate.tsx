/**
 * O PORTÃO das animações do chat: só anima o que chegou AO VIVO nesta tela.
 *
 *   histórico   tudo o que já estava na lista no 1º render, o que chega nos
 *               primeiros instantes (a conversa carregando), um lote grande de
 *               uma vez ou a troca de conversa (a 1ª mensagem mudou) — nada anima
 *   ao vivo     o resto: a mensagem nova, o passo novo, a ferramenta nova
 *   uma vez     cada pedaço (`key` + id) anima uma vez só; voltar à tela (a
 *               janela de rolagem, abrir/fechar um passo) não repete
 *
 * Quem monta a lista (MessageList, TurnRows) chama `useAnimGate(messages)` e põe
 * o `AnimGateProvider` em volta; as linhas pedem `useFreshOnce(id, key)`. Sem
 * provider nada anima. Com prefers-reduced-motion, também não.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

export interface AnimGate {
  /** O id chegou ao vivo e este `key` ainda não animou. */
  fresh(id: string, key: string): boolean
  /** Marca o `key` do id como já animado. */
  claim(id: string, key: string): void
}

const NONE: AnimGate = { fresh: () => false, claim: () => {} }
const GateContext = createContext<AnimGate>(NONE)

/** Mais que isto de mensagens novas numa atualização = carregou histórico, não chegou ao vivo. */
const BATCH = 3
/** Logo depois de montar, o que chega ainda é a conversa carregando. */
const SETTLE_MS = 400

interface GateState {
  known: Set<string>
  history: Set<string>
  done: Set<string>
  first: string | null
  mountedAt: number
}

function idOf(m: unknown): string | null {
  const id = m && typeof m === 'object' ? (m as { id?: unknown }).id : null
  return typeof id === 'string' && id ? id : null
}

export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/**
 * Lê as mensagens a cada render (idempotente: renderizar duas vezes não muda
 * nada) e devolve o portão estável desta lista.
 */
export function useAnimGate(messages: readonly unknown[]): AnimGate {
  const ref = useRef<GateState | null>(null)
  if (!ref.current) ref.current = { known: new Set(), history: new Set(), done: new Set(), first: null, mountedAt: Date.now() }
  const s = ref.current
  const ids: string[] = []
  for (const m of messages) {
    const id = idOf(m)
    if (id) ids.push(id)
  }
  const first = ids[0] ?? null
  const fresh = ids.filter((id) => !s.known.has(id))
  if (fresh.length > 0) {
    const switched = s.first !== null && first !== s.first && !s.known.has(first ?? '')
    const asHistory = s.known.size === 0 || switched || fresh.length > BATCH || Date.now() - s.mountedAt < SETTLE_MS
    for (const id of fresh) {
      s.known.add(id)
      if (asHistory) s.history.add(id)
    }
  }
  s.first = first
  return useMemo<AnimGate>(
    () => ({
      fresh: (id, key) => s.known.has(id) && !s.history.has(id) && !s.done.has(`${key}:${id}`),
      claim: (id, key) => {
        s.done.add(`${key}:${id}`)
      }
    }),
    [s]
  )
}

export function AnimGateProvider({ gate, children }: { gate: AnimGate; children: ReactNode }): JSX.Element {
  return <GateContext.Provider value={gate}>{children}</GateContext.Provider>
}

/**
 * Este pedaço anima AGORA? Decide uma vez por montagem (o mesmo valor em todos
 * os renders dela) e marca como animado depois de pintar.
 */
export function useFreshOnce(id: string | null | undefined, key: string): boolean {
  const gate = useContext(GateContext)
  const [fresh] = useState(() => !!id && gate.fresh(id, key) && !prefersReducedMotion())
  useEffect(() => {
    if (fresh && id) gate.claim(id, key)
  }, [fresh, gate, id, key])
  return fresh
}
