/**
 * Tela de Planejamento: cabeçalho com o título do plano (e o espaço
 * `headerActions`, onde a integração põe o botão de enviar), o roteiro como
 * checklist à esquerda (largura arrastável, recolhível num trilho), o canvas
 * ocupando o resto e o chat (`chatSlot`) flutuando sobre ele
 * (ManagerChatFloat: maximizado ou minimizado), que recebe os cards do plano
 * para o '[[' do Composer e o destaque de [[Nome]] nas mensagens.
 *
 * Componente isolado: recebe só projectCwd + slug e conversa com o main pelo
 * usePlanning. Largura do roteiro, roteiro recolhido e chat minimizado valem
 * entre sessões.
 */
import '@xyflow/react/dist/style.css'
import './planning.css'
import './planningLayout.css'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import type { OpenedPlanningDto, PlanningCardDto } from '@shared/ipc'
import { IconSpinner, IconWarning } from '../components/Icons'
import { useUI } from '../ui/UiProvider'
import { CardBirthFlow } from './CardBirthFlow'
import { CardEditor } from './CardEditor'
import { ManagerChatFloat } from './ManagerChatFloat'
import { PlanningCanvas } from './PlanningCanvas'
import { ProgressList } from './ProgressList'
import { RoteiroSplitter } from './RoteiroSplitter'
import { FIT_MIN_ZOOM } from './canvasViewport'
import { buildFlowPdf } from './flowPdf'
import { columnFocusPoint, computeLayout } from './layout'
import { loadRoteiroCollapsed, loadRoteiroWidth, saveRoteiroCollapsed, saveRoteiroWidth } from './paneSizes'
import { PlanningPlanContext } from './planningPlanContext'
import { usePlanning } from './usePlanning'

export interface PlanningScreenProps {
  /** Pasta do projeto (absoluta). */
  projectCwd: string
  /** Plano em docs/spec/<slug>/. */
  slug: string
  /** Painel de conversa com o agente, flutuando sobre o canvas. */
  chatSlot?: ReactNode
  /** Ações no canto direito do cabeçalho (ex.: enviar para implementação).
   *  Leem o plano aberto por useOpenedPlan (planningPlanContext). */
  headerActions?: ReactNode
}

interface Editing {
  card: PlanningCardDto
  isNew: boolean
  /** Cada abertura do editor é uma sessão nova (o `key` dele): gravar não remonta. */
  session: number
  /** O plano em que o card foi aberto: trocar de plano desmonta o editor (e ele grava no plano dele). */
  planKey: string
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
          Converse com o Agent Manager para separar o trabalho em etapas — cada etapa vira uma coluna aqui, com os
          requisitos, decisões e dúvidas embaixo.
        </p>
        <button type="button" className="pl-add" onClick={onNewCard}>
          + Card
        </button>
      </div>
    </div>
  )
}

/** Largura do roteiro (arrastável, lembrada) e roteiro recolhido (lembrado).
 *  Recolher não esquece a largura: expandir volta a ela. */
function usePanes(): {
  roteiroWidth: number
  setRoteiroWidth: (w: number) => void
  commitRoteiroWidth: (w: number) => void
  roteiroCollapsed: boolean
  toggleRoteiro: () => void
} {
  const [roteiroWidth, setRoteiroWidth] = useState(loadRoteiroWidth)
  const [roteiroCollapsed, setRoteiroCollapsed] = useState(loadRoteiroCollapsed)
  const commitRoteiroWidth = useCallback((w: number) => {
    setRoteiroWidth(w)
    saveRoteiroWidth(w)
  }, [])
  const toggleRoteiro = useCallback(() => {
    setRoteiroCollapsed((v) => {
      saveRoteiroCollapsed(!v)
      return !v
    })
  }, [])
  return { roteiroWidth, setRoteiroWidth, commitRoteiroWidth, roteiroCollapsed, toggleRoteiro }
}

function PlanningScreenBody({ projectCwd, slug, chatSlot, headerActions }: PlanningScreenProps): JSX.Element {
  const { status, plan, error, born, reload, saveCard, deleteCard, saveLayout, saveViewport, toggleEtapa } =
    usePlanning(projectCwd, slug)
  const { confirm, notify } = useUI()
  const flow = useReactFlow()
  const [editing, setEditing] = useState<Editing | null>(null)
  const editorSession = useRef(0)
  const planKey = `${projectCwd}\u0000${slug}`
  const { roteiroWidth, setRoteiroWidth, commitRoteiroWidth, roteiroCollapsed, toggleRoteiro } = usePanes()
  const bodyRef = useRef<HTMLDivElement>(null)
  const bodyWidth = useCallback(() => bodyRef.current?.getBoundingClientRect().width ?? 0, [])
  // Clicar no canvas encolhe o chat flutuante do Manager, se estiver maximizado.
  const [chatCollapseSignal, setChatCollapseSignal] = useState(0)
  const collapseChat = useCallback(() => setChatCollapseSignal((n) => n + 1), [])

  // Trocar de plano fecha o editor: o card aberto era do plano anterior.
  useEffect(() => setEditing(null), [projectCwd, slug])

  const roteiro = plan?.roteiro
  const cards = plan?.cards
  const positions = plan?.layout.positions
  const layout = useMemo(
    () => (roteiro && cards ? computeLayout(roteiro, cards, positions) : null),
    [roteiro, cards, positions]
  )

  // Abrir outro card troca a sessão: o editor anterior desmonta e grava o que mudou.
  const openCard = useCallback(
    (card: PlanningCardDto) => setEditing({ card, isNew: false, session: ++editorSession.current, planKey }),
    [planKey]
  )
  const newCard = useCallback(
    (etapa?: string) => setEditing({ card: blankCard(etapa), isNew: true, session: ++editorSession.current, planKey }),
    [planKey]
  )

  // O editor grava sozinho; no conflito ele mescla e avisa (daí o quietConflict).
  const saveFromEditor = useCallback(
    (card: PlanningCardDto, expectedRev: number) => saveCard(card, expectedRev, { quietConflict: true }),
    [saveCard]
  )
  // Card novo gravado passa a ser um card como os outros (o Apagar e a versão viva
  // valem). Só a sessão que gravou: a gravação de um editor que já fechou não mexe no aberto.
  const onEditorSaved = useCallback(
    (session: number, card: PlanningCardDto) =>
      setEditing((e) => (e && e.session === session ? { ...e, card, isNew: false } : e)),
    []
  )
  const closeEditor = useCallback(() => setEditing(null), [])

  const deleteCards = useCallback(
    async (list: PlanningCardDto[]): Promise<boolean> => {
      if (!list.length) return false
      const one = list.length === 1
      const ok = await confirm({
        title: one ? 'Apagar card?' : `Apagar ${list.length} cards?`,
        message: one
          ? `"${list[0].titulo}" sai do planejamento (o arquivo do card é apagado).`
          : 'Os cards selecionados saem do planejamento (os arquivos são apagados).',
        confirmLabel: 'Apagar',
        danger: true
      })
      if (!ok) return false
      let all = true
      for (const card of list) {
        if (await deleteCard(card.id, card.rev)) setEditing((e) => (e?.card.id === card.id ? null : e))
        else all = false
      }
      return all
    },
    [confirm, deleteCard]
  )
  const deleteFromCanvas = useCallback(
    async (list: PlanningCardDto[]): Promise<void> => {
      await deleteCards(list)
    },
    [deleteCards]
  )
  const deleteFromEditor = useCallback((card: PlanningCardDto) => deleteCards([card]), [deleteCards])

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

  // PDF do flow inteiro (todos os cards, não só o trecho na tela): o DOM do
  // canvas vira uma página autocontida e o main imprime (flowPdf.ts).
  const stageRef = useRef<HTMLElement>(null)
  const [exporting, setExporting] = useState(false)
  const exportPdf = useCallback(async (): Promise<void> => {
    const nodes = flow.getNodes()
    const stage = stageRef.current
    const req = stage && nodes.length ? buildFlowPdf(stage, flow.getNodesBounds(nodes), title) : null
    if (!req) {
      notify('aviso', 'Não há cards no canvas para exportar.')
      return
    }
    setExporting(true)
    try {
      const res = await window.api.planningExportPdf(req)
      if (res.ok) notify('sucesso', `PDF salvo em ${res.path}`)
      else if (!res.canceled) notify('erro', `Não consegui gerar o PDF: ${res.message ?? 'erro desconhecido'}`)
    } catch (err) {
      notify('erro', `Não consegui gerar o PDF: ${String(err)}`)
    } finally {
      setExporting(false)
    }
  }, [flow, title, notify])
  const isEmpty = !!plan && plan.roteiro.etapas.length === 0 && plan.cards.length === 0
  const existingIds = useMemo(() => (cards ?? []).map((c) => c.id), [cards])
  // O editor recebe a versão viva do card: sem edição pendente, adota a do Manager.
  const editorOpen = editing && editing.planKey === planKey ? editing : null
  const editorCard =
    editorOpen && !editorOpen.isNew ? (cards?.find((c) => c.id === editorOpen.card.id) ?? editorOpen.card) : editorOpen?.card

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

      <div className="pl-body" ref={bodyRef} style={{ '--pl-roteiro-w': `${roteiroWidth}px` } as CSSProperties}>
        {status === 'ready' && plan && layout && (
          <>
            <ProgressList
              etapas={etapas}
              onToggle={onToggleEtapa}
              onFocus={focusEtapa}
              collapsed={roteiroCollapsed}
              onToggleCollapsed={toggleRoteiro}
            />
            {!roteiroCollapsed && (
              <RoteiroSplitter
                width={roteiroWidth}
                getContainerWidth={bodyWidth}
                onResize={setRoteiroWidth}
                onCommit={commitRoteiroWidth}
              />
            )}
          </>
        )}
        {/* O canvas (ou o estado) ocupa o resto; o chat flutua sobre ele. */}
        <div className="pl-main">
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
            <main className="pl-stage-area" ref={stageRef}>
              {isEmpty ? (
                <EmptyPlan onNewCard={() => newCard()} />
              ) : (
                <PlanningCanvas
                  plan={plan}
                  layout={layout}
                  onMoveCards={saveLayout}
                  onOpenCard={openCard}
                  onNewCard={newCard}
                  onDeleteCards={deleteFromCanvas}
                  onLink={link}
                  onUnlink={unlink}
                  onViewportChange={saveViewport}
                  onCanvasClick={collapseChat}
                  onExportPdf={() => void exportPdf()}
                  exporting={exporting}
                />
              )}
              {editorOpen && editorCard && (
                <CardEditor
                  key={`${editorOpen.planKey}\u0000${editorOpen.session}`}
                  card={editorCard}
                  isNew={editorOpen.isNew}
                  etapas={etapas}
                  existingIds={existingIds}
                  cards={plan.cards}
                  projectCwd={projectCwd}
                  slug={slug}
                  onSave={saveFromEditor}
                  onSaved={(saved) => onEditorSaved(editorOpen.session, saved)}
                  onDelete={deleteFromEditor}
                  onClose={closeEditor}
                  notify={notify}
                />
              )}
            </main>
          )}
          {/* Os cards do canvas vão para o chat: '[[' sugere e [[Nome]] ganha a cor do tipo. */}
          {chatSlot && (
            <ManagerChatFloat cards={cards} collapseSignal={chatCollapseSignal} planDir={`${projectCwd}/docs/spec/${slug}`}>
              {chatSlot}
            </ManagerChatFloat>
          )}
          {/* Card criado pelo Manager: um fluxo na cor do tipo sai do chat e o gera no canvas. */}
          <CardBirthFlow birth={born} />
        </div>
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
