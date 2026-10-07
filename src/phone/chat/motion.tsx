/**
 * As animações do chat no celular, sem dependência (o estilo do React Bits):
 * `BlurText` — o texto novo do agente entra palavra a palavra, saindo do desfoque;
 * `CountUp` — um número conta até o valor (do anterior, ou de 0 na 1ª vez).
 * Só para conteúdo NOVO (o histórico já aparece pronto) — quem decide é a lista
 * (`fresh`). Com "reduzir movimento" no sistema, nada anima (CSS e aqui).
 */
import { useEffect, useRef, useState } from 'react'

const WORD_MS = 45
const COUNT_MS = 700

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Texto sem marcação de Markdown: dá para entrar palavra a palavra sem perder formatação. */
export function isPlainText(text: string): boolean {
  return !/[`*_#[\]|<>~]|^\s*(?:[-+]|\d+\.)\s|\n\s*\n/m.test(text)
}

/**
 * Palavra a palavra. No streaming o texto cresce: as palavras que já estavam ficam
 * como estão e só as novas entram — o atraso de cada uma é fixado quando ela nasce
 * (contado a partir da última leva), para a fila não acumular segundos.
 */
export function BlurText({ text }: { text: string }): JSX.Element {
  const words = text.split(/(\s+)/)
  const delays = useRef<number[]>([])
  const d = delays.current
  if (d.length > words.length) d.length = words.length
  const start = d.length
  for (let i = start; i < words.length; i++) d.push((i - start) * WORD_MS)
  return (
    <p className="blur-text">
      {words.map((w, i) =>
        /^\s+$/.test(w) || !w ? (
          w
        ) : (
          <span key={i} className="w" style={{ animationDelay: `${d[i]}ms` }}>
            {w}
          </span>
        )
      )}
    </p>
  )
}

/** Conta até `value` (easing de saída cúbica) e dá um "tique" a cada número. */
export function CountUp({ value, from = 0 }: { value: number; from?: number }): JSX.Element {
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? value : from))
  const shownRef = useRef(shown)
  shownRef.current = shown
  useEffect(() => {
    const start = shownRef.current
    if (start === value || prefersReducedMotion()) {
      setShown(value)
      return
    }
    let raf = 0
    const t0 = performance.now()
    const step = (t: number): void => {
      const k = Math.min(1, (t - t0) / COUNT_MS)
      setShown(Math.round(start + (value - start) * (1 - Math.pow(1 - k, 3))))
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return (
    <span key={shown} className={`num${shown !== value ? ' tick' : ''}`}>
      {shown}
    </span>
  )
}
