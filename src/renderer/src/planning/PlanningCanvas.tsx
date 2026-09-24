/**
 * Canvas do planejamento (React Flow): cabeçalhos de etapa lado a lado, cards
 * empilhados embaixo, ligações entre cards e setas de sequência entre etapas.
 *
 * Os dados vêm de cima (plano + layout calculado) e toda mudança sobe por
 * callback — o canvas não grava nada sozinho. Por isso apagar passa por
 * onBeforeDelete e SEMPRE devolve false: quem tira o card da tela é o plano
 * atualizado depois que o disco confirmou, não o React Flow.
 *
 * Enquadramento: viewport salvo volta como estava; sem ele, o do
 * canvasViewport.ts (nunca abaixo do zoom em que o card é legível). Só o
 * movimento do usuário sobe por onViewportChange, não o enquadramento inicial.
 *
 * Arquivo solto ou imagem colada (useCanvasFileDrop) também só sobe: quem
 * importa e grava é o usePlanMedia.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  useStore,
  useStoreApi,
  type Connection,
  type Edge,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
  type NodeMouseHandler,
  type NodeTypes,
  type OnBeforeDelete,
  type OnMove,
  type OnNodeDrag
} from '@xyflow/react'
import type { OpenedPlanningDto, PlanningCardDto } from '@shared/ipc'
import { CardNode, type CardFlowNode } from './CardNode'
import { StageNode, type StageFlowNode } from './StageNode'
import { NO_STAGE_ID, headerNodeId, isHeaderNodeId, type PlanLayout, type Point } from './layout'
import {
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  initialViewport,
  restoreViewport,
  sameViewport,
  type Viewport
} from './canvasViewport'
import { MINIMAP_H, MINIMAP_W } from './paneSizes'
import { useCanvasFileDrop } from './useCanvasFileDrop'
import type { DropTarget, DroppedFile } from './mediaDrop'

type FlowNode = CardFlowNode | StageFlowNode

export interface PlanningCanvasProps {
  plan: OpenedPlanningDto
  layout: PlanLayout
  /** Fim de um arrasto: posições (de um ou vários cards) para gravar. */
  onMoveCards: (positions: Record<string, Point>) => void
  onOpenCard: (card: PlanningCardDto) => void
  /** Botão '+ Card' (sem etapa) ou duplo clique num cabeçalho (com a etapa). */
  onNewCard: (etapaId?: string) => void
  /** Delete/Backspace com card selecionado — quem confirma é quem recebe. */
  onDeleteCards: (cards: PlanningCardDto[]) => Promise<void> | void
  onLink: (sourceId: string, targetId: string) => void
  onUnlink: (pairs: { source: string; target: string }[]) => void
  /** Pan/zoom que o usuário fez (fim do movimento), para gravar. */
  onViewportChange?: (viewport: Viewport) => void
  /** Qualquer clique no canvas — inclusive em cards e nós — para encolher o chat flutuante. */
  onCanvasClick?: () => void
  /** Botão "PDF" da barra: salva o flow inteiro em PDF. Sem ele, o botão não aparece. */
  onExportPdf?: () => void
  /** Exportação em andamento: o botão fica desabilitado. */
  exporting?: boolean
  /** Arquivo solto (ou imagem colada com Ctrl+V) no canvas. Sem ele, o canvas não aceita. */
  onDropFiles?: (files: DroppedFile[], target: DropTarget) => void
}

// Fora do componente: objeto novo a cada render faria o React Flow remontar os nós.
const nodeTypes: NodeTypes = { card: CardNode, stage: StageNode }
const DELETE_KEYS = ['Delete', 'Backspace']
// Só o botão "enquadrar" dos Controls: pedido explícito de ver o plano todo.
const FIT_VIEW = { padding: 0.15, maxZoom: 1 }
const PRO_OPTIONS = { hideAttribution: false }
const MINIMAP_STYLE = { width: MINIMAP_W, height: MINIMAP_H }
// Hex, não var(): a cor entra no id do marcador, que vira url(#…).
const SEQ_COLOR = '#8d8a86'
const LINK_COLOR = '#a3a09b'

function buildNodes(plan: OpenedPlanningDto, layout: PlanLayout): FlowNode[] {
  const nodes: FlowNode[] = layout.columns.map((col) => ({
    id: headerNodeId(col.id),
    type: 'stage' as const,
    position: { x: col.x, y: 0 },
    data: { titulo: col.titulo, status: col.status, ordem: col.index + 1, count: col.cardIds.length },
    draggable: false,
    selectable: false,
    deletable: false,
    connectable: false,
    focusable: false
  }))
  for (const card of plan.cards) {
    const position = layout.positions[card.id]
    if (position) nodes.push({ id: card.id, type: 'card' as const, position, data: { card } })
  }
  return nodes
}

function buildEdges(layout: PlanLayout): Edge[] {
  return layout.edges.map((e) =>
    e.kind === 'sequence'
      ? {
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'straight',
          className: 'pl-edge-seq',
          selectable: false,
          deletable: false,
          focusable: false,
          markerEnd: { type: MarkerType.ArrowClosed, color: SEQ_COLOR, width: 16, height: 16 }
        }
      : e.kind === 'ref'
        ? {
            // Vem do [[texto]] no corpo: some quando o texto sai, não pelo Delete.
            id: e.id,
            source: e.source,
            target: e.target,
            className: 'pl-edge-ref',
            selectable: false,
            deletable: false,
            focusable: false,
            markerEnd: { type: MarkerType.ArrowClosed, color: LINK_COLOR, width: 16, height: 16 }
          }
        : {
            id: e.id,
            source: e.source,
            target: e.target,
            className: 'pl-edge-link',
            markerEnd: { type: MarkerType.ArrowClosed, color: LINK_COLOR, width: 16, height: 16 }
          }
  )
}

/** Troca o array sem perder seleção, medida nem o nó que está sendo arrastado. */
function mergeNodes(prev: FlowNode[], next: FlowNode[]): FlowNode[] {
  const byId = new Map(prev.map((n) => [n.id, n]))
  return next.map((n) => {
    const old = byId.get(n.id)
    if (!old || old.type !== n.type) return n
    return { ...n, selected: old.selected, measured: old.measured, position: old.dragging ? old.position : n.position } as FlowNode
  })
}

function mergeEdges(prev: Edge[], next: Edge[]): Edge[] {
  const selected = new Set(prev.filter((e) => e.selected).map((e) => e.id))
  return next.map((e) => (selected.has(e.id) ? { ...e, selected: true } : e))
}

function miniMapColor(node: FlowNode): string {
  return node.type === 'card' ? `var(--pl-${node.data.card.tipo})` : 'var(--bg-3)'
}

/**
 * Enquadra UMA vez por montagem (= por plano aberto). O viewport salvo entra
 * como defaultViewport (sem piscar); sem ele, espera o canvas ter tamanho e
 * calcula. O onMoveEnd devolvido ignora o eco desse enquadramento programático.
 */
function useInitialViewport(
  plan: OpenedPlanningDto,
  layout: PlanLayout,
  onViewportChange: ((viewport: Viewport) => void) | undefined
): { defaultViewport: Viewport | undefined; onMoveEnd: OnMove } {
  const flow = useReactFlow()
  const store = useStoreApi()
  const hasSize = useStore((s) => s.width > 0 && s.height > 0)
  // Lido só na montagem: recarregar o plano não reenquadra o canvas.
  const [restored] = useState(() => restoreViewport(plan.layout.viewport))
  const applied = useRef<Viewport | null>(restored)
  const done = useRef(!!restored)
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  useEffect(() => {
    if (done.current || !hasSize) return
    done.current = true
    const { width, height } = store.getState()
    const vp = initialViewport(layoutRef.current, { width, height })
    applied.current = vp
    void flow.setViewport(vp)
  }, [hasSize, store, flow])

  const onMoveEnd: OnMove = useCallback(
    (_event, vp) => {
      if (sameViewport(vp, applied.current)) return
      applied.current = null
      onViewportChange?.(vp)
    },
    [onViewportChange]
  )

  return { defaultViewport: restored ?? undefined, onMoveEnd }
}

export const PlanningCanvas = memo(function PlanningCanvas({
  plan,
  layout,
  onMoveCards,
  onOpenCard,
  onNewCard,
  onDeleteCards,
  onLink,
  onUnlink,
  onViewportChange,
  onCanvasClick,
  onExportPdf,
  exporting,
  onDropFiles
}: PlanningCanvasProps): JSX.Element {
  const { defaultViewport, onMoveEnd } = useInitialViewport(plan, layout, onViewportChange)
  const fileDrop = useCanvasFileDrop(layout, onDropFiles)
  const [nodes, setNodes] = useState<FlowNode[]>(() => buildNodes(plan, layout))
  const [edges, setEdges] = useState<Edge[]>(() => buildEdges(layout))
  const cardsById = useMemo(() => new Map(plan.cards.map((c) => [c.id, c])), [plan.cards])

  useEffect(() => setNodes((prev) => mergeNodes(prev, buildNodes(plan, layout))), [plan, layout])
  useEffect(() => setEdges((prev) => mergeEdges(prev, buildEdges(layout))), [layout])

  // 'remove' nunca é aplicado aqui: a remoção real passa pelo disco (ver topo).
  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type !== 'remove'), ns)),
    []
  )
  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => setEdges((es) => applyEdgeChanges(changes.filter((c) => c.type !== 'remove'), es)),
    []
  )

  const onNodeDragStop: OnNodeDrag<FlowNode> = useCallback(
    (_event, _node, dragged) => {
      const positions: Record<string, Point> = {}
      for (const n of dragged) if (n.type === 'card') positions[n.id] = { x: n.position.x, y: n.position.y }
      if (Object.keys(positions).length) onMoveCards(positions)
    },
    [onMoveCards]
  )

  const onNodeDoubleClick: NodeMouseHandler<FlowNode> = useCallback(
    (_event, node) => {
      if (node.type === 'card') {
        const card = cardsById.get(node.id)
        if (card) onOpenCard(card)
      } else if (isHeaderNodeId(node.id)) {
        const columnId = node.id.slice('stage:'.length)
        onNewCard(columnId === NO_STAGE_ID ? undefined : columnId)
      }
    },
    [cardsById, onOpenCard, onNewCard]
  )

  const onBeforeDelete: OnBeforeDelete<FlowNode, Edge> = useCallback(
    async ({ nodes: gone, edges: goneEdges }) => {
      const cards = gone
        .filter((n) => n.type === 'card')
        .map((n) => cardsById.get(n.id))
        .filter((c): c is PlanningCardDto => !!c)
      if (cards.length) {
        await onDeleteCards(cards)
        return false
      }
      const links = goneEdges.filter((e) => e.id.startsWith('link:')).map((e) => ({ source: e.source, target: e.target }))
      if (links.length) onUnlink(links)
      return false
    },
    [cardsById, onDeleteCards, onUnlink]
  )

  const isValidConnection: IsValidConnection<Edge> = useCallback(
    (c) => !!c.source && !!c.target && c.source !== c.target && !isHeaderNodeId(c.source) && !isHeaderNodeId(c.target),
    []
  )

  const onConnect = useCallback(
    (c: Connection) => {
      if (isValidConnection(c)) onLink(c.source, c.target)
    },
    [isValidConnection, onLink]
  )

  return (
    <div
      ref={fileDrop.ref}
      className={`pl-canvas${fileDrop.dragging ? ' pl-dropping' : ''}`}
      onClick={onCanvasClick}
      {...fileDrop.handlers}
    >
      <ReactFlow<FlowNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeDoubleClick={onNodeDoubleClick}
        onBeforeDelete={onBeforeDelete}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        deleteKeyCode={DELETE_KEYS}
        zoomOnDoubleClick={false}
        defaultViewport={defaultViewport}
        onMoveEnd={onMoveEnd}
        minZoom={CANVAS_MIN_ZOOM}
        maxZoom={CANVAS_MAX_ZOOM}
        colorMode="dark"
        proOptions={PRO_OPTIONS}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
        <Controls showInteractive={false} position="bottom-left" fitViewOptions={FIT_VIEW} />
        {/* Em cima à direita: embaixo fica o chat do Manager minimizado (ManagerChatFloat). */}
        <MiniMap<FlowNode>
          position="top-right"
          style={MINIMAP_STYLE}
          pannable
          zoomable
          nodeColor={miniMapColor}
          nodeStrokeWidth={0}
          nodeBorderRadius={6}
          ariaLabel="Minimapa do planejamento"
        />
        <Panel position="top-left" className="pl-toolbar">
          <button type="button" className="pl-add" onClick={() => onNewCard()} title="Criar um card">
            + Card
          </button>
          {onExportPdf && (
            <button
              type="button"
              className="pl-add"
              onClick={onExportPdf}
              disabled={exporting}
              title="Salvar o flow inteiro (todos os cards e ligações) em PDF"
            >
              {exporting ? 'Exportando…' : 'Exportar PDF'}
            </button>
          )}
          <span className="pl-hint">
            Duplo clique abre · Delete apaga · arraste do ponto na borda de um card até outro para ligar
            {onDropFiles ? ' · solte arquivos ou cole imagem para anexar' : ''}
          </span>
        </Panel>
      </ReactFlow>
    </div>
  )
})
