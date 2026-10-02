/**
 * Chat flutuante translúcido sobre uma área — o canvas da Tela de Planejamento
 * (ManagerChatFloat) e o palco do Escritório 3D (OfficeChatFloat). Dois
 * estados, lembrados entre sessões POR INSTÂNCIA (`persist`; padrão: maximizado):
 *
 * - **Maximizado**: a borda de cima vem de `maximizedTop`, medida na JANELA
 *   (padrão: 20% da altura dela, descontado o que fica acima da área), e a de
 *   baixo fica a 12px do fim. Mostra tudo o que o chat mostra.
 * - **Minimizado**: ancorado embaixo, com ~5 linhas de conversa. Sem texto
 *   digitado, a caixa é uma faixa de 1 linha sem os botões (`composer-small`);
 *   com texto, cresce de 1 a 3 linhas (rola depois) e os botões voltam. Anexo
 *   sozinho não é texto; chip de citação ("Comentar") é. O `ChatPanel` entra em
 *   modo compacto pelo `ChatDisplayContext`: some o consumo. Fica mais
 *   translúcido (volta à translucidez do maximizado no hover/foco).
 *
 * Gestos: a seta alterna; clicar no painel minimizado expande; clicar fora
 * dele encolhe e tira o foco (fica translúcido). O que é "fora" vem de
 * `collapseScope`: 'document' (padrão, o Planejamento) é a janela inteira;
 * 'area' (o Escritório) é só a área que hospeda o painel (o pai dele) — a
 * barra lateral e a barra de cima não mexem no chat. Em nenhum dos dois contam
 * os diálogos (permissão, pergunta do agente) nem as abas da área principal
 * (`.main-tabs`): trocar de aba não minimiza nem grava nada. `collapseSignal`
 * e `expandSignal`, contadores que quem hospeda sobe, pedem o mesmo de fora; o
 * valor da montagem não conta.
 *
 * O chat (`children`) é o mesmo elemento nos dois estados — só muda o valor
 * do contexto e a classe —, então alternar não remonta a conversa nem perde a
 * rolagem, o rascunho ou o foco.
 *
 * O CSS é o planningChat.css (classes pl-chat-float*, que os testes do
 * Planejamento fixam): os dois chats são o mesmo painel, só o tema muda.
 */
import '../planning/planningChat.css'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { ChatDisplayContext, type ChatDisplay } from './chatDisplay'
import { IconChevronDown } from './Icons'

/** Borda de cima do painel maximizado, em fração da altura da janela. */
export const FLOAT_TOP_RATIO = 0.2
/** Menor distância entre o painel e o topo da área. */
export const FLOAT_EDGE_GAP = 8

export interface FloatGeometry {
  /** window.innerHeight. */
  viewportHeight: number
  /** Topo e borda direita da área, na janela. */
  areaTop: number
  areaRight: number
  /** Borda direita do painel, na janela (a largura vem do CSS). */
  panelRight: number
}

/** `top` padrão do maximizado, relativo à área: 20% da janela menos o que fica acima dela; nunca cola no topo. */
export function floatTop({ viewportHeight, areaTop }: FloatGeometry): number {
  return Math.max(FLOAT_EDGE_GAP, Math.round(viewportHeight * FLOAT_TOP_RATIO - areaTop))
}

/** Onde o estado minimizado fica lembrado — uma chave por instância. */
export interface ChatFloatPersist {
  load: () => boolean
  save: (minimized: boolean) => void
}

/** O que mais vai para o ChatDisplayContext (o compacto e a caixa com texto são do ChatFloat). */
export type ChatFloatDisplay = Omit<ChatDisplay, 'compact' | 'onComposerHasText'>

/** Onde um clique conta como "fora" (minimiza): a janela inteira ou só a área que hospeda o painel. */
export type ChatFloatCollapseScope = 'document' | 'area'

/** Cliques aqui nunca são "fora": diálogos (o pedido do agente) e as abas da área principal. */
const NEVER_OUTSIDE = '[role="dialog"], [aria-modal="true"], .main-tabs'

export interface ChatFloatProps {
  children: ReactNode
  /** Nome do painel: rótulo da região e da seta ("Minimizar o chat do {name}"). */
  name: string
  /** Conteúdo do cabeçalho, à esquerda da seta; sem ele, o nome (em caixa alta). */
  header?: ReactNode
  persist: ChatFloatPersist
  /** Estável: trocar o objeto recria o contexto do chat. */
  display?: ChatFloatDisplay
  collapseSignal?: number
  expandSignal?: number
  /** Onde clicar minimiza: 'document' (padrão) ou só a área que hospeda o painel ('area'). */
  collapseScope?: ChatFloatCollapseScope
  /** `top` do maximizado a partir da geometria medida; função estável. */
  maximizedTop?: (g: FloatGeometry) => number
  /** Classe extra na região (o tema de quem hospeda). */
  className?: string
  /** Estilo extra na região (ex.: variáveis CSS do tema); o `top` medido vence. */
  style?: CSSProperties
}

/** Mede e devolve o `top` do painel maximizado; null antes da medição ou minimizado. */
function useMaximizedTop(ref: RefObject<HTMLElement | null>, active: boolean, topFor: (g: FloatGeometry) => number): number | null {
  const [top, setTop] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const area = el?.parentElement
    if (!active || !el || !area) return
    const measure = (): void => {
      const a = area.getBoundingClientRect()
      const next = topFor({
        viewportHeight: window.innerHeight,
        areaTop: a.top || 0,
        areaRight: a.right || 0,
        panelRight: el.getBoundingClientRect().right || 0
      })
      if (Number.isFinite(next)) setTop((t) => (t === next ? t : next))
    }
    measure()
    // A área muda com a janela e com o que estiver acima dela (roteiro, avisos).
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(area)
    window.addEventListener('resize', measure)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [ref, active, topFor])
  return active ? top : null
}

/** Reage a um contador que sobe (o valor da montagem não conta). */
function useSignal(signal: number | undefined, run: () => void): void {
  const seen = useRef(signal)
  useEffect(() => {
    if (signal === undefined || signal === seen.current) return
    seen.current = signal
    run()
    // `run` só mexe em setState: o efeito é do sinal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal])
}

export function ChatFloat({
  children,
  name,
  header,
  persist,
  display,
  collapseSignal,
  expandSignal,
  collapseScope = 'document',
  maximizedTop = floatTop,
  className,
  style
}: ChatFloatProps): JSX.Element {
  const store = useRef(persist)
  store.current = persist
  const [minimized, setMinimized] = useState(() => persist.load())
  // A caixa do Composer tem texto (ou chip de citação)? Vem do `onHasTextChange` dele, só nas
  // trocas vazio↔não vazio (não a cada tecla). O setter é estável: o contexto não muda por ele.
  const [composerHasText, setComposerHasText] = useState(false)
  const ref = useRef<HTMLElement>(null)
  const top = useMaximizedTop(ref, !minimized, maximizedTop)
  const ctx = useMemo<ChatDisplay>(
    () => ({ ...display, compact: minimized, onComposerHasText: setComposerHasText }),
    [display, minimized]
  )
  // Minimizado e sem texto: a caixa vira uma faixa de 1 linha, sem os botões (planningChat.css).
  const smallBox = minimized && !composerHasText

  /** Vai para `next` (e grava) só se mudar. */
  const setTo = useCallback((next: boolean) => {
    setMinimized((v) => {
      if (v === next) return v
      store.current.save(next)
      return next
    })
  }, [])

  const toggle = useCallback((e?: { stopPropagation: () => void }) => {
    e?.stopPropagation()
    setMinimized((v) => {
      store.current.save(!v)
      return !v
    })
  }, [])

  useSignal(collapseSignal, () => setTo(true))
  useSignal(expandSignal, () => setTo(false))

  // Clicar fora do chat (no escopo) o minimiza e tira o foco dele — é o foco
  // (`:focus-within`) que o mantinha opaco depois do clique na área, já que o
  // canvas (React Flow, WebGL) não deixa o clique no fundo tirar o foco da caixa
  // de texto. Captura: o canvas para a propagação do mousedown.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      const panel = ref.current
      const target = e.target
      if (!panel || !(target instanceof Node) || panel.contains(target)) return
      if (target instanceof Element && target.closest(NEVER_OUTSIDE)) return
      if (collapseScope === 'area' && !panel.parentElement?.contains(target)) return
      const focused = document.activeElement
      if (focused instanceof HTMLElement && panel.contains(focused)) focused.blur()
      setTo(true)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [setTo, collapseScope])

  // Clicar no painel minimizado o expande — o gesto mais direto para voltar a
  // conversar. A seta (que também alterna) chama stopPropagation.
  const expandFromClick = useCallback(() => setTo(false), [setTo])

  const label = `${minimized ? 'Maximizar' : 'Minimizar'} o chat do ${name}`
  return (
    // pl-chat: o gancho estável de "o chat da tela" (o App.test procura o ChatPanel nele).
    // nokey: Delete/Backspace digitados no chat não apagam o card selecionado no canvas.
    <section
      ref={ref}
      className={`pl-chat pl-chat-float nokey${minimized ? ' minimized' : ''}${smallBox ? ' composer-small' : ''}${className ? ` ${className}` : ''}`}
      aria-label={name}
      style={top === null ? style : { ...style, top }}
      onClick={minimized ? expandFromClick : undefined}
    >
      <header className="pl-chat-float-head">
        {header ?? <span className="pl-chat-float-title">{name}</span>}
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
        <ChatDisplayContext.Provider value={ctx}>{children}</ChatDisplayContext.Provider>
      </div>
    </section>
  )
}
