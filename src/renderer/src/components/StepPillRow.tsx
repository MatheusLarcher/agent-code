/**
 * As pílulas da linha de passos (PC e celular): o ícone do tipo + o número; o
 * texto ("4 buscas", "1 subagente") vai no tooltip (HoverTip) e no aria-label.
 * `count` desenha o número (o CountUp de cada lado anima o que chegou ao vivo).
 */
import type { ReactNode } from 'react'
import { pillTip, StepKindIcon } from './StepKindIcon'
import type { StepPill } from './stepPills'
import './stepPill.css'

export function StepPillRow({ pills, count = (n) => n }: { pills: readonly StepPill[]; count?: (n: number) => ReactNode }): JSX.Element | null {
  if (pills.length === 0) return null
  return (
    <span className="chat-pills">
      {pills.map((p) => (
        <span key={p.kind} className={`chat-pill k-${p.kind}`} data-tip={pillTip(p)} aria-label={pillTip(p)}>
          <StepKindIcon kind={p.kind} size={12} className="chat-pill-ico" />
          <b>{count(p.n)}</b>
        </span>
      ))}
    </span>
  )
}
