/**
 * Abas da área principal, na barra superior: Conversa ⇄ Escritório.
 *
 * - `MainTabs`: o seletor (tablist), na família das pane-tabs, com a aba ativa
 *   na cor de acento. A aba Escritório traz um selo vivo com quantos agentes
 *   estão trabalhando no escritório inteiro e um raio na cor do nível da
 *   energia (as LEVEL_COLORS da pílula do HUD, numa variável CSS; apagado e
 *   riscado no apagão) — lidos do officeStore (mainTabState), sem carregar o
 *   3D, com a mesma histerese da pílula (a leitura anterior fica num ref). E o
 *   selo dos chamados: quantos agentes chamam o usuário para ver um HTML
 *   (useOfficeCalls: também avisa o main — notificação do Windows e celular).
 * - `useMainTab`: a aba escolhida, lembrada entre sessões.
 * - `OfficeTabHost`: o Escritório 3D em tela cheia. O chunk do three carrega num
 *   momento ocioso depois de a janela abrir (ou na 1ª abertura da aba, se vier
 *   antes); depois o escritório fica montado, PAUSADO com a aba Conversa, e
 *   volta na hora com a mesma câmera.
 * - `OfficeErrorBoundary`: uma falha no 3D não derruba o app — vira um aviso
 *   com "Voltar para a Conversa", e a aba gravada passa a ser a Conversa (a
 *   próxima abertura do app não volta para um escritório quebrado).
 */
import './mainTabs.css'
import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { officeStore } from '../office/officeStore'
import { markSwitch, setOfficeMounted } from '../perf/freezeWatch'
import type { Office3DWorkspaceProps } from '../office3d/Office3DWorkspace'
import { LEVEL_COLORS, POWER_LABEL, type OfficePower, type PowerLevel } from '../office3d/power'
import { useOfficeCalls } from '../office3d/useOfficeCalls'
import { IconChat, IconOffice, IconSpinner, IconZap } from './Icons'
import { loadMainTab, officeTabStatus, saveMainTab, type MainTab } from './mainTabState'

export type { MainTab } from './mainTabState'

const Office3DWorkspace = lazy(() => import('../office3d/Office3DWorkspace').then((m) => ({ default: m.Office3DWorkspace })))

const subscribeOffice = (cb: () => void): (() => void) => officeStore.subscribe(cb)
const readOffice = (): ReturnType<typeof officeStore.getSnapshot> => officeStore.getSnapshot()

/** A aba escolhida e quem troca (e grava). */
export function useMainTab(): [MainTab, (tab: MainTab) => void] {
  const [tab, setTab] = useState<MainTab>(loadMainTab)
  // A aba atual num ref: o detector de travadas só mede troca de verdade.
  const current = useRef(tab)
  current.current = tab
  const select = useCallback((next: MainTab) => {
    if (next !== current.current) markSwitch('aba')
    setTab(next)
    saveMainTab(next)
  }, [])
  return [tab, select]
}

/** Dica da aba Escritório: quem trabalha e a energia. */
export function officeTabTitle(working: number, level: PowerLevel | null, pct: number | null): string {
  const who = working === 0 ? 'ninguém trabalhando agora' : `${working} agente${working === 1 ? '' : 's'} trabalhando`
  const energy = level ? ` · energia ${pct ?? 0}% (${POWER_LABEL[level]})` : ''
  return `Escritório 3D: todos os projetos numa tela só — ${who}${energy}`
}

export interface MainTabsProps {
  active: MainTab
  onSelect: (tab: MainTab) => void
}

export function MainTabs({ active, onSelect }: MainTabsProps): JSX.Element {
  const feed = useSyncExternalStore(subscribeOffice, readOffice)
  // A leitura anterior da energia: a histerese do nível (a mesma da pílula do HUD).
  const prevPower = useRef<OfficePower | null>(null)
  const status = useMemo(() => officeTabStatus(feed, Date.now(), prevPower.current), [feed])
  useEffect(() => {
    prevPower.current = status.power
  }, [status])
  const { working, level, pct } = status
  const calls = useOfficeCalls(feed, active === 'office').length
  return (
    <div className="main-tabs" role="tablist" aria-label="Área principal">
      <button
        type="button"
        role="tab"
        aria-selected={active === 'chat'}
        className={`main-tab${active === 'chat' ? ' on' : ''}`}
        onClick={() => onSelect('chat')}
        title="Conversa: o chat com o painel da direita (ou a Tela de Planejamento)"
      >
        <IconChat size={15} className="main-tab-icon" />
        Conversa
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={active === 'office'}
        className={`main-tab${active === 'office' ? ' on' : ''}${working > 0 ? ' live' : ''}`}
        onClick={() => onSelect('office')}
        title={officeTabTitle(working, level, pct)}
      >
        <IconOffice size={15} className="main-tab-icon" />
        Escritório
        {working > 0 && (
          <span className="main-tab-live" data-testid="main-tab-working">
            {working}
          </span>
        )}
        {calls > 0 && (
          <span className="main-tab-calls" data-testid="main-tab-calls" title={`${calls} agente${calls === 1 ? '' : 's'} te chamando na TV`}>
            📣 {calls}
          </span>
        )}
        {level && (
          <span
            className={`main-tab-bolt lvl-${level}`}
            style={{ '--main-tab-bolt': LEVEL_COLORS[level] } as CSSProperties}
            data-testid="main-tab-bolt"
            data-level={level}
            aria-hidden="true"
          >
            <IconZap size={13} />
          </span>
        )}
      </button>
    </div>
  )
}

export interface OfficeTabHostProps extends Omit<Office3DWorkspaceProps, 'active'> {
  /** A aba Escritório está aberta. */
  active: boolean
}

/** Depois que a janela abre, espera isto e um momento ocioso para montar o escritório pausado. */
export const OFFICE_PRELOAD_AFTER_MS = 4_000
/** ...e este tempo sem tecla, clique nem rolagem: montar a cena ocupa a tela ~0,3 s, que não cai no meio da digitação. */
export const OFFICE_PRELOAD_QUIET_MS = 3_000
const INPUT_EVENTS = ['keydown', 'pointerdown', 'wheel'] as const

/** O escritório na área principal: montado PAUSADO no 1º momento ocioso depois de abrir a
 *  janela (ou na 1ª abertura da aba, se vier antes) e não desmonta mais — o 1º clique na
 *  aba não paga o chunk do three, o contexto WebGL nem a compilação dos shaders. */
export function OfficeTabHost({ active, ...rest }: OfficeTabHostProps): JSX.Element | null {
  const [opened, setOpened] = useState(active)
  // Estado derivado da prop (padrão do React): a 1ª abertura monta e não desmonta mais.
  if (active && !opened) setOpened(true)
  // Pré-carga no ocioso. Falhou? O OfficeErrorBoundary só mostra o aviso com a aba aberta.
  useEffect(() => {
    if (opened) return
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
      cancelIdleCallback?: (id: number) => void
    }
    let lastInput = Date.now()
    const onInput = (): void => void (lastInput = Date.now())
    for (const type of INPUT_EVENTS) window.addEventListener(type, onInput, { capture: true, passive: true })
    let idleId: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const quiet = (): boolean => Date.now() - lastInput >= OFFICE_PRELOAD_QUIET_MS
    const attempt = (): void => {
      if (!quiet()) timer = setTimeout(attempt, lastInput + OFFICE_PRELOAD_QUIET_MS - Date.now())
      else if (!w.requestIdleCallback) setOpened(true)
      else idleId = w.requestIdleCallback(() => (quiet() ? setOpened(true) : attempt()), { timeout: 15_000 })
    }
    timer = setTimeout(attempt, OFFICE_PRELOAD_AFTER_MS)
    return () => {
      clearTimeout(timer)
      if (idleId !== undefined) w.cancelIdleCallback?.(idleId)
      for (const type of INPUT_EVENTS) window.removeEventListener(type, onInput, { capture: true })
    }
  }, [opened])
  // Contexto do detector de travadas: o Escritório está montado.
  useEffect(() => {
    if (!opened) return
    setOfficeMounted(true)
    return () => setOfficeMounted(false)
  }, [opened])
  if (!opened) return null
  return (
    <Suspense
      fallback={
        active ? (
          <div className="workspace main-office-loading" role="status">
            <IconSpinner className="spinner" size={18} />
            Abrindo o escritório…
          </div>
        ) : null
      }
    >
      <Office3DWorkspace active={active} {...rest} />
    </Suspense>
  )
}

export interface OfficeErrorBoundaryProps {
  children: ReactNode
  /** A aba Escritório está aberta: só aí o aviso aparece. */
  active: boolean
  /** "Voltar para a Conversa". */
  onBack: () => void
}

/**
 * Falha no Escritório 3D (render, efeitos, o chunk do three que não carrega):
 * no lugar do app em branco, "O Escritório 3D falhou: <msg>" e o botão de
 * volta. Ao falhar já grava a aba Conversa; reabrir a aba tenta de novo.
 */
export class OfficeErrorBoundary extends Component<OfficeErrorBoundaryProps, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(): void {
    saveMainTab('chat')
  }

  componentDidUpdate(prev: OfficeErrorBoundaryProps): void {
    if (this.state.error && this.props.active && !prev.active) this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    if (!this.props.active) return null
    return (
      <div className="workspace main-office-error" role="alert">
        <p className="main-office-error-msg">O Escritório 3D falhou: {error.message || String(error)}</p>
        <button type="button" className="btn" onClick={this.props.onBack}>
          Voltar para a Conversa
        </button>
      </div>
    )
  }
}
