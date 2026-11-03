/**
 * O selo discreto "Memória salva · título" embaixo da linha de passos de uma
 * resposta que gravou memória (savedMemories). O ícone é o cérebro das memórias
 * lidas (ChatMemories) com um selo no canto: + salva, ↻ atualizada, × aposentada.
 * Ao vivo (`animate`), o selo carimba o cérebro e o texto aparece como tinta; o
 * histórico não anima. PC e celular usam o mesmo componente — o PC passa
 * `wrapName` (amostra da memória no hover) e `onReveal` (botão da pasta, com o
 * arquivo selecionado no Explorador).
 */
import { useId, type CSSProperties, type ReactNode } from 'react'
import { memorySavedLabel, memorySavedVerb, type MemorySaved, type MemorySaveOp } from './memorySaved'
import './memorySaved.css'

const BADGE: Record<MemorySaveOp, JSX.Element> = {
  create: <path d="M19 15.6v4.8M16.6 18h4.8" />,
  update: <path d="M20.9 17.2a2.9 2.9 0 1 1-.9-2" />,
  retire: <path d="M17.3 16.3l3.4 3.4m0-3.4l-3.4 3.4" />
}

/** O cérebro inteiro (o mesmo das memórias lidas), com um recorte em volta do selo. */
function SavedBrain({ op }: { op: MemorySaveOp }): JSX.Element {
  const cut = `mem-saved-cut-${useId().replace(/:/g, '')}`
  return <svg className="mem-saved-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <mask id={cut}><rect x="-2" y="-2" width="28" height="28" fill="#fff" /><circle cx="19" cy="18" r="6.4" fill="#000" /></mask>
    <g mask={`url(#${cut})`}>
      <path d="M12 5a3 3 0 0 0-5.8-1A3.5 3.5 0 0 0 3 8a4 4 0 0 0-1 6 3.5 3.5 0 0 0 3 5 3.6 3.6 0 0 0 7 1V5Zm0 0a3 3 0 0 1 5.8-1A3.5 3.5 0 0 1 21 8a4 4 0 0 1 1 6 3.5 3.5 0 0 1-3 5 3.6 3.6 0 0 1-7 1" />
      <path d="M6 8c0 2 2 3 3 3m-4 4c1-1 3-1 4 0m9-7c0 2-2 3-3 3" />
    </g>
    <g className="mem-saved-badge">
      <circle cx="19" cy="18" r="4.6" fill="currentColor" stroke="none" />
      <g stroke="var(--mem-saved-badge-ink, #17151f)" strokeWidth="1.8">{BADGE[op]}</g>
    </g>
  </svg>
}

function FolderIcon(): JSX.Element {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    <path d="M10 13h6m-2.2-2.2L16 13l-2.2 2.2" />
  </svg>
}

export function MemorySavedNote({ items, animate = false, wrapName, onReveal }: {
  items: readonly MemorySaved[]
  animate?: boolean
  wrapName?: (relPath: string, label: ReactNode) => ReactNode
  onReveal?: (relPath: string) => void
}): JSX.Element | null {
  if (!items.length) return null
  return <ul className={`mem-saved${animate ? ' fresh' : ''}`} aria-label="Memórias salvas nesta resposta">
    {items.map((m, i) => {
      const label = <em>{memorySavedLabel(m)}</em>
      // Várias na mesma resposta: um carimbo de cada vez.
      const style: CSSProperties | undefined = animate ? { animationDelay: `${i * 220}ms` } : undefined
      return <li key={m.relPath || i} className={`mem-saved-item op-${m.op}`} style={style}>
        <SavedBrain op={m.op} />
        <span className="mem-saved-ink">
          <b>{memorySavedVerb(m.op)}</b> · {wrapName && m.relPath ? wrapName(m.relPath, label) : label}
        </span>
        {onReveal && m.relPath && <button type="button" className="mem-saved-reveal" data-tip="Mostrar na pasta"
          aria-label={`Mostrar ${m.relPath} na pasta`} onClick={() => onReveal(m.relPath)}><FolderIcon /></button>}
      </li>
    })}
  </ul>
}
