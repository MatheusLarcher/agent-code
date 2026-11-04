import { useEffect, useState, type RefObject } from 'react'
import { fmtSize } from '../files'
import { isTokenNode } from './editorModel'
import type { InlineAtt } from './inlineAttachments'

type Hover = { id: string; node: Element; rect: DOMRect }

/**
 * Prévia ampliada do anexo sob o mouse. Some sozinha quando o anexo sai do
 * campo (envio, Backspace, troca de conversa): o `mouseout` não dispara num nó
 * removido, e sem isso a prévia ficava presa na tela. Também some ao mexer o
 * mouse para fora do anexo, rolar ou a janela perder o foco.
 */
export function useTokenHover(elRef: RefObject<HTMLDivElement | null>) {
  const [hover, setHover] = useState<Hover | null>(null)

  useEffect(() => {
    if (!hover) return
    const clear = (): void => setHover(null)
    const check = (): void => {
      if (!hover.node.isConnected || !elRef.current?.contains(hover.node)) clear()
    }
    const el = elRef.current
    const mo = el ? new MutationObserver(check) : null
    if (el) mo?.observe(el, { childList: true, subtree: true })
    const onMove = (e: MouseEvent): void => {
      if (e.target !== hover.node) clear()
    }
    document.addEventListener('mousemove', onMove, true)
    window.addEventListener('scroll', clear, true)
    window.addEventListener('blur', clear)
    check()
    return () => {
      mo?.disconnect()
      document.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('scroll', clear, true)
      window.removeEventListener('blur', clear)
    }
  }, [hover, elRef])

  const over = (target: Node): void => {
    if (!isTokenNode(target)) return
    setHover({ id: target.getAttribute('data-att-id') ?? '', node: target, rect: target.getBoundingClientRect() })
  }
  const out = (target: Node): void => {
    if (isTokenNode(target)) setHover(null)
  }
  return { hover, over, out }
}

/** `midia:N` conta só as mídias (trecho e elemento têm numeração própria, no nome). */
export function mediaNumber(id: string, order: readonly string[], atts: ReadonlyMap<string, InlineAtt>): number {
  const media = order.filter((x) => {
    const k = atts.get(x)?.kind
    return k !== 'quote' && k !== 'element'
  })
  return media.indexOf(id) + 1
}

export function MediaPreview({ att, n, rect }: { att: InlineAtt; n: number; rect: DOMRect }): JSX.Element {
  const style = {
    left: Math.max(8, Math.min(rect.left, window.innerWidth - 280)),
    bottom: Math.max(8, window.innerHeight - rect.top + 8)
  }
  const size = att.kind === 'file' ? att.file.size : att.kind === 'ref' ? att.ref.size : 0
  if (att.kind === 'element') {
    return (
      <div className="inline-att-preview" style={style} role="tooltip">
        <div className="inline-att-preview-cap">
          <b>{att.name}</b> · {att.el.tabName || 'web'}
          <div className="inline-att-preview-path">{att.el.selector}</div>
          {att.el.text.trim() && <div className="inline-att-preview-path">{att.el.text.slice(0, 200)}</div>}
        </div>
      </div>
    )
  }
  if (att.kind === 'quote') {
    return (
      <div className="inline-att-preview" style={style} role="tooltip">
        <div className="inline-att-preview-cap">
          <b>{att.name}</b> · mensagem {att.quote.messageId}
          <div className="inline-att-preview-path qc-preview-text">{att.quote.text}</div>
        </div>
      </div>
    )
  }
  return (
    <div className="inline-att-preview" style={style} role="tooltip">
      {att.kind === 'image' ? <img src={att.src} alt="" /> : <img className="chip" src={att.src} alt="" />}
      <div className="inline-att-preview-cap">
        <b>midia:{n}</b> {att.name}
        {size > 0 && ` · ${fmtSize(size)}`}
        {att.kind === 'ref' && <div className="inline-att-preview-path">{att.ref.path}</div>}
      </div>
    </div>
  )
}
