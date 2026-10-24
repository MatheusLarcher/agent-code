/**
 * Indicador de atualização na barra superior. Some em `ocioso`/`verificando`/
 * `baixando`/`erro`; aparece quando a versão nova está `pronta` (popover com
 * "Atualizar agora" ou "Atualizar quando os agentes terminarem"), `agendada`
 * (popover com "Cancelar agendamento") e `instalando` (travado, com spinner e
 * uma faixa fixa no topo: o app fecha e volta sozinho).
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { AppUpdateState } from '@shared/ipc'
import { IconClock, IconSpinner, IconUpdate } from './Icons'

export interface UpdateBadgeProps {
  state: AppUpdateState
  onInstallNow: () => void
  onScheduleWhenIdle: () => void
  onCancelSchedule: () => void
  /** Relê o estado ao abrir o popover (o `blockedBy` muda a cada segundo). */
  onRefresh: () => void
}

export const UPDATE_DIALOG_LABEL = 'Atualização do Agent Code'

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function UpdateBadge({ state, onInstallNow, onScheduleWhenIdle, onCancelSchedule, onRefresh }: UpdateBadgeProps): JSX.Element | null {
  const { phase, version, canInstallNow, blockedBy } = state
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const hasPopover = phase === 'pronta' || phase === 'agendada'

  // A fase mudou (ex.: a instalação começou): o popover não faz mais sentido.
  useEffect(() => {
    if (!hasPopover) setOpen(false)
  }, [hasPopover])

  useEffect(() => {
    if (!open) return
    onRefresh()
    popoverRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
    // onRefresh só precisa rodar ao abrir, não a cada render do pai.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!hasPopover && phase !== 'instalando') return null

  const close = (): void => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  // Tab circula dentro do popover enquanto ele está aberto.
  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab' || !popoverRef.current) return
    const items = Array.from(popoverRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    const current = document.activeElement
    if (e.shiftKey && (current === first || !popoverRef.current.contains(current))) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && current === last) {
      e.preventDefault()
      first.focus()
    }
  }

  if (phase === 'instalando') {
    const target = version ? `Atualizando para ${version}…` : 'Atualizando…'
    return (
      <div className="update-badge installing" ref={rootRef}>
        <span className="update-trigger installing" role="status" aria-disabled="true" aria-live="polite">
          <IconSpinner className="spinner" size={14} />
          Atualizando…
        </span>
        <div className="update-banner" role="status">
          <IconSpinner className="spinner" size={14} />
          {target} o app fecha e volta sozinho
        </div>
      </div>
    )
  }

  const scheduled = phase === 'agendada'
  const tip = scheduled
    ? 'Atualiza quando os agentes terminarem'
    : version
      ? `Atualização ${version} pronta`
      : 'Atualização pronta'
  const title = scheduled
    ? version
      ? `Atualização ${version} agendada`
      : 'Atualização agendada'
    : version
      ? `Versão ${version} pronta para instalar`
      : 'Nova versão pronta para instalar'

  return (
    <div className={`update-badge${open ? ' open' : ''}${scheduled ? ' scheduled' : ''}`} ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`update-trigger${scheduled ? ' scheduled' : ''}`}
        onClick={() => setOpen((v) => !v)}
        data-tip={tip}
        aria-label={tip}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        {scheduled ? <IconClock size={15} /> : <IconUpdate size={15} />}
      </button>
      {open && (
        <div className="update-popover" role="dialog" aria-label={UPDATE_DIALOG_LABEL} ref={popoverRef} onKeyDown={trapTab}>
          <h4>{title}</h4>
          {scheduled ? (
            <>
              <p className="update-popover-wait">
                <IconClock size={14} />
                <span>{blockedBy ? `Esperando: ${blockedBy}` : 'Esperando os agentes terminarem.'}</span>
              </p>
              <div className="update-popover-actions">
                <button type="button" className="btn small ghost" onClick={close}>
                  Fechar
                </button>
                <button type="button" className="btn small" onClick={onCancelSchedule}>
                  Cancelar agendamento
                </button>
              </div>
            </>
          ) : (
            <>
              <p>O app fecha, instala e volta em cerca de meio minuto.</p>
              {!canInstallNow && blockedBy && (
                <p className="update-popover-wait">
                  <IconClock size={14} />
                  <span>{blockedBy}</span>
                </p>
              )}
              <div className="update-popover-actions">
                <button type="button" className="btn small ghost" onClick={close}>
                  Depois
                </button>
                {canInstallNow ? (
                  <button type="button" className="btn small primary" onClick={onInstallNow}>
                    Atualizar agora
                  </button>
                ) : (
                  <button type="button" className="btn small primary" onClick={onScheduleWhenIdle}>
                    Atualizar quando os agentes terminarem
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
