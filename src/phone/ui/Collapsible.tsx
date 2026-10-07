/**
 * Grupo recolhível (projetos da aba Conversas; a lista de Planos usa o mesmo): o
 * cabeçalho abre/fecha. Recolhido, ainda mostra quantos itens há e os sinais que
 * não podem sumir — alguém trabalhando (ponto) e alguém esperando resposta ("?").
 * As ações do cabeçalho (ex.: o "+") ficam FORA do botão de abrir/fechar.
 */
import type { ReactNode } from 'react'
import { Icon, type IconName } from './icons'

export interface CollapsibleGroupProps {
  title: string
  count: number
  open: boolean
  onToggle: () => void
  /** Algum item trabalhando agora. */
  busy?: boolean
  /** Algum item esperando resposta do usuário. */
  waiting?: boolean
  icon?: IconName
  /** Botões à direita do cabeçalho; tocar neles não abre/fecha o grupo. */
  actions?: ReactNode
  children?: ReactNode
}

export function CollapsibleGroup({ title, count, open, onToggle, busy, waiting, icon, actions, children }: CollapsibleGroupProps): JSX.Element {
  return (
    <section className={`coll-group${open ? ' open' : ''}`}>
      <div className="coll-head">
        <button type="button" className="coll-toggle" aria-expanded={open} onClick={onToggle}>
          <Icon name="chevron" size={14} className="coll-chev" />
          {icon && <Icon name={icon} size={14} />}
          <span className="coll-title">{title}</span>
          <span className="coll-count">{count}</span>
          {!open && busy && <span className="coll-busy" title="Trabalhando" aria-label="Trabalhando" />}
          {!open && waiting && <span className="coll-ask" title="Esperando sua resposta" aria-label="Esperando sua resposta">?</span>}
        </button>
        {actions}
      </div>
      {open && <div className="coll-body">{children}</div>}
    </section>
  )
}
