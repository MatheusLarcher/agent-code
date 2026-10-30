/**
 * A linha discreta "Anotei na memória · título" embaixo da linha de passos de uma
 * resposta que gravou memória (savedMemories). Ao vivo (`animate`), a pena
 * escreve: o texto aparece da esquerda para a direita como tinta e um pingo
 * assenta no fim; o histórico não anima. PC e celular usam o mesmo componente —
 * o PC passa `wrapName` para abrir a amostra da memória no hover.
 */
import type { CSSProperties, ReactNode } from 'react'
import { memorySavedLabel, memorySavedVerb, type MemorySaved } from './memorySaved'
import './memorySaved.css'

function Quill(): JSX.Element {
  return <svg className="mem-saved-quill" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 4c-6 0-11 4-13 11l-2 5" />
    <path d="M20 4c0 6-4 10-10 11" />
    <path d="M9 11h5" />
  </svg>
}

export function MemorySavedNote({ items, animate = false, wrapName }: {
  items: readonly MemorySaved[]
  animate?: boolean
  wrapName?: (relPath: string, label: ReactNode) => ReactNode
}): JSX.Element | null {
  if (!items.length) return null
  return <ul className={`mem-saved${animate ? ' fresh' : ''}`} aria-label="Memórias gravadas nesta resposta">
    {items.map((m, i) => {
      const label = <em>{memorySavedLabel(m)}</em>
      // Várias na mesma resposta: uma pena de cada vez.
      const style: CSSProperties | undefined = animate ? { animationDelay: `${i * 220}ms` } : undefined
      return <li key={m.relPath || i} className={`mem-saved-item op-${m.op}`} style={style}>
        <Quill />
        <span className="mem-saved-ink">
          {memorySavedVerb(m.op)} · {wrapName && m.relPath ? wrapName(m.relPath, label) : label}
        </span>
      </li>
    })}
  </ul>
}
