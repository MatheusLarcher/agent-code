import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import { fmtSize } from '../files'
import { TOKEN, isTokenNode, offsetFromPoint, pointFromOffset, renderEditor, scanEditor, tokenAtCaret, type Scan } from './editorModel'
import { attAlt, type InlineAtt } from './inlineAttachments'

/**
 * Campo do composer com anexos no meio do texto (contenteditable).
 *
 * O elemento se apresenta como um textarea para o resto do Composer: `value`,
 * `selectionStart/End` e `setSelectionRange` usam o texto serializado (cada
 * anexo = 1 caractere, ver editorModel). Digitação, IME, colar e desfazer são
 * do navegador; o DOM só é reconstruído quando o valor muda POR FORA (ditado,
 * @menção escolhida, troca de conversa) — nunca durante uma composição de IME.
 */
export type EditorElement = HTMLDivElement & {
  value: string
  readonly disabled: boolean
  readonly readOnly: boolean
  readonly selectionStart: number
  readonly selectionEnd: number
  setSelectionRange(start: number, end: number): void
  /** Insere texto e anexos no cursor (ou em `at`), como um passo de desfazer. */
  insertParts(parts: Array<string | InlineAtt>, at?: number | null): void
  /** Troca o item `id` por texto (caminho colado que não resolveu). */
  replaceToken(id: string, text: string): void
  /** Atualiza a imagem/alt do item `id` (caminho colado que resolveu). */
  refreshToken(att: InlineAtt): void
  /** Última posição conhecida do cursor, mesmo com o foco fora (botão de anexar). */
  readonly lastCaret: number
}

interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'onInput' | 'onChange'> {
  value: string
  order: readonly string[]
  atts: ReadonlyMap<string, InlineAtt>
  editable: boolean
  editorRef: RefObject<EditorElement | null>
  /** O usuário editou (digitou, colou, apagou, desfez): texto, anexos na ordem e cursor. */
  onEdit: (value: string, order: string[], caret: number) => void
  /** O cursor andou sem editar. */
  onCaret?: (value: string, caret: number) => void
}

const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** O `src` (data: URL, pode ter MB) entra depois, pelo DOM: o HTML do insertHTML fica pequeno. */
function tokenHtml(att: InlineAtt): string {
  return `<img class="inline-att inline-att-${att.kind}" data-att-id="${escapeHtml(att.id)}" alt="${escapeHtml(attAlt(att))}" draggable="false">`
}

function findToken(root: HTMLElement, id: string): Element | null {
  return Array.from(root.querySelectorAll('img[data-att-id]')).find((n) => n.getAttribute('data-att-id') === id) ?? null
}

function tokenEl(doc: Document, att: InlineAtt): HTMLElement {
  const img = doc.createElement('img')
  img.className = `inline-att inline-att-${att.kind}`
  img.setAttribute('data-att-id', att.id)
  img.setAttribute('src', att.src)
  img.setAttribute('alt', attAlt(att))
  img.setAttribute('draggable', 'false')
  return img
}

export function InlineEditor({ value, order, atts, editable, editorRef, onEdit, onCaret, ...rest }: Props): JSX.Element {
  const elRef = useRef<HTMLDivElement | null>(null)
  const last = useRef({ value: '', order: [] as string[] })
  const props = useRef({ value, order, atts, onEdit, onCaret })
  props.current = { value, order, atts, onEdit, onCaret }
  const composing = useRef(false)
  const pendingCaret = useRef<number | null>(null)
  const lastCaret = useRef<number | null>(null)
  const [hover, setHover] = useState<{ att: InlineAtt; n: number; rect: DOMRect } | null>(null)
  // Uma varredura do DOM por edição: o resultado vale até o DOM mudar. O
  // MutationObserver diz se mudou (takeRecords é síncrono, então nunca se usa
  // uma varredura velha entre a mudança e o callback).
  const scanCache = useRef<{ scan: Scan | null; mo: MutationObserver | null }>({ scan: null, mo: null })
  // Arraste que começou numa seleção DENTRO do campo (ver onDrop).
  const dragSel = useRef<{ start: number; end: number } | null>(null)

  const scanNow = (): Scan => {
    const el = elRef.current
    if (!el) return { items: [], raw: '', value: '', order: [] } // campo já desmontado: nada a varrer
    const c = scanCache.current
    if (!c.mo || c.mo.takeRecords().length > 0) c.scan = null
    if (!c.scan) c.scan = scanEditor(el)
    return c.scan
  }

  const makeToken = (id: string): HTMLElement | null => {
    const att = props.current.atts.get(id)
    return att && elRef.current ? tokenEl(elRef.current.ownerDocument, att) : null
  }

  const selectionIn = (): Range | null => {
    const el = elRef.current
    const sel = el?.ownerDocument.getSelection()
    if (!el || !sel || sel.rangeCount === 0) return null
    const r = sel.getRangeAt(0)
    return el.contains(r.startContainer) ? r : null
  }

  const caretNow = (): number | null => {
    const el = elRef.current
    const r = selectionIn()
    return el && r ? offsetFromPoint(el, r.endContainer, r.endOffset, scanNow()) : null
  }

  const setCaret = (start: number, end = start): void => {
    const el = elRef.current
    if (!el) return
    const sel = el.ownerDocument.getSelection()
    if (!sel) return
    const a = pointFromOffset(el, start, scanNow())
    const b = end === start ? a : pointFromOffset(el, end, scanNow())
    const r = el.ownerDocument.createRange()
    r.setStart(a.node, a.offset)
    r.setEnd(b.node, b.offset)
    sel.removeAllRanges()
    sel.addRange(r)
    lastCaret.current = end
  }

  // Contorno no anexo encostado no cursor: é o que Backspace/Delete vão apagar.
  const markCaret = (caret: number | null): void => {
    const el = elRef.current
    if (!el) return
    el.querySelectorAll('img[data-caret]').forEach((n) => n.removeAttribute('data-caret'))
    if (caret == null || el.ownerDocument.activeElement !== el) return
    tokenAtCaret(el, caret, scanNow())?.setAttribute('data-caret', '')
  }

  const snapshot = (): { value: string; order: string[] } => {
    const s = scanNow()
    return { value: s.value, order: s.order }
  }

  const emitFromDom = (): void => {
    const el = elRef.current
    if (!el) return
    const next = snapshot()
    last.current = next
    const caret = caretNow() ?? next.value.length
    lastCaret.current = caret
    markCaret(caret)
    props.current.onEdit(next.value, next.order, caret)
  }

  /** Ponto do texto sob o mouse ao soltar (caretRangeFromPoint do Chromium). */
  const dropOffset = (e: DragEvent): number | null => {
    const el = elRef.current
    const doc = el?.ownerDocument as (Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }) | undefined
    const r = doc?.caretRangeFromPoint?.(e.clientX, e.clientY)
    return el && r && el.contains(r.startContainer) ? offsetFromPoint(el, r.startContainer, r.startOffset, scanNow()) : null
  }

  /** Move o trecho [start, end) (texto e anexos, na ordem) para `to`: apaga e insere, 2 passos de desfazer. */
  const moveRange = (start: number, end: number, to: number): void => {
    const el = elRef.current as EditorElement | null
    if (!el) return
    const { value, order } = scanNow()
    let k = 0
    for (let i = 0; i < start; i++) if (value[i] === TOKEN) k++
    const parts: Array<string | InlineAtt> = []
    let buf = ''
    for (let i = start; i < end && i < value.length; i++) {
      if (value[i] !== TOKEN) {
        buf += value[i]
        continue
      }
      const att = props.current.atts.get(order[k++] ?? '')
      if (!att) continue
      if (buf) parts.push(buf)
      buf = ''
      parts.push(att)
    }
    if (buf) parts.push(buf)
    if (parts.length === 0) return
    el.focus()
    setCaret(start, end)
    let ok = false
    try {
      ok = typeof document.execCommand === 'function' && document.execCommand('delete', false)
    } catch {
      ok = false
    }
    if (!ok) {
      selectionIn()?.deleteContents()
      emitFromDom()
    }
    el.insertParts(parts, to > end ? to - (end - start) : to)
  }

  // Fachada de textarea + inserção. Definida uma vez; lê sempre o estado mais novo.
  useLayoutEffect(() => {
    const el = elRef.current as EditorElement | null
    if (!el) return
    const mo = new MutationObserver(() => {
      scanCache.current.scan = null
    })
    mo.observe(el, { childList: true, characterData: true, subtree: true })
    scanCache.current = { scan: null, mo }
    const keepOrder = (v: string): string[] => last.current.order.slice(0, [...v].filter((c) => c === TOKEN).length)
    Object.defineProperties(el, {
      value: {
        configurable: true,
        get: () => last.current.value,
        // Troca do valor inteiro por fora (como `ta.value = x` + evento 'change'
        // num textarea): o DOM muda aqui e a edição é avisada no 'change' abaixo.
        set: (v: string) => {
          const ord = keepOrder(String(v))
          renderEditor(el, String(v), ord, makeToken)
          last.current = snapshot()
          lastCaret.current = last.current.value.length
        }
      },
      selectionStart: {
        configurable: true,
        get: () => {
          const r = selectionIn()
          return r ? offsetFromPoint(el, r.startContainer, r.startOffset, scanNow()) : (lastCaret.current ?? last.current.value.length)
        }
      },
      selectionEnd: {
        configurable: true,
        get: () => caretNow() ?? lastCaret.current ?? last.current.value.length
      },
      lastCaret: { configurable: true, get: () => lastCaret.current ?? last.current.value.length },
      // Como no textarea: `disabled` = sem sessão; `readOnly` = pasta do projeto sumiu.
      disabled: { configurable: true, get: () => el.getAttribute('aria-disabled') === 'true' },
      readOnly: { configurable: true, get: () => el.getAttribute('aria-readonly') === 'true' },
      setSelectionRange: {
        configurable: true,
        value: (start: number, end: number) => {
          if (!elRef.current) return // campo já desmontado (ex.: rAF do Composer depois da troca)
          // O Composer pode pedir o cursor antes de o DOM receber o valor novo.
          if (scanNow().value !== props.current.value) pendingCaret.current = start
          else setCaret(start, end)
        }
      },
      insertParts: {
        configurable: true,
        value: (parts: Array<string | InlineAtt>, at?: number | null) => {
          if (parts.length === 0) return
          // O ponto vem ANTES do focus (o foco pode mexer na seleção): cursor
          // atual no campo, senão o último conhecido (clique no botão de anexar).
          const pos = at ?? caretNow() ?? lastCaret.current ?? last.current.value.length
          el.focus()
          setCaret(pos)
          // Só texto (colar): insertText, texto puro. Com anexo: insertHTML. Os dois
          // entram na pilha de desfazer do navegador como um passo só.
          const onlyText = parts.every((p) => typeof p === 'string')
          const html = parts.map((p) => (typeof p === 'string' ? escapeHtml(p) : tokenHtml(p))).join('')
          let ok = false
          try {
            ok =
              typeof document.execCommand === 'function' &&
              document.execCommand(onlyText ? 'insertText' : 'insertHTML', false, onlyText ? parts.join('') : html)
          } catch {
            ok = false
          }
          if (ok) {
            // o navegador já disparou 'input' (emitFromDom); falta a imagem de cada item
            for (const p of parts) if (typeof p !== 'string') findToken(el, p.id)?.setAttribute('src', p.src)
            return
          }
          const doc = el.ownerDocument
          const r = selectionIn() ?? doc.createRange()
          if (!selectionIn()) {
            const p = pointFromOffset(el, pos, scanNow())
            r.setStart(p.node, p.offset)
            r.collapse(true)
          }
          r.deleteContents()
          const frag = doc.createDocumentFragment()
          for (const p of parts) frag.appendChild(typeof p === 'string' ? doc.createTextNode(p) : tokenEl(doc, p))
          const lastNode = frag.lastChild
          r.insertNode(frag)
          if (lastNode) {
            r.setStartAfter(lastNode)
            r.collapse(true)
            const sel = doc.getSelection()
            sel?.removeAllRanges()
            sel?.addRange(r)
          }
          emitFromDom()
        }
      },
      replaceToken: {
        configurable: true,
        value: (id: string, text: string) => {
          const node = findToken(el, id)
          if (!node) return
          node.replaceWith(el.ownerDocument.createTextNode(text))
          emitFromDom()
        }
      },
      refreshToken: {
        configurable: true,
        value: (att: InlineAtt) => {
          const node = findToken(el, att.id)
          if (!node) return
          node.className = `inline-att inline-att-${att.kind}`
          node.setAttribute('src', att.src)
          node.setAttribute('alt', attAlt(att))
        }
      }
    })
    editorRef.current = el
    return () => {
      mo.disconnect()
      scanCache.current = { scan: null, mo: null }
      if (editorRef.current === el) editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Valor mudou por fora -> reconstrói o DOM. Valor que veio do próprio DOM não mexe em nada.
  useLayoutEffect(() => {
    const el = elRef.current
    if (!el || composing.current) return
    if (value === last.current.value && sameOrder(order, last.current.order)) {
      if (pendingCaret.current != null) {
        setCaret(Math.min(pendingCaret.current, value.length))
        pendingCaret.current = null
      }
      return
    }
    const focused = el.ownerDocument.activeElement === el
    renderEditor(el, value, order, makeToken)
    last.current = snapshot()
    if (pendingCaret.current != null) {
      setCaret(Math.min(pendingCaret.current, last.current.value.length))
      pendingCaret.current = null
    } else if (focused) {
      setCaret(last.current.value.length)
    } else {
      lastCaret.current = Math.min(lastCaret.current ?? 0, last.current.value.length)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, order])

  // Eventos nativos: input (inclusive de IME e de execCommand), composição e cursor.
  useEffect(() => {
    const el = elRef.current
    if (!el) return
    const doc = el.ownerDocument
    const onInput = (): void => emitFromDom()
    // 'change' vem de quem trocou o `value` inteiro (a fachada de textarea).
    const onChange = (): void =>
      props.current.onEdit(last.current.value, last.current.order, lastCaret.current ?? last.current.value.length)
    el.addEventListener('change', onChange)
    const onStart = (): void => {
      composing.current = true
    }
    const onEnd = (): void => {
      composing.current = false
      emitFromDom()
    }
    const onSel = (): void => {
      const caret = caretNow()
      if (caret == null) return
      lastCaret.current = caret
      markCaret(caret)
      props.current.onCaret?.(last.current.value, caret)
    }
    const onBlur = (): void => markCaret(null)
    // O campo é texto puro: Ctrl+B/I/U e qualquer outro comando de formatação
    // (inputType format*) não entram — senão viriam <b>/<i>/<u> no DOM.
    const onBeforeInput = (e: Event): void => {
      if (String((e as InputEvent).inputType ?? '').startsWith('format')) e.preventDefault()
    }
    // Arraste de uma seleção DENTRO do campo: move o trecho (texto e anexos)
    // para o ponto solto. Sem ponto válido, ou solto dentro da própria seleção,
    // é recusado — nunca duplica. Arraste de fora segue para o Composer.
    const onDragStart = (): void => {
      const r = selectionIn()
      if (!r || r.collapsed) {
        dragSel.current = null
        return
      }
      const s = scanNow()
      const a = offsetFromPoint(el, r.startContainer, r.startOffset, s)
      const b = offsetFromPoint(el, r.endContainer, r.endOffset, s)
      dragSel.current = { start: Math.min(a, b), end: Math.max(a, b) }
    }
    const onDragEnd = (): void => {
      dragSel.current = null
    }
    const onDrop = (e: DragEvent): void => {
      const sel = dragSel.current
      if (!sel) return
      dragSel.current = null
      e.preventDefault()
      e.stopPropagation()
      const to = dropOffset(e)
      if (to == null || (to >= sel.start && to <= sel.end)) return
      moveRange(sel.start, sel.end, to)
    }
    el.addEventListener('beforeinput', onBeforeInput)
    el.addEventListener('dragstart', onDragStart)
    el.addEventListener('dragend', onDragEnd)
    el.addEventListener('drop', onDrop)
    el.addEventListener('input', onInput)
    el.addEventListener('compositionstart', onStart)
    el.addEventListener('compositionend', onEnd)
    el.addEventListener('blur', onBlur)
    doc.addEventListener('selectionchange', onSel)
    return () => {
      el.removeEventListener('beforeinput', onBeforeInput)
      el.removeEventListener('dragstart', onDragStart)
      el.removeEventListener('dragend', onDragEnd)
      el.removeEventListener('drop', onDrop)
      el.removeEventListener('input', onInput)
      el.removeEventListener('change', onChange)
      el.removeEventListener('compositionstart', onStart)
      el.removeEventListener('compositionend', onEnd)
      el.removeEventListener('blur', onBlur)
      doc.removeEventListener('selectionchange', onSel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Prévia ampliada no hover: flutua por cima (portal, fixed), sem mexer no texto.
  const onOver = (e: ReactMouseEvent<HTMLDivElement>): void => {
    rest.onMouseOver?.(e)
    const t = e.target as Node
    if (!isTokenNode(t)) return
    const id = t.getAttribute('data-att-id') ?? ''
    const att = props.current.atts.get(id)
    // midia:N conta só as mídias (o trecho citado tem numeração própria, no nome).
    const media = last.current.order.filter((x) => props.current.atts.get(x)?.kind !== 'quote')
    if (att) setHover({ att, n: media.indexOf(id) + 1, rect: t.getBoundingClientRect() })
  }
  const onOut = (e: ReactMouseEvent<HTMLDivElement>): void => {
    rest.onMouseOut?.(e)
    if (isTokenNode(e.target as Node)) setHover(null)
  }

  return (
    <>
      <div
        {...rest}
        ref={elRef}
        role="textbox"
        aria-multiline="true"
        tabIndex={editable ? 0 : -1}
        contentEditable={editable}
        suppressContentEditableWarning
        onMouseOver={onOver}
        onMouseOut={onOut}
      />
      {hover && createPortal(<MediaPreview {...hover} />, document.body)}
    </>
  )
}

function MediaPreview({ att, n, rect }: { att: InlineAtt; n: number; rect: DOMRect }): JSX.Element {
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
