/**
 * CountUp (no estilo React Bits, sem dependência): o número sobe de 0 (ou do
 * valor anterior) até `value` em ~700 ms com easeOutCubic, e cada passo dá um
 * "tique" curto (.ca-tick). Sem `animate`, é só o número — o histórico e o
 * prefers-reduced-motion caem aqui.
 */
import { useEffect, useRef, useState } from 'react'

const ease = (k: number): number => 1 - Math.pow(1 - k, 3)

export function CountUp({ value, animate, duration = 700 }: { value: number; animate: boolean; duration?: number }): JSX.Element {
  const [shown, setShown] = useState(animate ? 0 : value)
  const from = useRef(animate ? 0 : value)
  useEffect(() => {
    if (!animate) return
    const start = from.current
    if (start === value) return
    let raf = 0
    const t0 = performance.now()
    const step = (t: number): void => {
      const k = Math.min(1, Math.max(0, (t - t0) / duration))
      const v = Math.round(start + (value - start) * ease(k))
      from.current = v
      setShown(v)
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value, animate, duration])
  if (!animate) return <span className="ca-num">{value}</span>
  // A chave muda a cada valor: o span renasce e o "tique" toca de novo.
  return (
    <span key={shown} className="ca-num ca-tick">
      {shown}
    </span>
  )
}
