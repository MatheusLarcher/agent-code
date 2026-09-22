/**
 * Nó de card no canvas: faixa de cor e ícone pelo tipo, título e as 3
 * primeiras linhas do corpo. Sugestão mostra o link da fonte; ambiguidade, o
 * selo aberta/resolvida. Altura limitada a CARD_H pelo CSS — o layout conta
 * com isso para empilhar sem sobrepor.
 */
import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { PlanningCardDto } from '@shared/ipc'
import { CARD_TYPE_LABEL, TypeIcon } from './cardTypes'

export type CardNodeData = { card: PlanningCardDto }
export type CardFlowNode = Node<CardNodeData, 'card'>

const MD_PREFIX = /^\s{0,3}(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|>\s?|\d+[.)]\s+)/

/** As `max` primeiras linhas com texto, sem o marcador markdown do começo. */
export function bodyPreview(corpo: string, max = 3): string[] {
  const out: string[] = []
  for (const raw of corpo.split(/\r?\n/)) {
    if (out.length >= max) break
    const line = raw.replace(MD_PREFIX, '').replace(/\*\*|__/g, '').trim()
    if (line && !/^(?:-{3,}|`{3,}.*)$/.test(line)) out.push(line)
  }
  return out
}

/** Domínio da fonte, para caber no card (o link inteiro vai no title). */
export function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function CardNodeView({ data, selected }: NodeProps<CardFlowNode>): JSX.Element {
  const { card } = data
  const preview = bodyPreview(card.corpo)
  const resolved = card.status === 'resolvida'
  return (
    <div className={`pl-card${selected ? ' selected' : ''}`} data-tipo={card.tipo} data-testid={`pl-card-${card.id}`}>
      <Handle type="target" position={Position.Left} className="pl-handle" />
      {/* O corte de altura fica no miolo: no card ele esconderia meia alça. */}
      <div className="pl-card-inner">
        <div className="pl-card-top">
          <span className="pl-card-type">
            <TypeIcon tipo={card.tipo} size={13} />
            {CARD_TYPE_LABEL[card.tipo] ?? card.tipo}
          </span>
          {card.tipo === 'ambiguidade' && (
            <span className={`pl-seal ${resolved ? 'resolvida' : 'aberta'}`}>{resolved ? 'resolvida' : 'aberta'}</span>
          )}
          {card.tipo === 'sugestao' && card.fonte && (
            <a
              className="pl-card-source nodrag"
              href={card.fonte}
              target="_blank"
              rel="noreferrer"
              title={card.fonte}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {sourceHost(card.fonte)} ↗
            </a>
          )}
        </div>
        <div className="pl-card-title" title={card.titulo}>
          {card.titulo}
        </div>
        {preview.length > 0 && (
          <div className="pl-card-body">
            {preview.map((line, i) => (
              <p key={i}>{line}</p>
            ))}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="pl-handle" />
    </div>
  )
}

export const CardNode = memo(CardNodeView)
