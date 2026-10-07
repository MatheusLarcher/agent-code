/**
 * A folha de baixo com o card inteiro: tipo, status, etapa, fonte, o corpo em
 * Markdown (os [[…]] na cor do tipo e tocáveis: levam ao card citado), as
 * ligações, as imagens anexas (pela ponte) e "Comentar no chat" — no celular a
 * mudança de card é pedida ao Agent Manager.
 */
import { useMemo, type CSSProperties, type MouseEvent } from 'react'
import type { PlanningCardDto } from '@shared/ipc'
import { Markdown } from '@renderer/components/Markdown'
import { makeRefResolver } from '@renderer/planning/cardRefs'
import { CARD_TYPE_LABEL, TypeIcon, typeColorVar } from '@renderer/planning/cardTypes'
import { client } from '../app/runtime'
import { planMediaUrl } from '../core/planning'
import { useStore } from '../core/store'
import { Icon } from '../ui/icons'
import { cardAttachments, isOpenAmbiguity, isWebFonte } from './planModel'
import { closeCard, commentOnCard, openCard, planUi } from './planState'

const typeStyle = (c: PlanningCardDto): CSSProperties => ({ '--c': typeColorVar(c.tipo) }) as CSSProperties

export function CardSheet(): JSX.Element | null {
  const plan = useStore(planUi, (s) => s.plan)
  const open = useStore(planUi, (s) => s.open)
  const id = useStore(planUi, (s) => s.card)
  const resolve = useMemo(() => makeRefResolver(plan?.cards ?? []), [plan])
  const card = plan?.cards.find((c) => c.id === id)
  if (!plan || !open || !card) return null

  const etapa = plan.roteiro.etapas.find((e) => e.id === card.etapa)
  const linked = (card.links ?? []).map((l) => plan.cards.find((c) => c.id === l)).filter((c): c is PlanningCardDto => !!c)
  const { images, others } = cardAttachments(card, plan.media)
  const status = card.tipo === 'ambiguidade' ? (isOpenAmbiguity(card) ? 'aberta' : 'resolvida') : card.status

  // [[Nome]] no corpo vira a pílula do Markdown (span); o toque nela abre o card citado.
  const onBodyClick = (e: MouseEvent<HTMLDivElement>): void => {
    const chip = (e.target as HTMLElement).closest('.pl-card-ref')
    const target = chip?.textContent ? resolve(chip.textContent) : null
    if (target) openCard(target.id)
  }

  return (
    <div className="modal-overlay" onClick={closeCard}>
      <div className="modal-card pl-sheet" role="dialog" aria-label={card.titulo} style={typeStyle(card)} onClick={(e) => e.stopPropagation()}>
        <div className="pl-sheet-head">
          <span className="pl-card-type">
            <TypeIcon tipo={card.tipo} size={14} /> {CARD_TYPE_LABEL[card.tipo] ?? card.tipo}
          </span>
          {status && <span className={`pl-badge${status === 'aberta' ? ' amb' : ''}`}>{status}</span>}
          <button type="button" className="icon-btn pl-sheet-x" aria-label="Fechar" onClick={closeCard}>
            <Icon name="x" size={20} />
          </button>
        </div>
        <div className="pl-sheet-body">
          <h2 className="pl-sheet-title">{card.titulo}</h2>
          <div className="pl-sheet-meta">
            {etapa ? <span>Etapa: {etapa.titulo}</span> : <span>Sem etapa</span>}
            {card.fonte && (
              <span className="pl-fonte">
                Fonte:{' '}
                {isWebFonte(card.fonte) ? (
                  <a href={card.fonte} target="_blank" rel="noreferrer">{card.fonte}</a>
                ) : (
                  <code>{card.fonte}</code>
                )}
              </span>
            )}
          </div>
          <div className="pl-sheet-md"onClick={onBodyClick}>
            {card.corpo.trim() ? <Markdown text={card.corpo} resolveRef={resolve} /> : <span className="hist-empty">Card sem texto.</span>}
          </div>
          {images.length > 0 && (
            <div className="pl-sheet-imgs">
              {images.map((name) => (
                <a key={name} href={planMediaUrl(client, open.cwd, open.slug, name)} target="_blank" rel="noreferrer">
                  <img src={planMediaUrl(client, open.cwd, open.slug, name)} alt={name} loading="lazy" />
                </a>
              ))}
            </div>
          )}
          {others.length > 0 && (
            <div className="pl-sheet-files">
              {others.map((name) => (
                <span key={name} className="file-chip" title="Abra no PC">📎 {name}</span>
              ))}
            </div>
          )}
          {linked.length > 0 && (
            <div className="pl-sheet-links">
              <div className="pl-sheet-label">Ligado a</div>
              {linked.map((c) => (
                <button key={c.id} type="button" className="pl-link" style={typeStyle(c)} onClick={() => openCard(c.id)}>
                  <TypeIcon tipo={c.tipo} size={14} />
                  <span>{c.titulo}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="pl-sheet-actions">
          <button type="button" className="btn primary big" onClick={() => commentOnCard(card.id)}>
            <Icon name="chat" size={18} /> Comentar no chat
          </button>
        </div>
      </div>
    </div>
  )
}
