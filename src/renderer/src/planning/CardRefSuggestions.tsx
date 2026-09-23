/**
 * Lista de sugestões do '[[' — cards do plano para citar pelo nome — e o hook
 * que liga a lista a um campo de texto (textarea ou input).
 *
 * Genérico de propósito: recebe só a lista de cards ({ id, titulo, tipo }) e o
 * valor do campo, sem saber de editor nem de plano. Cada item mostra o ícone e
 * a COR do tipo iguais aos do canvas (cardTypes.tsx); a cor vem por
 * typeColorVar, que funciona dentro e fora da tela de planejamento.
 *
 * Uso: `const ac = useCardRefAutocomplete({ cards, value, onChange, inputRef })`;
 * no campo, `onKeyDown={(e) => { if (ac.handleKeyDown(e)) return; … }}` e
 * `ac.sync(texto, cursor)` no onChange/onSelect; `{ac.open && <CardRefSuggestions … />}`.
 */
import './cardEditor.css'
import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject
} from 'react'
import { CARD_TYPE_LABEL, TypeIcon, typeColorVar } from './cardTypes'
import { detectRefTrigger, filterRefCards, insertRef, refLabel, type RefCard, type RefTrigger } from './cardRefs'

export interface CardRefSuggestionsProps<T extends RefCard> {
  /** Já filtrados (useCardRefAutocomplete faz isso). */
  items: readonly T[]
  /** Índice do item em destaque (setas). */
  active: number
  onPick: (card: T) => void
  onActiveChange?: (index: number) => void
  /** id do listbox (o campo aponta para ele com aria-controls). */
  id?: string
  className?: string
  emptyText?: string
}

export function CardRefSuggestions<T extends RefCard>({
  items,
  active,
  onPick,
  onActiveChange,
  id,
  className,
  emptyText = 'Nenhum card com esse nome'
}: CardRefSuggestionsProps<T>): JSX.Element {
  const listRef = useRef<HTMLUListElement>(null)
  useLayoutEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [active, items])

  return (
    // mousedown sem default: o campo não perde o foco (nem grava) ao clicar na lista.
    <div className={`pl-refs${className ? ` ${className}` : ''}`} onMouseDown={(e) => e.preventDefault()}>
      {items.length === 0 ? (
        <p className="pl-refs-empty">{emptyText}</p>
      ) : (
        <ul ref={listRef} id={id} role="listbox" aria-label="Cards para citar">
          {items.map((card, i) => (
            <li
              key={card.id}
              id={id ? `${id}-${i}` : undefined}
              role="option"
              aria-selected={i === active}
              data-tipo={card.tipo}
              className={`pl-ref-item${i === active ? ' active' : ''}`}
              style={{ '--pl-ref-color': typeColorVar(card.tipo) } as CSSProperties}
              onMouseEnter={() => onActiveChange?.(i)}
              onClick={() => onPick(card)}
            >
              <span className="pl-ref-icon">
                <TypeIcon tipo={card.tipo} size={13} />
              </span>
              <span className="pl-ref-title">{card.titulo || card.id}</span>
              <span className="pl-ref-type">{CARD_TYPE_LABEL[card.tipo] ?? card.tipo}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export interface CardRefAutocompleteOptions<T extends RefCard> {
  cards: readonly T[]
  /** O próprio card (não se cita). */
  excludeId?: string
  value: string
  onChange: (text: string) => void
  inputRef: RefObject<HTMLTextAreaElement | HTMLInputElement | null>
  limit?: number
}

export interface CardRefAutocomplete<T extends RefCard> {
  open: boolean
  items: T[]
  active: number
  listId: string
  setActive: (index: number) => void
  /** Chame no onChange/onSelect/onClick do campo, com o texto e o cursor. */
  sync: (text: string, cursor: number | null) => void
  /** Chame primeiro no onKeyDown: true = a tecla era da lista (já com preventDefault). */
  handleKeyDown: (e: KeyboardEvent) => boolean
  pick: (card: T) => void
  /** Esconde a lista. `dismiss` (padrão, o Esc): não volta para este '[['. Sem
   *  ele (ex.: o campo perdeu o foco), volta no próximo sync. */
  close: (dismiss?: boolean) => void
  /** aria-* para o campo. */
  inputAria: { 'aria-autocomplete': 'list'; 'aria-controls'?: string; 'aria-activedescendant'?: string }
}

export function useCardRefAutocomplete<T extends RefCard>({
  cards,
  excludeId,
  value,
  onChange,
  inputRef,
  limit
}: CardRefAutocompleteOptions<T>): CardRefAutocomplete<T> {
  const listId = useId()
  const [trigger, setTriggerState] = useState<RefTrigger | null>(null)
  const [active, setActive] = useState(0)
  const triggerRef = useRef<RefTrigger | null>(null)
  // Esc fecha a lista para ESTE '[[': ela só volta num '[[' novo.
  const dismissed = useRef<number | null>(null)
  const pendingCaret = useRef<number | null>(null)
  const valueRef = useRef(value)
  valueRef.current = value

  const items = useMemo(
    () => (trigger ? filterRefCards(cards, trigger.query, { excludeId, limit }) : []),
    [cards, trigger, excludeId, limit]
  )
  const itemsRef = useRef(items)
  itemsRef.current = items

  const setTrigger = useCallback((next: RefTrigger | null) => {
    const prev = triggerRef.current
    if (prev && next && prev.start === next.start && prev.end === next.end && prev.query === next.query) return
    if (prev?.start !== next?.start || prev?.query !== next?.query) setActive(0)
    triggerRef.current = next
    setTriggerState(next)
  }, [])

  const sync = useCallback(
    (text: string, cursor: number | null) => {
      let next = detectRefTrigger(text, cursor)
      if (!next) dismissed.current = null
      else if (dismissed.current === next.start) next = null
      setTrigger(next)
    },
    [setTrigger]
  )

  const close = useCallback(
    (dismiss = true) => {
      if (dismiss && triggerRef.current) dismissed.current = triggerRef.current.start
      setTrigger(null)
    },
    [setTrigger]
  )

  const pick = useCallback(
    (card: T) => {
      const text = valueRef.current
      const el = inputRef.current
      let t = triggerRef.current
      // O texto pode ter mudado por fora desde o gatilho: confere antes de cortar.
      if (!t || text.slice(t.start, t.start + 2) !== '[[') t = detectRefTrigger(text, el?.selectionStart ?? null)
      if (!t) return
      const out = insertRef(text, t, refLabel(card, cards))
      pendingCaret.current = out.cursor
      setTrigger(null)
      onChange(out.text)
    },
    [cards, inputRef, onChange, setTrigger]
  )

  // Depois de inserir, o cursor fica logo depois do ']]'.
  useLayoutEffect(() => {
    const caret = pendingCaret.current
    const el = inputRef.current
    if (caret == null || !el) return
    pendingCaret.current = null
    el.focus()
    el.setSelectionRange(caret, caret)
  }, [value, inputRef])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent): boolean => {
      if (!trigger || e.nativeEvent.isComposing) return false
      const list = itemsRef.current
      const n = list.length
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
        return true
      }
      if (!n) return false
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n))
        return true
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pick(list[Math.min(active, n - 1)])
        return true
      }
      return false
    },
    [trigger, active, close, pick]
  )

  const open = trigger !== null
  const inputAria: CardRefAutocomplete<T>['inputAria'] = {
    'aria-autocomplete': 'list',
    'aria-controls': open && items.length ? listId : undefined,
    'aria-activedescendant': open && items.length ? `${listId}-${Math.min(active, items.length - 1)}` : undefined
  }

  return { open, items, active, listId, setActive, sync, handleKeyDown, pick, close, inputAria }
}
