/**
 * O chat do Agent Manager flutuando sobre o canvas, centralizado na área dele.
 * Dois estados, lembrados entre sessões (padrão: maximizado):
 *
 * - **Maximizado**: a borda de cima fica a 20% da altura da JANELA — contada da
 *   janela, não da área, por isso o `top` é medido — e a de baixo a 12px do
 *   fim. Mostra tudo o que o chat mostra.
 * - **Minimizado**: ancorado embaixo, com ~5 linhas de conversa e 3 de
 *   digitação (planningChat.css). O `ChatPanel` entra em modo compacto pelo
 *   `ChatDisplayContext`: some o consumo. Fica mais translúcido que o
 *   maximizado (volta à translucidez dele no hover/foco) e qualquer clique
 *   nele expande.
 *
 * O aviso "Controle do Windows ativo" não aparece em nenhum dos dois estados.
 *
 * Além da seta, dois gestos alternam o estado: clicar no painel minimizado
 * expande (`expandFromClick`); clicar em qualquer lugar fora dele encolhe e
 * tira o foco dele (fica translúcido). `collapseSignal` — que o PlanningScreen
 * sobe a cada clique no `PlanningCanvas` — faz o mesmo.
 *
 * O chat (`children`) é o mesmo elemento nos dois estados — só muda o valor
 * do contexto e a classe —, então alternar não remonta a conversa nem perde a
 * rolagem, o rascunho ou o foco.
 *
 * `cards` (os do canvas) vão no mesmo contexto como `cardRefs`: '[[' no
 * Composer sugere os cards e [[Nome]] nas mensagens ganha a cor do tipo.
 */
import './planningChat.css'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ChatDisplayContext, type ChatDisplay } from '../components/chatDisplay'
import { IconChevronDown } from '../components/Icons'
import type { RefCard } from './cardRefs'
import { FLOW_PANEL_MARGIN, MINIMAP_H, MINIMAP_W, loadChatMinimized, saveChatMinimized } from './paneSizes'

/** Borda de cima do painel maximizado, em fração da altura da janela. */
export const FLOAT_TOP_RATIO = 0.2
/** Menor distância entre o painel e o topo da área do canvas. */
export const FLOAT_EDGE_GAP = 8
/** Folga entre o painel e o minimapa. */
const MINIMAP_GAP = 8

export interface FloatGeometry {
  /** window.innerHeight. */
  viewportHeight: number
  /** Topo e borda direita da área do canvas, na janela. */
  areaTop: number
  areaRight: number
  /** Borda direita do painel, na janela (a largura vem do CSS). */
  panelRight: number
}

/**
 * `top` do painel maximizado, relativo à área do canvas: 20% da altura da
 * janela menos o que fica acima da área. Se o painel cruza a coluna do
 * minimapa (canto superior direito — canvas estreito), desce para baixo dele:
 * o minimapa tem de continuar clicável.
 */
export function maximizedTop({ viewportHeight, areaTop, areaRight, panelRight }: FloatGeometry): number {
  let top = Math.round(viewportHeight * FLOAT_TOP_RATIO - areaTop)
  const minimapLeft = areaRight - FLOW_PANEL_MARGIN - MINIMAP_W - MINIMAP_GAP
  if (panelRight > minimapLeft) top = Math.max(top, FLOW_PANEL_MARGIN + MINIMAP_H + MINIMAP_GAP)
  return Math.max(FLOAT_EDGE_GAP, top)
}

/** Mede e devolve o `top` do painel maximizado; null antes da medição ou minimizado. */
function useMaximizedTop(ref: RefObject<HTMLElement | null>, active: boolean): number | null {
  const [top, setTop] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const area = el?.parentElement
    if (!active || !el || !area) return
    const measure = (): void => {
      const a = area.getBoundingClientRect()
      const next = maximizedTop({
        viewportHeight: window.innerHeight,
        areaTop: a.top || 0,
        areaRight: a.right || 0,
        panelRight: el.getBoundingClientRect().right || 0
      })
      if (Number.isFinite(next)) setTop((t) => (t === next ? t : next))
    }
    measure()
    // A área muda com a janela, o roteiro e o aviso de cards inválidos acima dela.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(area)
    window.addEventListener('resize', measure)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [ref, active])
  return active ? top : null
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
  /** Pasta do plano (docs/spec/<slug>, absoluta): arquivos criados nela viram link no chat. */
  planDir?: string
}

export function ManagerChatFloat({ children, cards, collapseSignal, planDir }: ManagerChatFloatProps): JSX.Element {
  const [minimized, setMinimized] = useState(loadChatMinimized)
  const ref = useRef<HTMLElement>(null)
  const top = useMaximizedTop(ref, !minimized)
  const cardRefs = useRefCards(cards)
  const display = useMemo<ChatDisplay>(() => {
    const base: ChatDisplay = { compact: minimized, hideWindowsBanner: true }
    if (cardRefs) base.cardRefs = cardRefs
    if (planDir) base.planDir = planDir
    return base
  }, [minimized, cardRefs, planDir])

  const toggle = useCallback((e?: { stopPropagation: () => void }) => {
    e?.stopPropagation()
    setMinimized((v) => {
      saveChatMinimized(!v)
      return !v
    })
  }, [])

  // Clicar no canvas atrás do chat maximizado o encolhe — sem isso o painel some
  // do jeito do usuário só pela seta. Ignora o primeiro valor (montagem): só
  // reage a pedidos de fato, feitos DEPOIS que o chat já está na tela.
  const seenSignal = useRef(collapseSignal)
  useEffect(() => {
    if (collapseSignal === undefined || collapseSignal === seenSignal.current) return
    seenSignal.current = collapseSignal
    setMinimized((v) => {
      if (v) return v
      saveChatMinimized(true)
      return true
    })
  }, [collapseSignal])

  // Clicar em QUALQUER lugar fora do chat o minimiza e tira o foco dele — é o
  // foco (`:focus-within`) que o mantinha opaco depois do clique no canvas, já
  // que o React Flow não deixa o clique no fundo tirar o foco da caixa de texto.
  // Captura: o canvas para a propagação do mousedown. Diálogos (permissão,
  // pergunta do agente) ficam de fora: responder a eles não é sair do chat.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      const panel = ref.current
      const target = e.target
      if (!panel || !(target instanceof Node) || panel.contains(target)) return
      if (target instanceof Element && target.closest('[role="dialog"], [aria-modal="true"]')) return
      const focused = document.activeElement
      if (focused instanceof HTMLElement && panel.contains(focused)) focused.blur()
      setMinimized((v) => {
        if (v) return v
        saveChatMinimized(true)
        return true
      })
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [])

  // Clicar no painel minimizado o expande — é o gesto mais direto para voltar
  // a conversar. O próprio botão (que também alterna) chama stopPropagation,
  // então isto só dispara quando o clique não veio dele.
  const expandFromClick = useCallback(() => {
    setMinimized((v) => {
      if (!v) return v
      saveChatMinimized(false)
      return false
    })
  }, [])

  const label = minimized ? 'Maximizar o chat do Agent Manager' : 'Minimizar o chat do Agent Manager'
  return (
    // pl-chat: o gancho estável de "o chat da tela" (o App.test procura o ChatPanel nele).
    // nokey: Delete/Backspace digitados no chat não apagam o card selecionado no canvas.
    <section
      ref={ref}
      className={`pl-chat pl-chat-float nokey${minimized ? ' minimized' : ''}`}
      aria-label="Agent Manager"
      style={top === null ? undefined : { top }}
      onClick={minimized ? expandFromClick : undefined}
    >
      <header className="pl-chat-float-head">
        <span className="pl-chat-float-title">Agent Manager</span>
        <button
          type="button"
          className="pl-chat-float-toggle"
          onClick={toggle}
          aria-label={label}
          title={
            minimized
              ? 'Maximizar o chat — a conversa inteira, com o consumo e os avisos'
              : 'Minimizar o chat — fica embaixo, com as últimas linhas e a caixa de texto'
          }
        >
          <IconChevronDown size={15} />
        </button>
      </header>
      <div className="pl-chat-float-body">
        <ChatDisplayContext.Provider value={display}>{children}</ChatDisplayContext.Provider>
      </div>
    </section>
  )
}
