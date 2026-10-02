/**
 * Modo "Escritório 3D": no lugar do workspace (chat à esquerda, cena à
 * direita), como a Tela de Planejamento. O chat chega pronto (`chat`).
 *
 * O motor (three puro) vive enquanto este componente estiver montado; sair do
 * modo desmonta e libera GPU, listeners e RAF. Clique num agente voa até o
 * monitor dele e abre por cima, alinhado ao monitor, o cartão da ferramenta
 * atual no formato do chat (<ToolScreen>). Os balões de fala dos agentes são
 * do motor (speech.ts), numa camada DOM dentro do palco. A barra mostra a
 * energia do escritório (os tokens da sessão 5h da conta), lida pelo motor
 * (`onPower`). Só em DEV, Ctrl+Alt+Shift+D liga/desliga a demonstração
 * animada: um tique de DEMO_TICK_MS republica demoFeed(Date.now()) no
 * officeStore enquanto este componente estiver montado (e o motor encurta o
 * tempo até o cochilo); desligar ou desmontar limpa o intervalo e o override.
 * Também só em DEV, Ctrl+Alt+Shift+P abre/fecha o HUD de desempenho
 * (<PerfHud>) e Ctrl+Alt+Shift+B força o próximo nível de energia (cheia →
 * economia → alerta → apagão → …) — o mesmo listener de teclado dos atalhos.
 */
import './office3d.css'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { LookupInfo } from '../office/adapter/director'
import { officeStore } from '../office/officeStore'
import { DEMO_TICK_MS, demoFeed } from './demoFeed'
import { Office3DEngine, type EngineOptions } from './engine'
import { isPerfShortcut, PerfHud } from './PerfHud'
import type { OfficePower } from './power'
import { SessionBattery } from './SessionBattery'
import { ToolScreen } from './ToolScreen'

export interface Office3DWorkspaceProps {
  chat: ReactNode
  onOpenConversation: (convId: string) => void
  onOpenFile: (path: string) => void
  /** Volta ao workspace normal. */
  onClose: () => void
  /** Só testes: renderer, RAF e fonte do feed injetáveis. */
  engineOptions?: EngineOptions
}

/** Atalho de DEV: Ctrl+Alt+Shift+D. */
export function isDemoShortcut(e: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'key'>): boolean {
  return e.ctrlKey && e.altKey && e.shiftKey && e.key.toLowerCase() === 'd'
}

/** Atalho de DEV: Ctrl+Alt+Shift+B (força o próximo nível de energia). */
export function isPowerShortcut(e: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'key'>): boolean {
  return e.ctrlKey && e.altKey && e.shiftKey && e.key.toLowerCase() === 'b'
}

export function Office3DWorkspace({ chat, onOpenConversation, onOpenFile, onClose, engineOptions }: Office3DWorkspaceProps): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<Office3DEngine | null>(null)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hud, setHud] = useState(false)
  const [power, setPower] = useState<OfficePower | null>(null)
  const [, setTick] = useState(0)
  const cbs = useRef({ onOpenConversation })
  cbs.current = { onOpenConversation }
  const source = engineOptions?.source ?? officeStore
  const readEngine = useCallback(() => engineRef.current, [])

  useEffect(() => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    if (!stage || !canvas) return
    let engine: Office3DEngine
    try {
      engine = new Office3DEngine(
        stage,
        canvas,
        { onFocus: setFocusKey, onOpen: (convId) => cbs.current.onOpenConversation(convId), onPower: setPower },
        engineOptions
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    }
    engineRef.current = engine
    return () => {
      engine.dispose()
      engineRef.current = null
      setFocusKey(null)
      setPower(null)
    }
    // engineOptions é fixo por montagem (testes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Com a tela aberta, o conteúdo acompanha o feed.
  useEffect(() => {
    if (!focusKey) return
    return source.subscribe(() => setTick((t) => t + 1))
  }, [focusKey, source])

  // Só DEV: demonstração animada (linha do tempo do demoFeed, um quadro por tique) e HUD de desempenho.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    let timer: ReturnType<typeof setInterval> | null = null
    const publish = (): void => officeStore.setOverride(demoFeed(Date.now()))
    const stop = (): void => {
      if (timer === null) return
      clearInterval(timer)
      timer = null
      engineRef.current?.setDemo(false)
      officeStore.setOverride(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (isPerfShortcut(e)) {
        e.preventDefault()
        setHud((on) => !on)
        return
      }
      if (isPowerShortcut(e)) {
        e.preventDefault()
        engineRef.current?.cyclePower()
        return
      }
      if (!isDemoShortcut(e)) return
      e.preventDefault()
      if (timer !== null) return stop()
      // Na demo o cochilo chega mais cedo (o loop tem 2 min, o sono pede 10).
      engineRef.current?.setDemo(true)
      publish()
      timer = setInterval(publish, DEMO_TICK_MS)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      stop()
    }
  }, [])

  const engine = engineRef.current
  const focused = focusKey && engine ? engine.scene.character(focusKey) : undefined
  const info: LookupInfo | undefined = focused
    ? { key: focused.key, convId: focused.model.convId, role: focused.model.role, trackId: focused.model.trackId }
    : undefined
  const screenRef = (el: HTMLDivElement | null): void => engineRef.current?.setScreenElement(el)

  return (
    <div className="workspace office3d-workspace">
      {chat}
      <div className="o3d-stage" ref={stageRef} data-testid="office3d-stage">
        <canvas ref={canvasRef} className="o3d-canvas" data-testid="office3d-canvas" tabIndex={-1} />
        {error ? (
          <div className="o3d-error" role="alert">
            Não foi possível iniciar o 3D (WebGL): {error}
          </div>
        ) : null}
        <div className="o3d-bar">
          <strong>Escritório 3D</strong>
          <SessionBattery power={power} />
          <span className="o3d-hint">WASD anda · Shift corre · arrastar gira · roda zoom · botão do meio move · clique abre a tela · Esc volta</span>
          <button type="button" className="btn ghost o3d-close" onClick={onClose} title="Voltar ao painel normal">
            Sair do 3D
          </button>
        </div>
        {focused && (
          <div ref={screenRef} className="o3d-screen-anchor" key={focused.key}>
            <ToolScreen feed={engine?.currentFeed ?? null} info={info} onOpenFile={onOpenFile} />
          </div>
        )}
        {import.meta.env.DEV && hud ? <PerfHud source={readEngine} /> : null}
      </div>
    </div>
  )
}
