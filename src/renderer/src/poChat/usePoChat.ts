import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentCodeApi } from '@shared/api'
import type { PoChatMessage } from '@shared/poChat'

/**
 * O estado do "Fala, PO" na tela: a conversa guardada do projeto (relida ao
 * trocar de projeto e no F5), a pergunta com a bolha do usuário na hora e a
 * do PO "olhando o quadro…" até a resposta chegar.
 */

export type PoChatApi = Pick<AgentCodeApi, 'poChatHistory' | 'poChatAsk'> &
  Partial<Pick<AgentCodeApi, 'poChatVerify' | 'poChatCancel' | 'poChatApply' | 'poChatSend'>>

const appApi = (): PoChatApi | null => (window as unknown as { api?: PoChatApi }).api ?? null

/** A verificação em andamento (a bolha com o tempo passando e o "Cancelar"). */
export interface PoChatVerifying {
  messageId: string
  startedAt: number
  minutes: number
}

export interface PoChatState {
  messages: PoChatMessage[]
  /** A pergunta em voo (a bolha "olhando o quadro…"). */
  asking: string | null
  error: string | null
  ask(question: string): void
  verifying?: PoChatVerifying | null
  verify?(messageId: string, minutes: number): void
  cancel?(): void
  apply?(messageId: string, index: number): void
  /** "Mandar fazer" aprovado (na conversa nova, quando a dona não está neste PC). */
  send?(messageId: string, index: number, target?: { conversationId: string; conversationTitle: string }): void
}

export function usePoChat(projectCwd: string | null, api: PoChatApi | null = appApi()): PoChatState {
  const [messages, setMessages] = useState<PoChatMessage[]>([])
  const [asking, setAsking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const apiRef = useRef(api)
  apiRef.current = api
  const cwdRef = useRef(projectCwd)
  cwdRef.current = projectCwd

  useEffect(() => {
    setMessages([])
    setError(null)
    const a = apiRef.current
    if (!projectCwd || !a || typeof a.poChatHistory !== 'function') return
    let alive = true
    void Promise.resolve(a.poChatHistory({ projectCwd }))
      .then((res) => {
        if (!alive) return
        if (res?.ok) setMessages(res.messages)
        else if (res) setError(res.message)
      })
      .catch((err: unknown) => alive && setError(String(err)))
    return () => {
      alive = false
    }
  }, [projectCwd])

  const ask = useCallback((question: string): void => {
    const text = question.trim()
    const cwd = cwdRef.current
    const a = apiRef.current
    if (!text || !cwd || !a || typeof a.poChatAsk !== 'function') return
    setAsking(text)
    setError(null)
    void Promise.resolve(a.poChatAsk({ projectCwd: cwd, question: text }))
      .then((res) => {
        if (cwdRef.current !== cwd) return
        if (res?.ok) setMessages(res.messages)
        else setError(res?.message ?? 'o PO não respondeu')
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setAsking(null))
  }, [])

  const [verifying, setVerifying] = useState<PoChatVerifying | null>(null)
  const verify = useCallback((messageId: string, minutes: number): void => {
    const cwd = cwdRef.current
    const a = apiRef.current
    if (!cwd || !a || typeof a.poChatVerify !== 'function') return
    setVerifying({ messageId, startedAt: Date.now(), minutes })
    setError(null)
    void Promise.resolve(a.poChatVerify({ projectCwd: cwd, messageId }))
      .then((res) => {
        if (cwdRef.current !== cwd) return
        if (res?.ok) setMessages(res.messages)
        else setError(res?.message ?? 'a verificação falhou')
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setVerifying(null))
  }, [])

  const cancel = useCallback((): void => {
    const cwd = cwdRef.current
    const a = apiRef.current
    if (cwd && a && typeof a.poChatCancel === 'function') void Promise.resolve(a.poChatCancel({ projectCwd: cwd })).catch(() => undefined)
  }, [])

  const apply = useCallback((messageId: string, index: number): void => {
    const cwd = cwdRef.current
    const a = apiRef.current
    if (!cwd || !a || typeof a.poChatApply !== 'function') return
    void Promise.resolve(a.poChatApply({ projectCwd: cwd, messageId, index }))
      .then((res) => {
        if (cwdRef.current !== cwd) return
        if (res?.ok) setMessages(res.messages)
        else setError(res?.message ?? 'não consegui corrigir o quadro')
      })
      .catch((err: unknown) => setError(String(err)))
  }, [])

  const send = useCallback((messageId: string, index: number, target?: { conversationId: string; conversationTitle: string }): void => {
    const cwd = cwdRef.current
    const a = apiRef.current
    if (!cwd || !a || typeof a.poChatSend !== 'function') return
    void Promise.resolve(a.poChatSend({ projectCwd: cwd, messageId, index, ...(target ?? {}) }))
      .then((res) => {
        if (cwdRef.current !== cwd) return
        if (res?.ok) setMessages(res.messages)
        else setError(res?.message ?? 'não consegui mandar')
      })
      .catch((err: unknown) => setError(String(err)))
  }, [])

  return { messages, asking, error, ask, verifying, verify, cancel, apply, send }
}
