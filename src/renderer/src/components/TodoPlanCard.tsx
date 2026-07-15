import { useState } from 'react'
import type { TodoPlan } from '../types'
import { IconChevronDown, IconSpinner } from './Icons'

/** Fixed, collapsible card showing the agent's current TodoWrite plan, right
 *  above the composer. Closed by default: a spinner (while `active`) + the
 *  in-progress task's `activeForm` + a dot per item (done/active/pending) +
 *  a count badge. Click the header to see the full list. Once the turn ends
 *  (`active: false`) it collapses to a "N/N concluído" summary — it never
 *  disappears, so the plan stays as a record of what happened. */
export function TodoPlanCard({ plan }: { plan: TodoPlan }): JSX.Element {
  const [open, setOpen] = useState(false)
  const total = plan.items.length
  const done = plan.items.filter((t) => t.status === 'completed').length
  const current = plan.items.find((t) => t.status === 'in_progress')

  return (
    <div className={`todo-plan-card${open ? ' open' : ''}`}>
      <button type="button" className="todo-plan-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {plan.active ? (
          <IconSpinner className="spinner" size={13} />
        ) : (
          <span className="todo-plan-check-all" aria-hidden="true">
            ✓
          </span>
        )}
        <span className="todo-plan-title">
          {plan.active && current ? current.activeForm : `${done}/${total} concluído`}
        </span>
        <span className="todo-plan-dots" aria-hidden="true">
          {plan.items.map((t, i) => (
            <span key={i} className={`todo-plan-dot ${t.status}`} />
          ))}
        </span>
        <span className="todo-plan-count">
          {done}/{total}
        </span>
        <IconChevronDown size={13} className="todo-plan-caret" />
      </button>
      {open && (
        <div className="todo-plan-body">
          {plan.items.map((t, i) => (
            <div className="todo-plan-item" key={i}>
              <span className={`todo-plan-item-check ${t.status}`}>{t.status === 'completed' ? '✓' : ''}</span>
              <span className={`todo-plan-item-text ${t.status}`}>{t.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
