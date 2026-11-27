/** Aviso discreto no topo de um visualizador (arquivo cortado, JSON inválido…). */
import type { ReactNode } from 'react'
import { IconWarning } from '../../components/Icons'
import './viewers.css'

export function ViewerNotice({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="pv-notice" role="status">
      <IconWarning size={14} aria-hidden="true" />
      <span>{children}</span>
    </div>
  )
}
