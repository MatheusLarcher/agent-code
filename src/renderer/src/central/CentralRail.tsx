/**
 * O trilho do cabeçalho da Central: um cartão por conversa trabalhando agora
 * (ícone do projeto, "projeto · conversa", bolinha pulsando e fio na cor dela).
 * O clique abre a conversa no último turno ancorado. Trilho vazio = sem filhos
 * (o chat flutuante do Escritório esconde o cabeçalho por isso).
 */
import type { CSSProperties } from 'react'
import type { CentralEntry } from '@shared/central'
import type { CentralRailCard } from './useCentral'
import { CentralGlyph } from './CentralGlyph'
import { latestAnchorMsg } from './centralView'

export interface CentralRailProps {
  rail: readonly CentralRailCard[]
  entries: readonly CentralEntry[]
  onOpen: (convId: string, msgId?: string) => void
}

export function CentralRail({ rail, entries, onOpen }: CentralRailProps): JSX.Element {
  return (
    <div className="central-head-rail" aria-label="Conversas trabalhando agora">
      {rail.map((card) => {
        const name = card.project ? `${card.project} · ${card.title}` : card.title
        return (
          <button
            key={card.convId}
            type="button"
            className="central-run"
            style={{ '--c': card.color } as CSSProperties}
            title={`${name} — trabalhando agora; clique abre a conversa`}
            aria-label={`Abrir ${name} (trabalhando agora)`}
            onClick={() => onOpen(card.convId, latestAnchorMsg(entries, card.convId))}
          >
            <CentralGlyph icon={card.icon} kind={card.sandbox ? 'sandbox' : 'project'} round />
            {card.project && <b>{card.project}</b>}
            {card.project && <span className="central-run-sep">·</span>}
            <span className="central-run-title">{card.title}</span>
            <i className="central-run-dot" />
          </button>
        )
      })}
    </div>
  )
}
