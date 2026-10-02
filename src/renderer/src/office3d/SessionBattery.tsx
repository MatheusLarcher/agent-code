/**
 * Bateria HTML da SESSÃO 5h da conta, na barra do modo 3D: a mesma janela
 * `five_hour` de usageLimits que o cabeçalho mostra como "Sessão 5h". Carga =
 * o que resta da janela; o tempo até resetar vem junto. Sem dado, não aparece.
 */
import { useEffect, useState } from 'react'
import type { FeedSource } from './engine'
import { sessionBattery, type SessionBattery as Battery } from './battery'

const sigOf = (b: Battery | null): string => (b ? `${b.percent}|${b.level}|${b.resetText}|${b.rejected}` : '')

export function SessionBattery({ source }: { source: FeedSource }): JSX.Element | null {
  const [battery, setBattery] = useState<Battery | null>(() => sessionBattery(source.getSnapshot()?.usageLimits, Date.now()))

  useEffect(() => {
    let last = sigOf(battery)
    const update = (): void => {
      const next = sessionBattery(source.getSnapshot()?.usageLimits, Date.now())
      const sig = sigOf(next)
      if (sig === last) return
      last = sig
      setBattery(next)
    }
    update()
    const off = source.subscribe(update)
    // O "reseta em" anda sozinho; um tique por minuto basta.
    const id = setInterval(update, 30_000)
    return () => {
      off()
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source])

  if (!battery) return null
  const title = `Sessão 5h da conta: ${battery.usedPercent}% usado, ${battery.percent}% restante${battery.resetText ? ` — ${battery.resetText}` : ''}.`
  return (
    <div className={`o3d-battery ${battery.level}`} title={title} data-testid="o3d-session-battery">
      <span className="o3d-battery-cap">Sessão 5h</span>
      <span className="o3d-battery-body" aria-hidden="true">
        <span className="o3d-battery-fill" style={{ width: `${battery.percent}%`, background: battery.color }} />
      </span>
      <span className="o3d-battery-val">{battery.rejected ? 'esgotada' : `${battery.percent}%`}</span>
      {battery.resetText && <span className="o3d-battery-reset">{battery.resetText}</span>}
    </div>
  )
}
