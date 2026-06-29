import { useEffect, useRef } from 'react'

/**
 * Thin countdown bar that drains from RIGHT to LEFT until `deadline` (epoch ms),
 * when the agent auto-resolves the modal. Purely visual — the authoritative timer
 * lives in the main process. Driven by a single CSS transition (no re-renders).
 */
export function CountdownBar({ deadline }: { deadline?: number }): JSX.Element | null {
  const fillRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = fillRef.current
    if (!el || !deadline) return
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      el.style.transform = 'scaleX(0)'
      return
    }
    // Start full, then animate to empty over the remaining time. transform-origin
    // is the LEFT edge, so the bar shrinks toward the left → empties right→left.
    el.style.transition = 'none'
    el.style.transform = 'scaleX(1)'
    void el.offsetWidth // force a reflow so the next change animates
    requestAnimationFrame(() => {
      el.style.transition = `transform ${remaining}ms linear`
      el.style.transform = 'scaleX(0)'
    })
  }, [deadline])

  if (!deadline) return null
  return (
    <div className="countdown-track" aria-hidden="true">
      <div className="countdown-fill" ref={fillRef} />
    </div>
  )
}
