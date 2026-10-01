/**
 * Aba "Escritório" do painel da direita. Monta o canvas sobre os singletons de
 * officeRuntime (o estado sobrevive à troca de aba) e liga o OfficeView.
 *
 * O laço só roda com `active` (aba Escritório escolhida + painel expandido) E
 * document.visibilityState === 'visible'; fora disso o rAF é cancelado.
 * Clique em balão de pedido chama onFocusRequest — o escritório nunca aprova.
 */
import { useEffect, useRef, useState } from 'react'
import { MemberCard } from '../AgentCrew'
import { officeStore } from '../../office/officeStore'
import { useUI } from '../../ui/UiProvider'
import { characterInfo } from './officeCard'
import { getOfficeRuntime } from './officeRuntime'
import { OfficeView, type HoverInfo, type OfficeViewOptions, type ScreenTarget } from './officeView'
import { CodeScreen } from './CodeScreen'
import { LEVEL_LABEL, ZOOM_LEVELS, type ZoomLevel } from './zoomLevels'
import { syntheticFeed } from './devFeed'
import './office.css'

export interface OfficePanelProps {
  /** Aba ativa e painel expandido. */
  active: boolean
  onOpenConversation: (convId: string) => void
  /** Leva ao pedido (permissão/pergunta) da conversa — sem aprovar. */
  onFocusRequest: (convId: string) => void
  /** Abre um arquivo (caminho absoluto) no FilePreview — clique no caminho da tela. */
  onOpenFile?: (path: string) => void
  /** Só testes: relógio do efeito de digitação da tela. */
  screenNow?: () => number
  /** Só testes: relógio e rAF injetáveis. */
  viewOptions?: OfficeViewOptions
}

export function OfficePanel({ active, onOpenConversation, onFocusRequest, onOpenFile, screenNow, viewOptions }: OfficePanelProps): JSX.Element {
  const { notify } = useUI()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const labelsRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<OfficeView | null>(null)
  const [hover, setHover] = useState<HoverInfo | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [openTrail, setOpenTrail] = useState(false)
  const [level, setLevel] = useState<ZoomLevel>('predio')
  const [screen, setScreen] = useState<ScreenTarget | null>(null)
  // Callbacks atuais sem recriar o view a cada render do App.
  const cbs = useRef({ onOpenConversation, onFocusRequest })
  cbs.current = { onOpenConversation, onFocusRequest }

  // Monta o view uma vez por canvas.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rt = getOfficeRuntime()
    const view = new OfficeView(
      canvas,
      labelsRef.current,
      rt,
      {
        onHover: setHover,
        onSelect: (id) => {
          setSelected(id)
          setOpenTrail(false)
        },
        onOpen: (convId, trackId) => {
          cbs.current.onOpenConversation(convId)
          if (trackId) setOpenTrail(true)
        },
        onFocusRequest: (convId) => cbs.current.onFocusRequest(convId),
        onLevel: setLevel,
        onScreen: setScreen
      },
      viewOptions
    )
    viewRef.current = view
    // Abre na sala do projeto da conversa ativa e acompanha a troca.
    let lastActive: string | null | undefined
    const follow = (): void => {
      const feed = officeStore.getSnapshot()
      if (!feed || feed.activeId === lastActive) return
      lastActive = feed.activeId
      const conv = feed.conversations.find((c) => c.id === feed.activeId)
      if (conv) view.focusProject(conv.cwd)
    }
    follow()
    const off = officeStore.subscribe(follow)
    return () => {
      off()
      view.dispose()
      viewRef.current = null
    }
    // viewOptions é fixo por montagem (testes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Liga/desliga o laço: aba ativa + documento visível.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const sync = (): void => {
      if (active && document.visibilityState === 'visible') view.start()
      else view.stop()
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      document.removeEventListener('visibilitychange', sync)
      view.stop()
    }
  }, [active])

  // Atalho só em DEV: Ctrl+Alt+Shift+O liga/desliga o feed sintético de medição.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey && e.altKey && e.shiftKey && e.key.toLowerCase() === 'o')) return
      const view = viewRef.current
      if (officeStore.overridden) {
        const s = view?.stats()
        officeStore.setOverride(null)
        notify('aviso', `Feed sintético desligado. ${s ? `${s.frames} quadros, ${s.avgWorkMs.toFixed(2)} ms/quadro` : ''}`)
      } else {
        officeStore.setOverride(syntheticFeed())
        notify('aviso', 'Feed sintético ligado: 5 salas, 20 personagens. Ctrl+Alt+Shift+O de novo mede e desliga.')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [notify])

  // Cartão lateral acompanha o feed (por evento do App, não por quadro).
  const [, setFeedTick] = useState(0)
  useEffect(() => {
    if (selected === null && !screen) return
    return officeStore.subscribe(() => setFeedTick((t) => t + 1))
  }, [selected, screen])

  // A tela recebe o elemento para o view ancorá-la a cada quadro.
  const screenRef = (el: HTMLDivElement | null): void => viewRef.current?.setScreenElement(el)

  const rt = getOfficeRuntime()
  const now = Date.now()
  const hoverInfo = hover ? characterInfo(rt.feed, rt.director.lookup(hover.id), now) : null
  const hoverLabel = hover ? rt.state.getCharacter(hover.id)?.label ?? '' : ''
  const selInfo = selected !== null ? characterInfo(rt.feed, rt.director.lookup(selected), now) : null
  const levelIdx = ZOOM_LEVELS.indexOf(level)
  const screenInfo = screen?.charId != null ? rt.director.lookup(screen.charId) : undefined
  const openFile = (path: string): void => {
    if (onOpenFile) onOpenFile(path)
    else notify('aviso', 'Abrir arquivo não está disponível aqui.')
  }

  return (
    <div className="office-panel">
      <div className="office-stage">
        <canvas ref={canvasRef} className="office-canvas" data-testid="office-canvas" />
        <div ref={labelsRef} className="office-labels" aria-hidden="true" />
        {screen && (
          <div ref={screenRef} className="office-screen-anchor">
            <div className="office-screen-grow" key={`${screen.charId}|${screen.deskUid}`}>
              <CodeScreen feed={rt.feed} info={screenInfo} onOpenFile={openFile} now={screenNow} />
            </div>
          </div>
        )}
        {hover && hoverInfo && (
          <div className="office-tip" role="tooltip" style={{ left: hover.x + 12, top: hover.y + 12 }}>
            <strong>{hoverInfo.name}</strong>
            <span className="office-tip-role">{hoverInfo.role}</span>
            {hoverInfo.convTitle && <span className="office-tip-conv">{hoverInfo.convTitle}</span>}
            {hoverLabel && <span className="office-tip-line">{hoverLabel}</span>}
          </div>
        )}
        <div className="office-zoom" role="group" aria-label="Zoom do escritório">
          <button
            type="button"
            className="nav-btn"
            onClick={() => viewRef.current?.zoomStep(-1)}
            disabled={levelIdx <= 0}
            title="Afastar"
          >
            −
          </button>
          <span className="office-zoom-level">{LEVEL_LABEL[level]}</span>
          <button
            type="button"
            className="nav-btn"
            onClick={() => viewRef.current?.zoomStep(1)}
            disabled={levelIdx >= ZOOM_LEVELS.length - 1}
            title="Aproximar"
          >
            +
          </button>
        </div>
      </div>
      {selInfo && (
        <aside className="office-card" aria-label="Personagem selecionado">
          {selInfo.convTitle && <div className="office-card-conv">{selInfo.convTitle}</div>}
          {selInfo.member ? (
            <MemberCard key={`${selected}-${openTrail}`} member={selInfo.member} now={now} defaultOpen={openTrail || undefined} />
          ) : (
            <div className="office-card-empty">{selInfo.name}</div>
          )}
        </aside>
      )}
    </div>
  )
}
