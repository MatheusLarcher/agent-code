/**
 * Âncora no fim da lista de mensagens quando a LISTA muda de tamanho.
 *
 * A lista divide a coluna com o rodapé do chat (composer, "Última resposta",
 * fila, banners). Quando o rodapé cresce — o composer ganha linhas, o quadro
 * quebra, um aviso aparece — a lista encolhe mas o scrollTop fica onde estava,
 * e a última mensagem some atrás do rodapé. Numa coluna estreita (o chat do
 * Agent Manager) isso acontece já na primeira pintura.
 *
 * Regra: quem estava no fim continua no fim; quem tinha rolado para cima para
 * ler o histórico fica onde estava. Mensagens novas continuam com o efeito
 * próprio do MessageList — aqui é só a mudança de tamanho da caixa.
 */
import { useEffect, useRef, type RefObject } from 'react'

export interface ScrollBox {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/**
 * Para onde levar a rolagem depois que a caixa mudou de tamanho: o fim, se o
 * usuário estava nele (`wasAtEnd`) e ainda não está lá; `null` para não mexer.
 */
export function scrollTopToKeepEnd(box: ScrollBox, wasAtEnd: boolean): number | null {
  if (!wasAtEnd) return null
  const end = Math.max(0, box.scrollHeight - box.clientHeight)
  return Math.abs(box.scrollTop - end) < 1 ? null : end
}

/**
 * Observa o tamanho de `scrollRef` e reaplica a âncora a cada mudança.
 * `isAtEnd` é lido na hora do evento (sempre a versão do último render), então
 * pode depender de refs e props sem reassinar o observador.
 */
export function useKeepEndOnResize(scrollRef: RefObject<HTMLElement | null>, isAtEnd: () => boolean): void {
  const atEnd = useRef(isAtEnd)
  atEnd.current = isAtEnd
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const next = scrollTopToKeepEnd(el, atEnd.current())
      if (next !== null) el.scrollTop = next
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [scrollRef])
}
