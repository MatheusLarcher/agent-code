/**
 * O "loading" do agente trabalhando — no lugar da antiga bolinha pulsando. Um
 * núcleo que respira e três pontos em órbita; compactando, os pontos se
 * contraem para o centro (a conversa sendo "espremida"). Só CSS
 * (chatLoader.css): anima transform/opacity, para com prefers-reduced-motion e
 * pausa fora da tela ou com a janela escondida (useVisiblePause).
 *
 * O mesmo em todo chat: principal e planejamento (ChatLive/WorkingBanner),
 * monitor do Escritório (TurnRows → ChatLive) e celular (LiveRow).
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import './chatLoader.css'

/** true quando o elemento está fora da tela ou a janela está escondida: as animações param. */
export function useVisiblePause(ref: RefObject<Element | null>): boolean {
  const [offscreen, setOffscreen] = useState(false)
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'hidden')
  useEffect(() => {
    const onVis = (): void => setHidden(document.visibilityState === 'hidden')
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1]
      if (last) setOffscreen(!last.isIntersecting)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [ref])
  return offscreen || hidden
}

export function ChatLoader({ compacting = false, className }: { compacting?: boolean; className?: string }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  const paused = useVisiblePause(ref)
  const cls = ['chat-live-loader', compacting ? 'compacting' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <span ref={ref} className={cls} aria-hidden="true" data-paused={paused ? '' : undefined}>
      <span className="cl-core" />
      <span className="cl-orbit">
        <span style={{ ['--a' as string]: '0deg' }} />
        <span style={{ ['--a' as string]: '120deg' }} />
        <span style={{ ['--a' as string]: '240deg' }} />
      </span>
    </span>
  )
}
