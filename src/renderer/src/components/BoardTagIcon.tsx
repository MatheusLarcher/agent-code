/**
 * Os selos do cartão do Quadro em ícone (o texto vai no tooltip, HoverTip): o que
 * o PO fez no cartão (acrescentou, corrigiu, reescreveu, revisou) e os prints.
 * O tooltip diz o fato e, quando há, o motivo ("PO corrigiu\nMotivo: …").
 */
import type { ReactNode } from 'react'

export type PoAction = 'added' | 'fixed' | 'rewrote' | 'reviewed'

export const PO_ACTION_LABEL: Record<PoAction, string> = {
  added: 'PO acrescentou',
  fixed: 'PO corrigiu',
  rewrote: 'PO reescreveu',
  reviewed: 'PO revisou'
}

const PATHS: Record<PoAction | 'camera', ReactNode> = {
  // Folha com "+".
  added: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <path d="M12 8.5v7M8.5 12h7" />
    </>
  ),
  // Chave inglesa (o PO consertou o status).
  fixed: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3.5 17.3a1.8 1.8 0 0 0 2.5 2.5l5.8-5.8a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />,
  // Lápis sobre a linha (o título reescrito).
  rewrote: (
    <>
      <path d="M15.5 4.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" />
      <path d="M13 21h8" />
    </>
  ),
  // Duplo check (revisado e confirmado).
  reviewed: <path d="m2.5 12.5 4 4 8-9M11.5 15.5l1 1 8-9" />,
  camera: (
    <>
      <path d="M4 8h3l1.6-2.5h6.8L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13" r="3.2" />
    </>
  )
}

function Glyph({ name, size = 12 }: { name: keyof typeof PATHS; size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  )
}

/** O selo do PO: "PO" + o ícone do que ele fez; o texto e o motivo no tooltip. */
export function PoTag({ action, reason }: { action: PoAction; reason?: string | null }): JSX.Element {
  const label = PO_ACTION_LABEL[action]
  const tip = reason ? `${label}\nMotivo: ${reason}` : label
  return (
    <span className={`board-tag po icon po-${action}`} data-tip={tip} aria-label={tip}>
      <span className="board-tag-po">PO</span>
      <Glyph name={action} />
    </span>
  )
}

/** Os prints da tarefa testada: câmera + número. */
export function PrintsTag({ count }: { count: number }): JSX.Element {
  const tip = count === 1 ? '1 print da tarefa testada' : `${count} prints da tarefa testada`
  return (
    <span className="board-tag prints icon" data-tip={tip} aria-label={tip}>
      <Glyph name="camera" />
      <b>{count}</b>
    </span>
  )
}
