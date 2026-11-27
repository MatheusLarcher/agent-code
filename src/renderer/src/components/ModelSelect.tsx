/**
 * Seletor de modelo personalizado (sem o `<select>` nativo do Windows): um botão
 * que abre uma lista para cima, com teclado (setas, Home/End, Enter, Espaço,
 * Escape, Tab e busca por letra) e leitor de tela (listbox + option).
 * A lista fica sempre no DOM, escondida com `hidden` quando fechada.
 */
import { useEffect, useRef, useState } from 'react'
import { IconCheck, IconChevronDown } from './Icons'

export interface ModelSelectProps {
  models: ReadonlyArray<{ id: string; label: string }>
  value: string
  /** Travado: o clique não abre a lista, só chama onLockedClick (para explicar). */
  locked: boolean
  /** Dica do app (data-tip) no botão; nunca o title nativo. */
  tip?: string
  onChange: (id: string) => void
  onLockedClick: () => void
}

/** Janela da busca por letra: teclas com até esse intervalo somam na mesma busca. */
const TYPE_AHEAD_MS = 600

export function ModelSelect(props: ModelSelectProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const typed = useRef({ text: '', at: 0 })
  const idBase = useRef(`model-select-${Math.random().toString(36).slice(2, 8)}`).current
  const found = props.models.findIndex((m) => m.id === props.value)
  // Fora da lista: mostra o primeiro, como o <select> nativo fazia.
  const selected = found >= 0 ? found : 0
  const current = props.models[selected]

  useEffect(() => {
    if (!open) return
    listRef.current?.focus()
    const close = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  useEffect(() => {
    if (!open) return
    const item = listRef.current?.querySelector(`#${idBase}-${active}`)
    if (item && typeof item.scrollIntoView === 'function') item.scrollIntoView({ block: 'nearest' })
  }, [open, active, idBase])

  const openList = (): void => {
    if (props.locked) {
      props.onLockedClick()
      return
    }
    setActive(selected)
    setOpen(true)
  }
  const close = (refocus: boolean): void => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }
  const choose = (i: number): void => {
    const m = props.models[i]
    close(true)
    if (m && m.id !== props.value && !props.locked) props.onChange(m.id)
  }
  // Busca por letra em andamento (última tecla há até 600 ms): aí o espaço entra
  // na busca ("Opus 5" → "opus 5") em vez de escolher.
  const typing = (): boolean => typed.current.text !== '' && Date.now() - typed.current.at <= TYPE_AHEAD_MS
  const typeAhead = (key: string): void => {
    const now = Date.now()
    typed.current = { text: (now - typed.current.at > TYPE_AHEAD_MS ? '' : typed.current.text) + key.toLowerCase(), at: now }
    const hit = props.models.findIndex((m) => m.label.toLowerCase().startsWith(typed.current.text))
    if (hit >= 0) setActive(hit)
  }

  return (
    <div className="model-select-wrap" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`model-select${props.locked ? ' locked' : ''}`}
        data-value={current?.id ?? ''}
        aria-label={`Modelo: ${current?.label ?? ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${idBase}-list`}
        aria-disabled={props.locked}
        data-tip={props.tip}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={(e) => {
          if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
            e.preventDefault()
            openList()
          }
        }}
      >
        <span className="model-select-label">{current?.label ?? ''}</span>
        <IconChevronDown size={12} className="model-select-chevron" aria-hidden="true" />
      </button>
      <ul
        ref={listRef}
        id={`${idBase}-list`}
        className="model-select-list"
        role="listbox"
        aria-label="Modelo"
        tabIndex={-1}
        hidden={!open}
        aria-activedescendant={open ? `${idBase}-${active}` : undefined}
        onKeyDown={(e) => {
          const last = props.models.length - 1
          if (e.key === 'ArrowDown') setActive((a) => Math.min(last, a + 1))
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1))
          else if (e.key === 'Home') setActive(0)
          else if (e.key === 'End') setActive(last)
          else if (e.key === ' ' && typing()) typeAhead(' ')
          else if (e.key === 'Enter' || e.key === ' ') choose(active)
          else if (e.key === 'Escape') {
            e.stopPropagation()
            close(true)
          } else if (e.key === 'Tab') {
            close(false)
            return
          } else if (e.key.length === 1) typeAhead(e.key)
          else return
          e.preventDefault()
        }}
      >
        {props.models.map((m, i) => (
          <li
            key={m.id}
            id={`${idBase}-${i}`}
            role="option"
            data-value={m.id}
            aria-selected={i === selected}
            className={`model-select-option${i === active ? ' active' : ''}`}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(i)}
          >
            <span>{m.label}</span>
            {i === selected && <IconCheck size={13} aria-hidden="true" />}
          </li>
        ))}
      </ul>
    </div>
  )
}
