/**
 * Tela de Planejamento: cabeçalho com o título do plano (e o espaço
 * `headerActions`, onde a integração põe o botão de enviar), o roteiro como
 * checklist à esquerda (recolhível num trilho), o canvas no centro e o chat
 * (`chatSlot`) à direita, com um divisor arrastável entre os dois.
 *
 * Componente isolado: recebe só projectCwd + slug e conversa com o main pelo
 * usePlanning. Largura do chat e roteiro recolhido valem entre sessões.
 */
import '@xyflow/react/dist/style.css'
import './planning.css'
import './planningLayout.css'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import type { OpenedPlanningDto, PlanningCardDto } from '@shared/ipc'
import { IconSpinner, IconWarning } from '../components/Icons'
import { useUI } from '../ui/UiProvider'
import { CardEditor } from './CardEditor'
import { ChatSplitter } from './ChatSplitter'
import { PlanningCanvas } from './PlanningCanvas'
import { ProgressList } from './ProgressList'
import { FIT_MIN_ZOOM } from './canvasViewport'
import { columnFocusPoint, computeLayout } from './layout'
import { loadChatWidth, loadRoteiroCollapsed, saveChatWidth, saveRoteiroCollapsed } from './paneSizes'
import { PlanningPlanContext } from './planningPlanContext'
import { usePlanning } from './usePlanning'

export interface PlanningScreenProps {
  /** Pasta do projeto (absoluta). */
  projectCwd: string
  /** Plano em docs/spec/<slug>/. */
  slug: string
  /** Painel de conversa com o agente, à direita. */
  chatSlot?: ReactNode
  /** Ações no canto direito do cabeçalho (ex.: enviar para implementação).
   *  Leem o plano aberto por useOpenedPlan (planningPlanContext). */
  headerActions?: ReactNode
}

interface Editing {
  card: PlanningCardDto
  isNew: boolean
}

function blankCard(etapa?: string): PlanningCardDto {
  const card: PlanningCardDto = { id: '', tipo: 'nota', titulo: '', links: [], rev: 0, corpo: '' }
  if (etapa) card.etapa = etapa
  return card
}

function InvalidCards({ invalid }: { invalid: OpenedPlanningDto['invalid'] }): JSX.Element {
  const n = invalid.length
  return (
    <div className="pl-invalid" role="alert">
      <div className="pl-invalid-head">
        <IconWarning size={14} />
        <strong>
          {n === 1 ? '1 card não carregou' : `${n} cards não carregaram`}
        </strong>
        <span>— corrija o arquivo ou peça ao agente para refazer:</span>
      </div>
      <ul>
        {invalid.map((item) => (
          <li key={item.file}>
            <code>{item.file}</code> <span className="pl-invalid-why">{item.error}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function EmptyPlan({ onNewCard }: { onNewCard: () => void }): JSX.Element {
  return (
    <div className="pl-empty">
      <div className="pl-empty-card">
        <h2>Plano em branco</h2>
        <p>
          Converse com o agente ao lado para separar o trabalho em etapas — cada etapa vira uma coluna aqui, com os
          requisitos, decisões e dúvidas embaixo.
        </p>
        <button type="button" className="pl-add" onClick={onNewCard}>
          + Card
        </button>
      </div>
    </div>
  )
}

/** Largura do chat (arrastável, lembrada) e roteiro recolhido (lembrado). */
function usePanes(): {
  chatWidth: number
  setChatWidth: (w: number) => void
  commitChatWidth: (w: number) => void
  roteiroCollapsed: boolean
  toggleRoteiro: () => void
} {
  const [chatWidth, setChatWidth] = useState(loadChatWidth)
  const [roteiroCollapsed, setRoteiroCollapsed] = useState(loadRoteiroCollapsed)
  const commitChatWidth = useCallback((w: number) => {
    setChatWidth(w)
    saveChatWidth(w)
  }, [])
  const toggleRoteiro = useCallback(() => {
    setRoteiroCollapsed((v) => {
      saveRoteiroCollapsed(!v)
      return !v
    })
  }, [])
  return { chatWidth, setChatWidth, commitChatWidth, roteiroCollapsed, toggleRoteiro }
}

function PlanningScreenBody({ projectCwd, slug, chatSlot, headerActions }: PlanningScreenProps): JSX.Element {
  const { status, plan, error, reload, saveCard, deleteCard, saveLayout, saveViewport, toggleEtapa } = usePlanning(
    projectCwd,
    slug
  )
  const { confirm } = useUI()
  const flow = useReactFlow()
  const [editing, setEditing] = useState<Editing | null>(null)
  const { chatWidth, setChatWidth, commitChatWidth, roteiroCollapsed, toggleRoteiro } = usePanes()
  const bodyRef = useRef<HTMLDivElement>(null)
  const bodyWidth = useCallback(() => bodyRef.current?.getBoundingClientRect().width ?? 0, [])

  // Trocar de plano fecha o editor: o card aberto era do plano anterior.
  useEffect(() => setEditing(null), [projectCwd, slug])

  const roteiro = plan?.roteiro
  const cards = plan?.cards
  const positions = plan?.layout.positions
  const layout = useMemo(
    () => (roteiro && cards ? computeLayout(roteiro, cards, positions) : null),
    [roteiro, cards, positions]
  )

  const openCard = useCallback((card: PlanningCardDto) => setEditing({ card, isNew: false }), [])
  const newCard = useCallback((etapa?: string) => setEditing({ card: blankCard(etapa), isNew: true }), [])

  const handleSave = useCallback(
    async (card: PlanningCardDto, expectedRev: number): Promise<void> => {
      const out = await saveCard(card, expectedRev)
      if (out.ok) setEditing(null)
      // Conflito: o editor reabre com a versão do disco (o toast já avisou).
      else if (out.conflict) setEditing(out.current ? { card: out.current, isNew: false } : null)
    },
    [saveCard]
  )

  const deleteCards = useCallback(
    async (list: PlanningCardDto[]): Promise<void> => {
      if (!list.length) return
      const one = list.length === 1
      const ok = await confirm({
        title: one ? 'Apagar card?' : `Apagar ${list.length} cards?`,
        message: one
          ? `"${list[0].titulo}" sai do planejamento (o arquivo do card é apagado).`
          : 'Os cards selecionados saem do planejamento (os arquivos são apagados).',
        confirmLabel: 'Apagar',
        danger: true
      })
      if (!ok) return
      for (const card of list) {
        if (await deleteCard(card.id, card.rev)) setEditing((e) => (e?.card.id === card.id ? null : e))
      }
    },
    [confirm, deleteCard]
  )

  const link = useCallback(
    (source: string, target: string): void => {
      const card = cards?.find((c) => c.id === source)
      if (!card || card.links.includes(target)) return
      void saveCard({ ...card, links: [...card.links, target] }, card.rev)
    },
    [cards, saveCard]
  )

  const unlink = useCallback(
    (pairs: { source: string; target: string }[]): void => {
      const bySource = new Map<string, Set<string>>()
      for (const p of pairs) bySource.set(p.source, (bySource.get(p.source) ?? new Set()).add(p.target))
      for (const [source, targets] of bySource) {
        const card = cards?.find((c) => c.id === source)
        if (card) void saveCard({ ...card, links: card.links.filter((id) => !targets.has(id)) }, card.rev)
      }
    },
    [cards, saveCard]
  )

  const focusEtapa = useCallback(
    (id: string): void => {
      const point = layout && columnFocusPoint(layout, id)
      if (point) void flow.setCenter(point.x, point.y, { zoom: Math.max(flow.getZoom(), FIT_MIN_ZOOM), duration: 400 })
    },
    [layout, flow]
  )

  const onToggleEtapa = useCallback((id: string) => void toggleEtapa(id), [toggleEtapa])

  const etapas = roteiro?.etapas ?? []
  const done = etapas.filter((e) => e.status === 'concluida').length
  const title = roteiro?.titulo || slug
  const isEmpty = !!plan && plan.roteiro.etapas.length === 0 && plan.cards.length === 0

  return (
    <div className="planning">
      <header className="pl-head">
        <div className="pl-head-main">
          <span className="pl-eyebrow">Planejamento</span>
          <h1 className="pl-title" title={title}>
            {title}
          </h1>
        </div>
        {etapas.length > 0 && (
          <span className="pl-head-progress">
            {done} de {etapas.length} etapa{etapas.length === 1 ? '' : 's'}
          </span>
        )}
        <span className="pl-head-spacer" />
        {headerActions && (
          <div className="pl-head-actions">
            <PlanningPlanContext.Provider value={plan}>{headerActions}</PlanningPlanContext.Provider>
          </div>
        )}
      </header>

      {plan && plan.invalid.length > 0 && <InvalidCards invalid={plan.invalid} />}

      <div className="pl-body" ref={bodyRef}>
        {status === 'loading' && (
          <div className="pl-state" role="status">
            <IconSpinner className="spinner" size={16} />
            Carregando o planejamento…
          </div>
        )}
        {status === 'error' && (
          <div className="pl-state error" role="alert">
            <strong>Não consegui abrir este planejamento.</strong>
            <span className="pl-state-detail">{error}</span>
            <button type="button" className="btn small" onClick={() => void reload()}>
              Tentar de novo
            </button>
          </div>
        )}
        {status === 'ready' && plan && layout && (
          <>
            <ProgressList
              etapas={etapas}
              onToggle={onToggleEtapa}
              onFocus={focusEtapa}
              collapsed={roteiroCollapsed}
              onToggleCollapsed={toggleRoteiro}
            />
            <main className="pl-stage-area">
              {isEmpty ? (
                <EmptyPlan onNewCard={() => newCard()} />
              ) : (
                <PlanningCanvas
                  plan={plan}
                  layout={layout}
                  onMoveCards={saveLayout}
                  onOpenCard={openCard}
                  onNewCard={newCard}
                  onDeleteCards={deleteCards}
                  onLink={link}
                  onUnlink={unlink}
                  onViewportChange={saveViewport}
                />
              )}
              {editing && (
                <CardEditor
                  // Remonta quando o card muda de versão (conflito): o formulário recomeça do disco.
                  key={`${editing.card.id || 'novo'}:${editing.card.rev}`}
                  card={editing.card}
                  isNew={editing.isNew}
                  etapas={etapas}
                  existingIds={plan.cards.map((c) => c.id)}
                  onSave={handleSave}
                  onDelete={(card) => void deleteCards([card])}
                  onCancel={() => setEditing(null)}
                />
              )}
            </main>
          </>
        )}
        {chatSlot && (
          <>
            <ChatSplitter
              width={chatWidth}
              getContainerWidth={bodyWidth}
              onResize={setChatWidth}
              onCommit={commitChatWidth}
            />
            <aside className="pl-chat nokey" style={{ '--pl-chat-w': `${chatWidth}px` } as CSSProperties}>
              {chatSlot}
            </aside>
          </>
        )}
      </div>
    </div>
  )
}

export function PlanningScreen(props: PlanningScreenProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <PlanningScreenBody {...props} />
    </ReactFlowProvider>
  )
}
