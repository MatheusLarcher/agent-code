/**
 * "Entregas" na barra lateral: o item fixo acima dos projetos (logo abaixo da
 * Central), com o contador do que precisa de você; com a barra recolhida, só o
 * ícone com o contador, no trilho.
 */
import './deliveries.css'

export interface DeliveriesSidebarItemProps {
  /** A tela Entregas é a aberta. */
  active: boolean
  /** Envios que precisam de você: aguardando você, incompleta, parada ou atrasada. */
  count: number
  onSelect: () => void
  /** Barra recolhida: só o ícone. */
  rail?: boolean
}

export function IconDeliveries({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 8 12 3 3 8v8l9 5 9-5z" />
      <path d="M3 8l9 5 9-5" />
      <path d="M12 13v8" />
    </svg>
  )
}

function countLabel(count: number): string {
  return count === 1 ? '1 envio precisa de você' : `${count} envios precisam de você`
}

const TITLE = 'Entregas — os envios e as etapas de todos os projetos'

export function DeliveriesSidebarItem({ active, count, onSelect, rail = false }: DeliveriesSidebarItemProps): JSX.Element {
  const badge =
    count > 0 ? (
      <span className="deliveries-count" aria-label={countLabel(count)} data-testid="deliveries-count">
        {count > 99 ? '99+' : count}
      </span>
    ) : null
  const title = count > 0 ? `${TITLE}\n${countLabel(count)}` : TITLE
  if (rail) {
    return (
      <button
        type="button"
        className={`rail-btn deliveries-rail-btn${active ? ' active' : ''}`}
        title={title}
        aria-label={count > 0 ? `Entregas — ${countLabel(count)}` : 'Entregas'}
        aria-current={active ? 'page' : undefined}
        onClick={onSelect}
      >
        <IconDeliveries />
        {badge}
      </button>
    )
  }
  return (
    <button
      type="button"
      className={`deliveries-item${active ? ' active' : ''}`}
      title={title}
      aria-current={active ? 'page' : undefined}
      onClick={onSelect}
    >
      <span className="deliveries-item-ico">
        <IconDeliveries />
      </span>
      <span className="deliveries-item-text">
        <b>Entregas</b>
        <small>todos os projetos</small>
      </span>
      {badge}
    </button>
  )
}
