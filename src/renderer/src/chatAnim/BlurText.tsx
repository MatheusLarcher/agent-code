/**
 * BlurText para texto puro (chips, avisos): palavra a palavra, do borrado ao
 * nítido, 45 ms entre uma e outra. Sem `animate`, é só o texto.
 */
import type { CSSProperties } from 'react'

export function BlurText({ text, animate, delayMs = 0 }: { text: string; animate: boolean; delayMs?: number }): JSX.Element {
  if (!animate) return <>{text}</>
  let n = 0
  return (
    <>
      {text.split(/(\s+)/).map((part, k) =>
        !part || /^\s+$/.test(part) ? (
          part
        ) : (
          <span key={k} className="ca-w" style={{ '--i': n++, '--d': `${delayMs}ms` } as CSSProperties}>
            {part}
          </span>
        )
      )}
    </>
  )
}
