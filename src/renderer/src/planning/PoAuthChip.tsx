import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentCodeApi } from '@shared/api'
import { poAuthorizationLabel, type PoAuthorization, type PoAuthorizationMap } from '@shared/poAuthorization'
import './nextPrompts.css'

/**
 * A AUTORIZAÇÃO DO PO na tela: o chip "PO autorizado: commit + push · esta
 * fila" (ou "· sempre") no topo da conversa e no cabeçalho da faixa Próximos
 * prompts. Sempre visível enquanto vale — é a defesa contra uma frase mal lida.
 * Clicar abre o "Revogar".
 */

export type PoAuthApi = Pick<AgentCodeApi, 'poAuthorizationList' | 'poAuthorizationRevoke' | 'onPoAuthorizationsChanged'>

const defaultApi = (): PoAuthApi | null => ((window as unknown as { api?: PoAuthApi }).api ?? null)

/** As autorizações de todas as conversas (o main avisa quando mudam). */
export function usePoAuthorizations(api: PoAuthApi | null = defaultApi()): PoAuthorizationMap {
  const [map, setMap] = useState<PoAuthorizationMap>({})
  const apiRef = useRef(api)
  apiRef.current = api
  useEffect(() => {
    const a = apiRef.current
    if (!a || typeof a.poAuthorizationList !== 'function') return
    let alive = true
    void Promise.resolve(a.poAuthorizationList())
      .then((res) => {
        if (alive && res?.ok) setMap(res.authorizations)
      })
      .catch(() => undefined)
    const off = typeof a.onPoAuthorizationsChanged === 'function' ? a.onPoAuthorizationsChanged((next) => setMap(next ?? {})) : undefined
    return () => {
      alive = false
      off?.()
    }
  }, [])
  return map
}

export function PoAuthChip(props: {
  conversationId: string
  authorization: PoAuthorization | null | undefined
  api?: PoAuthApi | null
  onError?(message: string): void
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const api = props.api === undefined ? defaultApi() : props.api
  const revoke = useCallback(async () => {
    setOpen(false)
    const res = await api?.poAuthorizationRevoke({ conversationId: props.conversationId }).catch((err: unknown) => ({
      ok: false as const,
      message: err instanceof Error ? err.message : String(err)
    }))
    if (res && !res.ok) props.onError?.(res.message)
  }, [api, props])
  if (!props.authorization) return null
  const label = poAuthorizationLabel(props.authorization)
  return (
    <span className="po-auth-chip-wrap">
      {/* No cabeçalho estreito do chat o texto encolhe com "…"; o title guarda ele inteiro. */}
      <button
        type="button"
        className="po-auth-chip"
        title={`${label}. O PO manda o commit sozinho depois de cada prompt concluído. Clique para revogar.`}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {open && (
        <span className="po-auth-pop" role="dialog" aria-label="Autorização do PO">
          <button type="button" className="next-btn primary" onClick={() => void revoke()}>
            Revogar
          </button>
        </span>
      )}
    </span>
  )
}
