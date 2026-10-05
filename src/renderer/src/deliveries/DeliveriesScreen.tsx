import { useEffect, useMemo, useState } from 'react'
import { DeliveryEnvioRow } from './DeliveryEnvioRow'
import { IconDeliveries } from './DeliveriesSidebarItem'
import {
  DELIVERY_FILTERS,
  FILTER_LABEL,
  filterCounts,
  needsUserCount,
  visibleEnvios,
  type DeliveryFilter
} from './deliveryModel'
import type { DeliveriesState } from './useDeliveries'
import './deliveries.css'

/**
 * A tela Entregas: todos os envios de todos os projetos, do banco. Primeiro o
 * que precisa de você; cada envio abre as entregas dele, com a correção manual.
 * Relê ao abrir e a cada handoff:changed (o hook do App assina).
 */

export interface DeliveriesScreenProps {
  state: DeliveriesState
  onOpenConversation: (conversationId: string) => void
}

export function DeliveriesScreen({ state, onOpenConversation }: DeliveriesScreenProps): JSX.Element {
  const { envios, error, refresh, correct } = state
  const [filter, setFilter] = useState<DeliveryFilter | null>(null)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  // Ao abrir, relê: o que mudou com a tela fechada aparece já.
  useEffect(() => {
    refresh()
  }, [refresh])

  const all = useMemo(() => envios ?? [], [envios])
  const list = useMemo(() => visibleEnvios(all, filter, query), [all, filter, query])
  const counts = useMemo(() => filterCounts(all, query), [all, query])
  const pending = needsUserCount(all)

  const toggle = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <section className="dlv-screen" aria-label="Entregas">
      <header className="dlv-head">
        <span className="dlv-head-ico">
          <IconDeliveries size={20} />
        </span>
        <div className="dlv-head-text">
          <h1>Entregas</h1>
          <small>
            {envios === null
              ? 'todos os projetos'
              : `${all.length} ${all.length === 1 ? 'envio' : 'envios'} de todos os projetos${pending > 0 ? ` · ${pending} ${pending === 1 ? 'precisa' : 'precisam'} de você` : ''}`}
          </small>
        </div>
        <button type="button" className="btn ghost dlv-refresh" onClick={refresh} title="Ler de novo do banco">
          Atualizar
        </button>
      </header>

      <div className="dlv-tools">
        <input
          className="dlv-search"
          type="search"
          value={query}
          placeholder="Buscar por projeto, plano, conversa ou etapa…"
          aria-label="Buscar entregas"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="dlv-filters" role="group" aria-label="Filtros">
          {DELIVERY_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className={`dlv-filter f-${f}${filter === f ? ' on' : ''}`}
              aria-pressed={filter === f}
              onClick={() => setFilter((cur) => (cur === f ? null : f))}
            >
              {FILTER_LABEL[f]}
              <span className="dlv-filter-n">{counts[f]}</span>
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="dlv-error" role="alert">
          Não consegui ler as entregas do banco: {error}
        </div>
      )}

      <div className="dlv-body">
        {envios === null ? (
          !error && <div className="dlv-empty">Carregando entregas…</div>
        ) : all.length === 0 ? (
          <div className="dlv-empty">
            Nenhum envio registrado ainda. Os prompts mandados pelo &quot;Enviar para implementação&quot; aparecem aqui.
          </div>
        ) : list.length === 0 ? (
          <div className="dlv-empty">Nenhum envio com esse filtro ou busca.</div>
        ) : (
          <ul className="dlv-list" aria-label="Envios">
            {list.map((envio) => (
              <DeliveryEnvioRow
                key={envio.id}
                envio={envio}
                expanded={expanded.has(envio.id)}
                onToggle={() => toggle(envio.id)}
                onOpenConversation={onOpenConversation}
                correct={correct}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
