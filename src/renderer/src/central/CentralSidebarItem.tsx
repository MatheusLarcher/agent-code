/**
 * A Central na barra lateral: o item fixo no topo, acima do grupo "Sandbox"
 * (orbe + "Central" + "fale com o agent" + as bolinhas dos destinos), e, com a
 * barra recolhida, só o orbe como primeiro item do trilho.
 */
import { CENTRAL_TITLE } from '@shared/central'
import './central.css'
import './centralFeed.css'

export interface CentralSidebarItemProps {
  /** A Central é a conversa aberta. */
  active: boolean
  onSelect: () => void
  /** Cores dos destinos trabalhando agora (a Etapa 6 preenche); vazio = nenhuma bolinha. */
  dots?: readonly string[]
  /** Barra recolhida: só o orbe. */
  rail?: boolean
}

/** Na linha de uma conversa da barra: destino da Central trabalhando agora, na cor dele. */
export function CentralRowDot({ color }: { color: string }): JSX.Element {
  return (
    <i
      className="conv-central-dot"
      style={{ background: color }}
      title="Trabalhando num pedido da Central"
      aria-hidden="true"
      data-testid="conv-central-dot"
    />
  )
}

const TITLE ='Central — fale com o agent: cada mensagem vai para a conversa do assunto'

export function CentralSidebarItem({ active, onSelect, dots = [], rail = false }: CentralSidebarItemProps): JSX.Element {
  if (rail) {
    return (
      <button
        type="button"
        className={`rail-btn central-rail-btn${active ? ' active' : ''}`}
        title={TITLE}
        aria-label={CENTRAL_TITLE}
        aria-current={active ? 'page' : undefined}
        onClick={onSelect}
      >
        <span className="central-orb" aria-hidden="true" />
      </button>
    )
  }
  return (
    <button
      type="button"
      className={`central-item${active ? ' active' : ''}`}
      title={TITLE}
      aria-current={active ? 'page' : undefined}
      onClick={onSelect}
    >
      <span className="central-orb" aria-hidden="true" />
      <span className="central-item-text">
        <b>{CENTRAL_TITLE}</b>
        <small>fale com o agent</small>
      </span>
      <span className="central-dots" aria-hidden="true">
        {dots.map((color, i) => (
          <i key={`${color}-${i}`} style={{ background: color }} />
        ))}
      </span>
    </button>
  )
}
