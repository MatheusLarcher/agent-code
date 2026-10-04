/**
 * A barra de tarefas do monitor, no jeito da do Windows: o botão Iniciar (o
 * avatar do Agent, abre o menu dele), um botão por app — Código, Chat,
 * Contexto — com o nome ao lado e o selo, a bandeja e o alfinete.
 *
 * Escondida por padrão, deixa uma linha fina na borda de baixo com um traço por
 * app, no lugar em que o botão vai aparecer. Abre quando o mouse chega à faixa
 * da borda (REVEAL_MS de atraso: os botões do campo do Chat ficam colados nela)
 * ou quando um botão dela recebe foco (Tab); fecha HIDE_MS depois que o mouse
 * sobe para longe — pelo movimento na tela inteira, não só pelo `mouseleave`,
 * que não vem quando o ponteiro sai rápido. Fixada (alfinete), ocupa espaço
 * próprio e não esconde.
 *
 * A raiz da tela usa `overflow: clip`: com `hidden`, o foco num botão da barra
 * escondida (abaixo da borda) rolaria a tela inteira para cima.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { AgentCodeLogo, Icon, VsCodeLogo } from './icons'
import type { MonitorApp } from './monitorPrefs'

export const REVEAL_MS = 250
export const HIDE_MS = 650
/** Altura da faixa acima da barra em que o mouse ainda a mantém aberta. */
const KEEP_PX = 24
/** Parar o mouse num app por isto abre a prévia dele. */
export const PREVIEW_MS = 450

export const APP_LABEL: Record<MonitorApp, string> = { code: 'Código', chat: 'Chat', ctx: 'Contexto' }
const APP_KEY: Record<MonitorApp, number> = { code: 1, chat: 2, ctx: 3 }

export function AppIcon({ app, size = 20 }: { app: MonitorApp; size?: number }): JSX.Element {
  if (app === 'code') return <VsCodeLogo size={size} />
  if (app === 'chat') return <AgentCodeLogo size={size} />
  return (
    <span className="cm-appico-ctx" aria-hidden="true">
      <Icon name="layers" />
    </span>
  )
}

export interface TaskbarReveal {
  open: boolean
  /** Abre na hora (foco por teclado, menu). */
  show: () => void
  /** Pede para fechar (respeita o atraso, o alfinete e o menu aberto). */
  hide: () => void
  zone: { onMouseEnter: () => void; onMouseLeave: () => void }
  bar: { onMouseEnter: () => void; onMouseLeave: () => void; onFocus: () => void; onBlur: (e: React.FocusEvent<HTMLElement>) => void }
}

/** O mostra/esconde da barra. `hold` = algo aberto acima dela (menu) que a segura. */
export function useTaskbarReveal(rootRef: RefObject<HTMLElement | null>, barRef: RefObject<HTMLElement | null>, pinned: boolean, hold: boolean): TaskbarReveal {
  const [open, setOpen] = useState(false)
  const reveal = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideT = useRef<ReturnType<typeof setTimeout> | null>(null)
  const state = useRef({ open, pinned, hold })
  state.current = { open, pinned, hold }
  const clear = (t: { current: ReturnType<typeof setTimeout> | null }): void => {
    if (t.current) clearTimeout(t.current)
    t.current = null
  }
  const show = useCallback((): void => {
    clear(hideT)
    clear(reveal)
    setOpen(true)
  }, [])
  const hide = useCallback((): void => {
    clear(reveal)
    if (state.current.pinned || state.current.hold) return
    if (hideT.current) return
    hideT.current = setTimeout(() => {
      hideT.current = null
      setOpen(false)
    }, HIDE_MS)
  }, [])
  const wantOpen = useCallback((): void => {
    clear(hideT)
    if (state.current.open || reveal.current) return
    reveal.current = setTimeout(() => {
      reveal.current = null
      setOpen(true)
    }, REVEAL_MS)
  }, [])

  // O mouse subiu para longe da barra: fecha (não depende de um mouseleave que pode não vir).
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onMove = (e: MouseEvent): void => {
      const s = state.current
      if (!s.open || s.pinned || s.hold) return
      const target = e.target as Element | null
      if (target?.closest?.('.cm-startmenu, .cm-taskpreview, .cm-toasts')) return clear(hideT)
      const bar = barRef.current?.getBoundingClientRect()
      const limit = bar && bar.height > 0 ? bar.top - KEEP_PX : root.getBoundingClientRect().bottom - 46 - KEEP_PX
      if (e.clientY < limit) hide()
      else clear(hideT)
    }
    root.addEventListener('mousemove', onMove)
    return () => root.removeEventListener('mousemove', onMove)
  }, [rootRef, barRef, hide])

  useEffect(() => () => {
    clear(reveal)
    clear(hideT)
  }, [])
  // Desfixou ou o menu fechou com o mouse longe: volta a esconder.
  useEffect(() => {
    if (!pinned && !hold && open) hide()
  }, [pinned, hold, open, hide])

  return {
    open,
    show,
    hide,
    zone: { onMouseEnter: wantOpen, onMouseLeave: () => clear(reveal) },
    bar: {
      onMouseEnter: () => clear(hideT),
      onMouseLeave: hide,
      onFocus: show,
      onBlur: (e) => {
        if (!barRef.current?.contains(e.relatedTarget as Node | null)) hide()
      }
    }
  }
}

export interface TaskbarProps {
  app: MonitorApp
  pinned: boolean
  reveal: TaskbarReveal
  barRef: RefObject<HTMLElement | null>
  badges: { code: number; ctx: number }
  busy: boolean
  /** O Agent espera uma permissão sua: o Chat pisca em âmbar com "!". */
  needsYou: boolean
  startOpen: boolean
  tray: ReactNode
  onOpenApp: (app: MonitorApp) => void
  onToggleStart: () => void
  onTogglePin: () => void
  /** O mouse parou num app (prévia) ou saiu (null). */
  onHoverApp: (app: MonitorApp | null) => void
}

export function Taskbar(p: TaskbarProps): JSX.Element {
  const appsRef = useRef<HTMLDivElement>(null)
  const [ticks, setTicks] = useState<Array<{ app: MonitorApp; x: number }>>([])
  const ticksRef = useRef(ticks)
  // A linha fina: um traço por app, no meio de onde o botão dele aparece. Só pede
  // render quando a posição muda (o efeito roda a cada commit da tela).
  useLayoutEffect(() => {
    const el = appsRef.current
    if (!el) return
    // offsetLeft (layout), não getBoundingClientRect: a tela é transformada pela âncora (matrix3d).
    // O offsetParent do botão é a própria barra (posicionada, na borda esquerda da tela).
    const next = [...el.querySelectorAll<HTMLElement>('[data-app]')].map((b) => ({ app: b.dataset.app as MonitorApp, x: b.offsetLeft + b.offsetWidth / 2 }))
    const prev = ticksRef.current
    if (prev.length === next.length && prev.every((t, i) => t.app === next[i].app && t.x === next[i].x)) return
    ticksRef.current = next
    setTicks(next)
  })
  const hoverT = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hovering = useRef<MonitorApp | null>(null)
  const enterApp = (app: MonitorApp): void => {
    if (hoverT.current) clearTimeout(hoverT.current)
    if (hovering.current) {
      hovering.current = app
      p.onHoverApp(app)
      return
    }
    hoverT.current = setTimeout(() => {
      hoverT.current = null
      hovering.current = app
      p.onHoverApp(app)
    }, PREVIEW_MS)
  }
  const leaveApps = (): void => {
    if (hoverT.current) clearTimeout(hoverT.current)
    hoverT.current = null
    hovering.current = null
    p.onHoverApp(null)
  }
  useEffect(() => () => {
    if (hoverT.current) clearTimeout(hoverT.current)
  }, [])

  const apps: MonitorApp[] = ['code', 'chat', 'ctx']
  return (
    <>
      <div className="cm-peek" aria-hidden="true">
        {ticks.map((t) => (
          <i key={t.app} className={p.needsYou && t.app === 'chat' ? 'att' : t.app === p.app ? 'on' : undefined} style={{ left: `${t.x}px` }} />
        ))}
      </div>
      <div className="cm-tbzone" aria-hidden="true" {...p.reveal.zone} />
      <nav className="cm-taskbar" aria-label="Barra de tarefas do monitor" ref={p.barRef as RefObject<HTMLElement>} {...p.reveal.bar}>
        <button
          type="button"
          className="cm-tb-start"
          aria-expanded={p.startOpen}
          aria-label="Menu do Agent"
          title="Menu do Agent"
          onClick={p.onToggleStart}
        >
          <span className={`cm-avatar${p.busy ? ' busy' : ''}`}>
            <Icon name="bot" />
          </span>
        </button>
        <span className="cm-tb-sep" aria-hidden="true" />
        <div className="cm-tb-apps" ref={appsRef} onMouseLeave={leaveApps}>
          {apps.map((app) => {
            const att = app === 'chat' && p.needsYou
            return (
              <button
                key={app}
                type="button"
                data-app={app}
                className={`cm-tb-app${att ? ' att' : ''}`}
                aria-pressed={p.app === app}
                aria-label={APP_LABEL[app]}
                title={`${APP_LABEL[app]} (Alt+${APP_KEY[app]})`}
                onClick={() => p.onOpenApp(app)}
                onMouseEnter={() => enterApp(app)}
              >
                <span className="cm-appico">
                  <AppIcon app={app} />
                </span>
                <span aria-hidden="true">{APP_LABEL[app]}</span>
                {app === 'code' && p.badges.code > 0 && <span className="cm-tb-badge" aria-hidden="true">{p.badges.code}</span>}
                {app === 'chat' && att && (
                  <span className="cm-tb-badge warn" aria-hidden="true">
                    !
                  </span>
                )}
                {app === 'chat' && !att && p.busy && <span className="cm-busydot" title="trabalhando" aria-hidden="true" />}
                {app === 'ctx' && p.badges.ctx > 0 && <span className="cm-tb-badge" aria-hidden="true">{p.badges.ctx}</span>}
              </button>
            )
          })}
        </div>
        <div className="cm-tray">
          {p.tray}
          <button
            type="button"
            className="cm-pinb"
            aria-pressed={p.pinned}
            aria-label={p.pinned ? 'Desafixar a barra' : 'Fixar a barra'}
            title={p.pinned ? 'Desafixar a barra' : 'Fixar a barra'}
            onClick={p.onTogglePin}
          >
            <Icon name={p.pinned ? 'pin-off' : 'pin'} />
          </button>
        </div>
      </nav>
    </>
  )
}
