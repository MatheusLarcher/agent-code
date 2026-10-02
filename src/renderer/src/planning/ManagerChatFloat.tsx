/**
 * O chat do Agent Manager flutuando sobre o canvas, centralizado na área dele.
 * Estados, gestos e o modo compacto são do ChatFloat (components/ChatFloat.tsx,
 * o mesmo painel do chat do Escritório 3D); aqui fica o que é só do Planejamento:
 *
 * - o minimizado lembrado em `agentcode.planning.chatMinimized` (paneSizes);
 * - o maximizado a 20% da altura da JANELA, mas abaixo do minimapa quando o
 *   canvas é estreito (`maximizedTop`);
 * - o aviso "Controle do Windows ativo" e o quadro "Última resposta" não
 *   aparecem em nenhum dos dois estados;
 * - `collapseSignal`, que o PlanningScreen sobe a cada clique no
 *   `PlanningCanvas`, minimiza.
 *
 * `cards` (os do canvas) vão no mesmo contexto como `cardRefs`: '[[' no
 * Composer sugere os cards e [[Nome]] nas mensagens ganha a cor do tipo.
 */
import { useMemo, useRef, type ReactNode } from 'react'
import { ChatFloat, floatTop, type ChatFloatDisplay, type ChatFloatPersist, type FloatGeometry } from '../components/ChatFloat'
import type { RefCard } from './cardRefs'
import { FLOW_PANEL_MARGIN, MINIMAP_H, MINIMAP_W, loadChatMinimized, saveChatMinimized } from './paneSizes'

export { FLOAT_EDGE_GAP, FLOAT_TOP_RATIO, type FloatGeometry } from '../components/ChatFloat'

/** Folga entre o painel e o minimapa. */
const MINIMAP_GAP = 8

const PERSIST: ChatFloatPersist = { load: loadChatMinimized, save: saveChatMinimized }

/**
 * `top` do painel maximizado, relativo à área do canvas: o padrão do ChatFloat
 * (20% da altura da janela menos o que fica acima da área — floatTop). Se o
 * painel cruza a coluna do minimapa (canto superior direito — canvas
 * estreito), desce para baixo dele: o minimapa tem de continuar clicável.
 */
export function maximizedTop(g: FloatGeometry): number {
  const top = floatTop(g)
  const minimapLeft = g.areaRight - FLOW_PANEL_MARGIN - MINIMAP_W - MINIMAP_GAP
  return g.panelRight > minimapLeft ? Math.max(top, FLOW_PANEL_MARGIN + MINIMAP_H + MINIMAP_GAP) : top
}

/**
 * Só id/título/tipo, e a MESMA lista enquanto eles não mudam: recarregar o
 * plano por causa de posição, corpo ou rev não re-renderiza o chat inteiro.
 * Sem cards: undefined (o chat fica sem '[[').
 */
function useRefCards(cards: readonly RefCard[] | undefined): readonly RefCard[] | undefined {
  const key = cards?.map((c) => `${c.id}\u0000${c.tipo}\u0000${c.titulo}`).join('\u0001') ?? ''
  const latest = useRef(cards)
  latest.current = cards
  return useMemo(
    () => (key ? latest.current?.map(({ id, titulo, tipo }) => ({ id, titulo, tipo })) : undefined),
    [key]
  )
}

export interface ManagerChatFloatProps {
  children: ReactNode
  /** Cards do plano aberto (os do canvas), para citar com [[Nome]] no chat. */
  cards?: readonly RefCard[]
  /** Sobe a cada clique no canvas (o "flow"): minimiza o chat, se estiver maximizado.
   *  Sentinela de "ainda não pediram" é o valor inicial — não minimiza sozinho na montagem. */
  collapseSignal?: number
  /** Pastas do plano (absolutas, vindas do main: a do plano e o _sandbox):
   *  arquivos criados nelas viram link no chat. */
  planDir?: string | readonly string[]
}

export function ManagerChatFloat({ children, cards, collapseSignal, planDir }: ManagerChatFloatProps): JSX.Element {
  const cardRefs = useRefCards(cards)
  const display = useMemo<ChatFloatDisplay>(() => {
    const extra: ChatFloatDisplay = { hideWindowsBanner: true, hideLastUsage: true }
    if (cardRefs) extra.cardRefs = cardRefs
    if (planDir) extra.planDir = planDir
    return extra
  }, [cardRefs, planDir])
  return (
    <ChatFloat name="Agent Manager" persist={PERSIST} display={display} collapseSignal={collapseSignal} maximizedTop={maximizedTop}>
      {children}
    </ChatFloat>
  )
}
