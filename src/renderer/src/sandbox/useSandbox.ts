/**
 * Fiação do modo sandbox no renderer: a raiz vinda do main e a abertura de uma
 * conversa de sandbox (reaproveita a vazia; senão subpasta nova). O App só
 * chama; as regras ficam em sandboxFlow.ts.
 */
import { useEffect, useRef, useState } from 'react'
import type { Conversation } from '../types'
import { findBlankSandboxConversation } from './sandboxFlow'

/** Raiz do sandbox (`<localDir>\sandbox`); '' até o main responder. */
export function useSandboxRoot(): { root: string; rootRef: React.MutableRefObject<string> } {
  const [root, setRoot] = useState('')
  const rootRef = useRef('')
  useEffect(() => {
    let alive = true
    void window.api
      .sandboxInfo()
      .then((info) => {
        if (!alive) return
        rootRef.current = info.root
        setRoot(info.root)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  return { root, rootRef }
}

export interface OpenSandboxDeps {
  rootRef: React.MutableRefObject<string>
  conversations: readonly Conversation[]
  activeId: string | null
  setActiveId: (id: string) => void
  createConversation: (folder: string) => Conversation
  notify: (tipo: 'erro', msg: string) => void
  /** Falha ao criar a subpasta: cai no fluxo atual (seletor de pasta). */
  fallback: () => Promise<Conversation | null>
}

/** Abre uma conversa de sandbox: a vazia que já existe, ou uma nova numa
 *  subpasta nova. Erro de disco → toast e o seletor de pasta, para o usuário
 *  nunca ficar sem conversa. */
export async function openSandboxConversation(deps: OpenSandboxDeps): Promise<Conversation | null> {
  let root = deps.rootRef.current
  if (!root) {
    root = (await window.api.sandboxInfo().catch(() => ({ root: '' }))).root
    deps.rootRef.current = root
  }
  const blank = findBlankSandboxConversation(deps.conversations, root, deps.activeId)
  if (blank) {
    deps.setActiveId(blank.id)
    return blank
  }
  const created = await window.api.sandboxCreate().catch((err: unknown) => ({ error: String(err) }))
  if ('error' in created) {
    deps.notify('erro', `Não foi possível criar a pasta do sandbox: ${created.error}`)
    return deps.fallback()
  }
  return deps.createConversation(created.path)
}
