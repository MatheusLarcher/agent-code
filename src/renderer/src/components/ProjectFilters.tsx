import { useState } from 'react'
import type { Turn } from '../projectActivity'
import { ACTION_COLORS, ACTION_LABELS, type ActionKind } from '../projectActivity'
import { IconChevronDown } from './Icons'

/**
 * The map's controls: which message to follow, and which file types to show.
 *
 * Kept apart from `ProjectGraph` because that file is all canvas and rAF — this
 * is plain React that only re-renders when the user clicks something.
 */

interface Props {
  /** User messages that produced work, oldest first. */
  turns: Turn[]
  /** Currently followed message (null = the whole session). */
  turnId: string | null
  onPickTurn: (id: string | null) => void
  /** File types present in the map, most frequent first. */
  types: { type: string; count: number }[]
  /** Types the user switched OFF — those files leave the map. */
  hidden: Set<string>
  onToggleType: (type: string) => void
  onShowAllTypes: () => void
  /** Action families actually used in the session — the legend only shows these. */
  kinds: ActionKind[]
  /** Kinds of modification switched OFF (those actions stop lighting nodes). */
  hiddenKinds: Set<ActionKind>
  onToggleKind: (kind: ActionKind) => void
}

/** Types listed before the "+N" expander — enough to cover a normal project. */
const TYPES_SHOWN = 10

export function ProjectFilters({
  turns,
  turnId,
  onPickTurn,
  types,
  hidden,
  onToggleType,
  onShowAllTypes,
  kinds,
  hiddenKinds,
  onToggleKind
}: Props): JSX.Element {
  const [openTurns, setOpenTurns] = useState(false)
  const [openTypes, setOpenTypes] = useState(false)
  const [allTypes, setAllTypes] = useState(false)

  const current = turns.find((t) => t.id === turnId) ?? null
  const shown = allTypes ? types : types.slice(0, TYPES_SHOWN)
  const rest = types.length - shown.length

  return (
    <div className="pgraph-filters">
      <div className="pgraph-filter-row">
        <button
          type="button"
          className={`pgraph-filter-btn${current ? ' on' : ''}`}
          onClick={() => setOpenTurns((v) => !v)}
          aria-expanded={openTurns}
          title="Filtrar o mapa por uma mensagem que você enviou"
          disabled={turns.length === 0}
        >
          <span className="pgraph-filter-label">
            {current ? `#${current.index} ${current.label}` : `Mensagens (${turns.length})`}
          </span>
          <IconChevronDown size={12} />
        </button>
        {current && (
          <button
            type="button"
            className="pgraph-filter-clear"
            onClick={() => onPickTurn(null)}
            title="Mostrar a sessão inteira"
          >
            limpar
          </button>
        )}
        <button
          type="button"
          className={`pgraph-filter-btn${hidden.size ? ' on' : ''}`}
          onClick={() => setOpenTypes((v) => !v)}
          aria-expanded={openTypes}
          title="Escolher quais tipos de arquivo aparecem"
        >
          <span className="pgraph-filter-label">
            {hidden.size ? `Tipos (−${hidden.size})` : 'Tipos'}
          </span>
          <IconChevronDown size={12} />
        </button>
      </div>

      {openTurns && (
        <ol className="pgraph-turns">
          <li>
            <button
              type="button"
              className={turnId === null ? 'on' : ''}
              onClick={() => {
                onPickTurn(null)
                setOpenTurns(false)
              }}
            >
              <span className="pgraph-turn-idx">tudo</span>
              <span className="pgraph-turn-text">a sessão inteira</span>
            </button>
          </li>
          {turns.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className={t.id === turnId ? 'on' : ''}
                onClick={() => {
                  onPickTurn(t.id === turnId ? null : t.id)
                  setOpenTurns(false)
                }}
                title={t.label}
              >
                <span className="pgraph-turn-idx">{t.index ? `#${t.index}` : '·'}</span>
                <span className="pgraph-turn-text">{t.label}</span>
                <span className="pgraph-turn-count">
                  {t.files ? `${t.files} arq` : `${t.calls} ações`}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}

      {openTypes && (
        <div className="pgraph-types">
          {shown.map((t) => (
            <button
              key={t.type}
              type="button"
              className={`pgraph-type${hidden.has(t.type) ? ' off' : ''}`}
              onClick={() => onToggleType(t.type)}
              title={hidden.has(t.type) ? `Mostrar arquivos .${t.type}` : `Esconder arquivos .${t.type}`}
              aria-pressed={!hidden.has(t.type)}
            >
              .{t.type}
              <span className="pgraph-type-count">{t.count}</span>
            </button>
          ))}
          {rest > 0 && (
            <button type="button" className="pgraph-type more" onClick={() => setAllTypes(true)}>
              +{rest}
            </button>
          )}
          {hidden.size > 0 && (
            <button type="button" className="pgraph-type reset" onClick={onShowAllTypes}>
              mostrar tudo
            </button>
          )}
        </div>
      )}

      {/* A legenda É o filtro por tipo de modificação: a cor já diz o que cada
          uma significa, então clicar nela pra ligar/desligar é o gesto óbvio —
          um segundo menu só pra isso seria repetir a mesma lista. */}
      {kinds.length > 0 && (
        <div className="pgraph-kinds">
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              className={hiddenKinds.has(k) ? 'off' : ''}
              onClick={() => onToggleKind(k)}
              aria-pressed={!hiddenKinds.has(k)}
              title={hiddenKinds.has(k) ? `Mostrar o que o agente ${ACTION_LABELS[k]}` : `Esconder o que o agente ${ACTION_LABELS[k]}`}
            >
              <i style={{ background: ACTION_COLORS[k] }} />
              {ACTION_LABELS[k]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
