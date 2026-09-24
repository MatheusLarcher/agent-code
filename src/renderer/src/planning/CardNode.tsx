/**
 * Nó de card no canvas: faixa de cor e ícone pelo tipo, título e as 3
 * primeiras linhas do corpo. Sugestão mostra a fonte (link se é URL, texto se
 * é arquivo do projeto); ambiguidade, o
 * selo aberta/resolvida. Anexos: imagem vira miniatura, o resto etiqueta
 * (mediaView.tsx), numa faixa de altura fixa. Altura limitada a CARD_H pelo
 * CSS — o layout conta com isso para empilhar sem sobrepor.
 */
import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { PlanningCardDto } from '@shared/ipc'
import { fonteKind } from '@shared/planningFonte'
import { CARD_TYPE_LABEL, TypeIcon } from './cardTypes'
import { MediaPreview } from './mediaView'

/** Quantos anexos o nó mostra; o resto vira "+N" (a altura do nó é fixa). */
export const NODE_MEDIA_MAX = 3

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

export type SourceDisplay = { kind: 'url'; label: string; href: string } | { kind: 'arquivo'; label: string }

/**
 * Como a fonte aparece no card (regra de src/shared/planningFonte): URL vira
 * link (o domínio); arquivo do projeto vira texto (nome:linha) — não há o que
 * abrir no navegador. Fonte que não é nenhum dos dois não aparece.
 */
export function sourceDisplay(fonte: string | undefined): SourceDisplay | null {
  const kind = fonteKind(fonte)
  if (!fonte || !kind) return null
  if (kind === 'url') return { kind, label: sourceHost(fonte), href: fonte }
  return { kind, label: fonte.split(/[\\/]/).pop() || fonte }
}

function CardNodeView({ data, selected }: NodeProps<CardFlowNode>): JSX.Element {
  const { card } = data
  const preview = bodyPreview(card.corpo)
  const resolved = card.status === 'resolvida'
  const source = card.tipo === 'sugestao' ? sourceDisplay(card.fonte) : null
  const anexos = card.anexos ?? []
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
          {source?.kind === 'url' && (
            <a
              className="pl-card-source nodrag"
              href={source.href}
              target="_blank"
              rel="noreferrer"
              title={source.href}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {source.label} ↗
            </a>
          )}
          {source?.kind === 'arquivo' && (
            <span className="pl-card-source file" title={`Arquivo do projeto: ${card.fonte}`}>
              {source.label}
            </span>
          )}
        </div>
        <div className="pl-card-title" title={card.titulo}>
          {card.titulo}
        </div>
        {anexos.length > 0 && (
          <div className="pl-card-media" aria-label={`${anexos.length} anexo${anexos.length === 1 ? '' : 's'}`}>
            {anexos.slice(0, NODE_MEDIA_MAX).map((name) => (
              <MediaPreview key={name} name={name} />
            ))}
            {anexos.length > NODE_MEDIA_MAX && <span className="pl-media-more">+{anexos.length - NODE_MEDIA_MAX}</span>}
          </div>
        )}
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
