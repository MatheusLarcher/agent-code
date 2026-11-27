import { Fragment, useEffect, useId, useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { BubbleElement } from './elementToken'
import { elementKind, elementName as friendlyName } from './elementName'
import './elementRef.css'

/**
 * Texto da bolha do usuário com cada "[elemento N]" trocado por um chip: a bolinha
 * com o número (a mesma marca que o Preview põe na página) e a tag do elemento. No
 * hover ou no foco abre a dica do app com o que é o elemento: tag, id e classes,
 * o texto, o seletor e a aba de onde veio. "[elemento N]" sem dados fica como está.
 */
export function ElementRefText({
  text,
  elements,
  renderText = (t) => t
}: {
  text: string
  elements: readonly BubbleElement[]
  renderText?: (text: string) => ReactNode
}): JSX.Element {
  const parts: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(/\[elemento (\d+)\]/g)) {
    const el = elements.find((e) => e.n === Number(m[1]))
    if (!el) continue
    const at = m.index ?? 0
    if (at > last) parts.push(<Fragment key={`t${last}`}>{renderText(text.slice(last, at))}</Fragment>)
    parts.push(<ElementChip key={`e${at}`} el={el} />)
    last = at + m[0].length
  }
  if (last < text.length) parts.push(<Fragment key={`t${last}`}>{renderText(text.slice(last))}</Fragment>)
  return <>{parts}</>
}

/** Nome legível do elemento na etiqueta ("botão “Comprar”", "forma do slide"). */
export function elementName(el: BubbleElement): string {
  return friendlyName({ tag: el.tag, id: el.id, classes: el.classes, text: el.text })
}

function ElementChip({ el }: { el: BubbleElement }): JSX.Element {
  const [rect, setRect] = useState<DOMRect | null>(null)
  const tipId = useId()
  const show = (e: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>): void =>
    setRect(e.currentTarget.getBoundingClientRect())
  const hide = (): void => setRect(null)
  const name = elementName(el)
  // A dica é fixed com o retângulo do momento do hover/foco: se qualquer coisa
  // rolar (a conversa, a página), ela ficaria solta no lugar antigo. Fecha.
  const open = rect !== null
  useEffect(() => {
    if (!open) return
    const onScroll = (): void => setRect(null)
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => window.removeEventListener('scroll', onScroll, { capture: true })
  }, [open])
  return (
    <>
      <span
        className="el-ref-chip"
        tabIndex={0}
        aria-label={`Elemento ${el.n}: ${name}`}
        aria-describedby={rect ? tipId : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(e) => e.key === 'Escape' && hide()}
      >
        <span className="el-ref-num" aria-hidden="true">
          {el.n}
        </span>
        <span className="el-ref-name" aria-hidden="true">
          {name}
        </span>
      </span>
      {rect && createPortal(<ElementTip id={tipId} el={el} rect={rect} />, document.body)}
    </>
  )
}

const TIP_W = 320

function ElementTip({ id, el, rect }: { id: string; el: BubbleElement; rect: DOMRect }): JSX.Element {
  // Acima do chip; sem espaço em cima (chip no topo da janela), abaixo dele.
  const above = rect.top > 220
  const style = {
    left: Math.max(8, Math.min(rect.left, window.innerWidth - TIP_W - 8)),
    ...(above ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 })
  }
  const classes = el.classes ? el.classes.split(' ') : []
  return (
    <div className="el-ref-tip" role="tooltip" id={id} style={style}>
      <div className="el-ref-tip-head">
        <span className="el-ref-num">{el.n}</span>
        <span className="el-ref-tip-title">
          Elemento {el.n} · {elementKind({ tag: el.tag, classes: el.classes })}
        </span>
      </div>
      <div className="el-ref-tip-tag">
        <span className="el-ref-tip-tagname">&lt;{el.tag || '?'}&gt;</span>
        {el.id && <span className="el-ref-tip-id">#{el.id}</span>}
        {classes.map((c) => (
          <span key={c} className="el-ref-tip-class">
            .{c}
          </span>
        ))}
      </div>
      {el.text && <p className="el-ref-tip-text">{el.text}</p>}
      {el.selector && (
        <div className="el-ref-tip-row">
          <span className="el-ref-tip-label">Seletor</span>
          <code>{el.selector}</code>
        </div>
      )}
      {el.tab && (
        <div className="el-ref-tip-row">
          <span className="el-ref-tip-label">Aba</span>
          <span>{el.tab}</span>
        </div>
      )}
    </div>
  )
}
