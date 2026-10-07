/**
 * A janela das últimas linhas de uma lista rolável (Gemini-style), com a âncora
 * no topo — a do chat (MessageList), reaproveitada pela Central do PC e do
 * celular:
 *
 *   - desenha só as últimas `visible` linhas (começa com `page`);
 *   - perto do topo (80 px) com mais acima, +`page` linhas, e a MESMA linha da
 *     tela fica no mesmo lugar (âncora em DOM, não em delta de scrollHeight —
 *     o streaming muda a altura no mesmo commit);
 *   - lendo o histórico (fora do fim), linha nova no fim aumenta a janela, para
 *     o começo dela não andar (ajuste no render: a 1ª linha nunca sai do DOM).
 *
 * Quem monta guarda o "está no fim" (o seu limite de px) e chama `onScrollTop`
 * no onScroll. `anchorSelector`: as linhas que servem de âncora (filhas diretas
 * da caixa rolável).
 */
import { useCallback, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react'

/** Linhas por página no chat e na Central. */
export const WINDOW_PAGE = 40
/** Até aqui do topo carrega a página de cima. */
const TOP_PX = 80

export interface ScrollWindow {
  /** Índice da 1ª linha desenhada. */
  start: number
  hasOlder: boolean
  /** Prepend em andamento: quem segue o fim não mexe na rolagem até a âncora voltar. */
  loadingOlder: MutableRefObject<boolean>
  /** Chamar no onScroll: perto do topo, carrega mais mantendo a leitura. */
  onScrollTop: () => void
  /** Garante pelo menos `n` linhas desenhadas (busca, mapa de perguntas). */
  showAtLeast: (n: number) => void
}

export function useScrollWindow(
  scrollRef: RefObject<HTMLElement | null>,
  total: number,
  opts: { isAtEnd: () => boolean; anchorSelector: string; page?: number }
): ScrollWindow {
  const page = opts.page ?? WINDOW_PAGE
  const [visible, setVisible] = useState(page)
  const [knownTotal, setKnownTotal] = useState(total)
  const loadingOlder = useRef(false)
  const loadAnchor = useRef<{ node: HTMLElement; top: number } | null>(null)

  // Lendo o histórico: o começo da janela fica parado quando chega linha no fim.
  if (total !== knownTotal) {
    const added = total - knownTotal
    setKnownTotal(total)
    if (added > 0 && !opts.isAtEnd()) setVisible((v) => v + added)
  }
  const start = Math.max(0, total - visible)

  // Depois do prepend: a mesma linha no mesmo lugar da tela.
  useLayoutEffect(() => {
    if (!loadingOlder.current) return
    const el = scrollRef.current
    const anchor = loadAnchor.current
    if (el && anchor?.node.isConnected) el.scrollTop += anchor.node.getBoundingClientRect().top - anchor.top
    loadAnchor.current = null
    loadingOlder.current = false
  }, [visible, scrollRef])

  const onScrollTop = (): void => {
    const el = scrollRef.current
    if (!el || el.scrollTop >= TOP_PX || start <= 0 || loadingOlder.current) return
    const anchor = Array.from(el.children).find(
      (node): node is HTMLElement => node instanceof HTMLElement && node.matches(opts.anchorSelector)
    )
    loadAnchor.current = anchor ? { node: anchor, top: anchor.getBoundingClientRect().top } : null
    loadingOlder.current = true
    setVisible((v) => v + page)
  }

  const showAtLeast = useCallback((n: number): void => setVisible((v) => (v < n ? n : v)), [])

  return { start, hasOlder: start > 0, loadingOlder, onScrollTop, showAtLeast }
}

/** O aviso do topo da janela. */
export const loadMoreText = (older: number): string => `↑ Role para cima para carregar mais (${older} anteriores)`
