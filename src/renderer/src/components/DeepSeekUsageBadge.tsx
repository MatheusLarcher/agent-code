import { useEffect, useRef, useState } from 'react'
import type { DeepSeekBalance } from '@shared/ipc'
import type { ToastType } from '../ui/UiProvider'

/** "1,23" (pt-BR); centavos de centavo ganham 4 casas para não virar "0,00". */
export function fmtUsd(v: number): string {
  const digits = v !== 0 && Math.abs(v) < 0.01 ? 4 : 2
  return v.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export const DEEPSEEK_UNAVAILABLE_WARNING =
  'DeepSeek sem saldo disponível: as próximas mensagens vão falhar até você recarregar a conta em platform.deepseek.com.'

/**
 * Saldo da conta DeepSeek para a conversa ativa. Lê ao abrir uma conversa
 * DeepSeek e de novo a cada `refreshKey` novo (o fim de um turno); sem polling.
 * Avisa uma vez quando a conta passa a `is_available=false`.
 */
export function useDeepSeekBalance(
  active: boolean,
  refreshKey: string,
  notify: (tipo: ToastType, msg: string) => void
): DeepSeekBalance | null {
  const [balance, setBalance] = useState<DeepSeekBalance | null>(null)
  const warned = useRef(false)
  const notifyRef = useRef(notify)
  notifyRef.current = notify

  useEffect(() => {
    if (!active) return
    let alive = true
    void window.api
      .deepseekBalance()
      .catch(() => null)
      .then((b) => {
        if (!alive) return
        setBalance(b)
        if (b && !b.available && !warned.current) notifyRef.current('aviso', DEEPSEEK_UNAVAILABLE_WARNING)
        warned.current = !!b && !b.available
      })
    return () => {
      alive = false
    }
  }, [active, refreshKey])

  return active ? balance : null
}

interface Props {
  balance: DeepSeekBalance | null
  /** Custo estimado acumulado da conversa (main calcula por turno). */
  convCostUsd: number
}

/** "DeepSeek · saldo US$ X · conversa ~US$ Y (estimado)" na barra de cima. */
export function DeepSeekUsageBadge({ balance, convCostUsd }: Props): JSX.Element {
  const saldo = balance?.totalUsd != null ? `US$ ${fmtUsd(balance.totalUsd)}` : '—'
  const text = `DeepSeek · saldo ${saldo} · conversa ~US$ ${fmtUsd(convCostUsd)} (estimado)`
  const off = balance ? !balance.available : false
  return (
    <div
      className={`usage-badge deepseek-usage${off ? ' crit' : ''}`}
      title="Saldo lido da sua conta DeepSeek ao abrir a conversa e no fim de cada turno. O custo da conversa é estimado pelo preço de pico (cache, entrada e saída)."
    >
      <span className="usage-provider muted">{text}</span>
    </div>
  )
}
