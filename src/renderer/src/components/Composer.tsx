import { useEffect, useState, type KeyboardEvent, type RefObject } from 'react'
import type { PickedElement } from '@shared/ipc'

const MAX_LINES = 8

interface Props {
  disabled: boolean
  busy: boolean
  chips: PickedElement[]
  onRemoveChip: (i: number) => void
  onSend: (text: string) => void
  onInterrupt: () => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
}

export function Composer(props: Props): JSX.Element {
  const [value, setValue] = useState('')

  // Auto-grow the textarea up to MAX_LINES, then scroll.
  useEffect(() => {
    const ta = props.textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 21
    const max = lh * MAX_LINES
    const next = Math.min(ta.scrollHeight, max)
    ta.style.height = `${next}px`
    ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden'
  }, [value, props.textareaRef])

  const submit = (): void => {
    if (props.disabled) return
    if (!value.trim() && props.chips.length === 0) return
    props.onSend(value)
    setValue('')
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="composer">
      {props.chips.length > 0 && (
        <div className="chips">
          {props.chips.map((c, i) => (
            <span className="chip" key={i} title={c.selector}>
              <span className="chip-tag">{c.tagName}</span>
              {c.id ? `#${c.id}` : c.text.slice(0, 24) || c.selector.slice(0, 24)}
              <button className="chip-x" onClick={() => props.onRemoveChip(i)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-row">
        <textarea
          ref={props.textareaRef}
          className="composer-input"
          placeholder={props.disabled ? 'Start a session first…' : 'Message Claude…  (Enter to send, Shift+Enter for newline)'}
          value={value}
          disabled={props.disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKey}
          rows={1}
        />
        {props.busy ? (
          <button className="btn stop" onClick={props.onInterrupt} title="Stop">
            ■
          </button>
        ) : (
          <button className="btn send" onClick={submit} disabled={props.disabled} title="Send">
            ↑
          </button>
        )}
      </div>
    </div>
  )
}
