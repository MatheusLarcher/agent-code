/**
 * "Etapas": o canvas do PC virado colunas de deslizar — uma etapa por tela
 * (título, status, estimativa), os pontos de progresso no topo (um por etapa, na
 * cor do status; tocar leva até ela) e os cards da etapa em lista. Tocar no card
 * abre a folha dele.
 */
import { useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react'
import type { PlanningCardDto } from '@shared/ipc'
import { formatMinutos } from '@shared/planningEstimate'
import { CARD_TYPE_LABEL, STAGE_STATUS_LABEL, StageStatusIcon, TypeIcon, typeColorVar } from '@renderer/planning/cardTypes'
import { useStore } from '../core/store'
import type { RemotePlan } from '../core/types'
import { cardSnippet, isOpenAmbiguity, stageColumns } from './planModel'
import { openCard, planUi } from './planState'

function CardRow({ card }: { card: PlanningCardDto }): JSX.Element {
  const snippet = cardSnippet(card.corpo)
  const links = card.links?.length ?? 0
  const anexos = card.anexos?.length ?? 0
  return (
    <button type="button" className="pl-card" style={{ '--c': typeColorVar(card.tipo) } as CSSProperties} onClick={() => openCard(card.id)}>
      <span className="pl-card-type">
        <TypeIcon tipo={card.tipo} size={13} /> {CARD_TYPE_LABEL[card.tipo] ?? card.tipo}
      </span>
      <span className="pl-card-title">{card.titulo}</span>
      {snippet && <span className="pl-card-snippet">{snippet}</span>}
      {(isOpenAmbiguity(card) || links > 0 || anexos > 0) && (
        <span className="pl-card-badges">
          {isOpenAmbiguity(card) && <span className="pl-badge amb">aberta</span>}
          {links > 0 && <span className="pl-badge">{links} {links === 1 ? 'link' : 'links'}</span>}
          {anexos > 0 && <span className="pl-badge">{anexos} {anexos === 1 ? 'anexo' : 'anexos'}</span>}
        </span>
      )}
    </button>
  )
}

export function StageColumns({ plan }: { plan: RemotePlan }): JSX.Element {
  const cols = useMemo(() => stageColumns(plan), [plan])
  const saved = useStore(planUi, (s) => s.stage)
  const stage = Math.min(saved, cols.length - 1)
  const boxRef = useRef<HTMLDivElement>(null)

  // Ao montar (voltando do Chat ou da folha): a mesma etapa de antes.
  useLayoutEffect(() => {
    const box = boxRef.current
    if (box && box.clientWidth) box.scrollLeft = planUi.get().stage * box.clientWidth
  }, [])

  const onScroll = (): void => {
    const box = boxRef.current
    if (!box || !box.clientWidth) return
    const i = Math.round(box.scrollLeft / box.clientWidth)
    if (i !== planUi.get().stage) planUi.set({ stage: i })
  }

  const go = (i: number): void => {
    planUi.set({ stage: i })
    const box = boxRef.current
    if (box) box.scrollTo?.({ left: i * box.clientWidth, behavior: 'smooth' })
  }

  return (
    <div className="pl-stages">
      <div className="pl-dots" aria-label="Etapas do plano">
        {cols.map((c, i) => (
          <button
            key={c.id ?? '-'}
            type="button"
            className={`pl-dot ${c.status ?? 'loose'}${i === stage ? ' active' : ''}`}
            aria-label={`${c.titulo}${c.status ? ` (${STAGE_STATUS_LABEL[c.status]})` : ''}`}
            aria-current={i === stage ? 'step' : undefined}
            onClick={() => go(i)}
          >
            <span />
          </button>
        ))}
      </div>
      <div className="pl-cols" ref={boxRef} onScroll={onScroll}>
        {cols.map((c, i) => (
          <section key={c.id ?? '-'} className="pl-col" aria-label={c.titulo}>
            <div className={`pl-col-head ${c.status ?? 'loose'}`}>
              <div className="pl-col-title">
                {c.status && <StageStatusIcon status={c.status} size={16} />}
                <h2>{c.titulo}</h2>
              </div>
              <div className="pl-col-meta">
                {c.id ? <span>Etapa {i + 1} de {cols.filter((x) => x.id).length}</span> : <span>Cards fora das etapas</span>}
                {c.status && <span>· {STAGE_STATUS_LABEL[c.status]}</span>}
                {typeof c.estimativa === 'number' && <span>· estimativa {formatMinutos(c.estimativa)}</span>}
                <span>· {c.cards.length} {c.cards.length === 1 ? 'card' : 'cards'}</span>
              </div>
            </div>
            <div className="pl-col-cards">
              {c.cards.length ? c.cards.map((card) => <CardRow key={card.id} card={card} />) : <div className="hist-empty">Nenhum card nesta etapa.</div>}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
