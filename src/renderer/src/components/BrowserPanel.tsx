import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type WheelEvent
} from 'react'
import type { BrowserState } from '@shared/ipc'
import { DEVICE_OPTIONS, DEFAULT_DEVICE_ID, deviceForResolution, findDevice, type DeviceType } from '@shared/devices'
import { BrowserTabs } from './BrowserTabs'
import {
  IconArrowRight,
  IconChevronLeft,
  IconChevronRight,
  IconCollapseRight,
  IconHome,
  IconPointer,
  IconRefresh
} from './Icons'

interface Props {
  state: BrowserState
  minimized: boolean
  onToggleMinimize: () => void
  /** Panel width in CSS px (ignored when minimized). */
  width: number
  /** Open the "new tab" modal. */
  onRequestNewTab: () => void
  /** User approved/rejected the Google Stitch design shown in the active tab. */
  onStitchDecision: (decision: 'apply' | 'discard') => void
  /** True once the active Stitch design was approved — hides the action buttons. */
  stitchApplied: boolean
}

interface Res {
  w: number
  h: number
  dpi?: number
}

const DEFAULT_RES: Res = (() => {
  const d = findDevice(DEFAULT_DEVICE_ID)!
  return { w: d.width, h: d.height, dpi: d.dpi }
})()

export function BrowserPanel({ state, minimized, onToggleMinimize, width, onRequestNewTab, onStitchDecision, stitchApplied }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const lastMove = useRef(0)
  const [addr, setAddr] = useState('')
  const [selectMode, setSelectMode] = useState(false)
  const [stage, setStage] = useState({ w: 360, h: 700 })

  // Android device frame: the chosen size lives in `state.androidSize` (the real
  // device size, set here OR by the agent's android_set_device tool), so the frame
  // always reflects reality. `forceCustom` only controls whether the inputs show.
  const [forceCustom, setForceCustom] = useState(false)
  const [customW, setCustomW] = useState('1080')
  const [customH, setCustomH] = useState('2400')

  const activeTab = state.tabs.find((t) => t.active)
  const isAndroid = activeTab?.kind === 'android'
  const isStitch = activeTab?.kind === 'stitch'

  // Keep the page viewport matching the panel (web tabs reflow to it); also track
  // the stage size so the Android device frame can be sized to fit.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    let t: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (!r || r.width < 50 || r.height < 50) return
      const w = Math.round(r.width)
      const h = Math.round(r.height)
      setStage({ w, h })
      clearTimeout(t)
      t = setTimeout(() => void window.api.setBrowserViewport(w, h), 130)
    })
    ro.observe(el)
    return () => {
      clearTimeout(t)
      ro.disconnect()
    }
  }, [minimized])

  // Draw incoming frames onto the canvas (web = JPEG, Android = PNG).
  useEffect(() => {
    const img = new Image()
    imgRef.current = img
    img.onload = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      if (canvas.width !== img.naturalWidth) canvas.width = img.naturalWidth
      if (canvas.height !== img.naturalHeight) canvas.height = img.naturalHeight
      canvas.getContext('2d')?.drawImage(img, 0, 0)
    }
    const off = window.api.onBrowserFrame((f) => {
      img.src = `data:${f.mime ?? 'image/jpeg'};base64,${f.data}`
    })
    return off
  }, [])

  useEffect(() => {
    if (state.url) setAddr(state.url)
  }, [state.url])

  // Current device size = the real size reported in state (fallback to default).
  const cur: Res = state.androidSize
    ? { w: state.androidSize.width, h: state.androidSize.height }
    : DEFAULT_RES
  const matchId = deviceForResolution(cur.w, cur.h)?.id
  const selValue = forceCustom || !matchId ? 'custom' : matchId

  const deviceType: DeviceType = useMemo(() => {
    const d = matchId ? findDevice(matchId) : undefined
    if (d) return d.type
    return cur.h / cur.w < 1.6 ? 'tablet' : 'phone'
  }, [matchId, cur.w, cur.h])

  // Outer size of the device frame, fit into the stage keeping the screen aspect
  // (content box = the device aspect exactly, so the stream isn't distorted).
  const frame = useMemo(() => {
    const padX = deviceType === 'phone' ? 20 : 32
    const padY = deviceType === 'phone' ? 24 : 32
    const ar = cur.w / cur.h
    let sh = Math.max(60, stage.h * 0.9 - padY)
    let sw = sh * ar
    if (sw + padX > stage.w * 0.92) {
      sw = Math.max(40, stage.w * 0.92 - padX)
      sh = sw / ar
    }
    return { w: Math.round(sw + padX), h: Math.round(sh + padY) }
  }, [stage, cur.w, cur.h, deviceType])

  const norm = (e: MouseEvent<HTMLCanvasElement>): { nx: number; ny: number } => {
    const r = e.currentTarget.getBoundingClientRect()
    return { nx: (e.clientX - r.left) / r.width, ny: (e.clientY - r.top) / r.height }
  }
  const onMove = (e: MouseEvent<HTMLCanvasElement>): void => {
    const now = performance.now()
    if (now - lastMove.current < 33) return
    lastMove.current = now
    const { nx, ny } = norm(e)
    void window.api.sendBrowserInput({ type: 'move', nx, ny })
  }
  const btn = (e: MouseEvent<HTMLCanvasElement>): 'left' | 'right' | 'middle' =>
    e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left'
  // Press/release are sent separately so dragging works (text selection, sliders,
  // drag-and-drop). On the web page down+up already make a click.
  const onDown = (e: MouseEvent<HTMLCanvasElement>): void => {
    e.currentTarget.focus()
    const { nx, ny } = norm(e)
    void window.api.sendBrowserInput({ type: 'down', nx, ny, button: btn(e) })
  }
  const onUp = (e: MouseEvent<HTMLCanvasElement>): void => {
    const { nx, ny } = norm(e)
    void window.api.sendBrowserInput({ type: 'up', nx, ny, button: btn(e) })
  }
  // Kept for Android taps (the web page uses down/up above).
  const onClick = (e: MouseEvent<HTMLCanvasElement>): void => {
    e.currentTarget.focus()
    const { nx, ny } = norm(e)
    void window.api.sendBrowserInput({ type: 'click', nx, ny, button: btn(e) })
  }
  const onWheel = (e: WheelEvent<HTMLCanvasElement>): void => {
    const { nx, ny } = norm(e as unknown as MouseEvent<HTMLCanvasElement>)
    void window.api.sendBrowserInput({ type: 'wheel', nx, ny, dx: e.deltaX, dy: e.deltaY })
  }
  const onKey = (e: KeyboardEvent<HTMLCanvasElement>): void => {
    e.preventDefault()
    const mod = e.ctrlKey || e.metaKey
    // For Ctrl/Cmd combos, don't send a typed char — main bridges copy/paste/etc.
    const text = !mod && e.key.length === 1 ? e.key : undefined
    void window.api.sendBrowserInput({
      type: 'key',
      key: e.key,
      text,
      ctrl: e.ctrlKey,
      meta: e.metaKey,
      shift: e.shiftKey,
      alt: e.altKey
    })
  }

  const go = (): void => {
    if (addr.trim()) void window.api.navigate(addr.trim())
  }
  const toggleSelect = (): void => {
    const next = !selectMode
    setSelectMode(next)
    void window.api.setSelectMode(next)
  }

  const onSelectDevice = (id: string): void => {
    if (id === 'custom') {
      setForceCustom(true)
      return // wait for the user to apply width/height
    }
    setForceCustom(false)
    const d = findDevice(id)
    if (d) void window.api.setAndroidSize(d.width, d.height, d.dpi)
  }
  const applyCustom = (): void => {
    const w = Math.max(240, Math.min(4096, Math.round(Number(customW) || 0)))
    const h = Math.max(240, Math.min(4096, Math.round(Number(customH) || 0)))
    if (w >= 240 && h >= 240) void window.api.setAndroidSize(w, h)
  }

  const phones = DEVICE_OPTIONS.filter((d) => d.type === 'phone')
  const tablets = DEVICE_OPTIONS.filter((d) => d.type === 'tablet')

  const canvasEl = (
    <canvas
      ref={canvasRef}
      className={`browser-canvas ${selectMode ? 'picking' : ''} ${isAndroid ? 'in-frame' : ''} ${state.launched ? '' : 'hidden'}`}
      tabIndex={0}
      onMouseMove={onMove}
      onMouseDown={onDown}
      onMouseUp={onUp}
      onClick={onClick}
      onContextMenu={(e) => e.preventDefault()}
      onWheel={onWheel}
      onKeyDown={onKey}
    />
  )

  if (minimized) {
    return (
      <section className="browser-panel minimized">
        <button className="browser-restore" onClick={onToggleMinimize} title="Mostrar navegador">
          ‹ Navegador
        </button>
      </section>
    )
  }

  return (
    <section className="browser-panel" style={{ flex: `0 0 ${width}px` }}>
      <BrowserTabs tabs={state.tabs} onRequestNewTab={onRequestNewTab} />
      <div className="browser-toolbar">
        <button className="nav-btn" onClick={onToggleMinimize} title="Minimizar navegador">
          <IconCollapseRight />
        </button>
        <button
          className="nav-btn"
          onClick={() => window.api.browserBack()}
          title={isAndroid ? 'Voltar (Android)' : 'Voltar'}
        >
          <IconChevronLeft />
        </button>
        {!isAndroid && (
          <button className="nav-btn" onClick={() => window.api.browserForward()} title="Avançar">
            <IconChevronRight />
          </button>
        )}
        <button
          className="nav-btn"
          onClick={() => window.api.browserReload()}
          title={isAndroid ? 'Tela inicial (Android)' : 'Recarregar'}
        >
          {isAndroid ? <IconHome /> : <IconRefresh />}
        </button>
        {state.loading && <span className="nav-spinner" title="Carregando…" />}
        {isAndroid ? (
          <div className="android-bar">
            <select
              className="device-select"
              value={selValue}
              onChange={(e) => onSelectDevice(e.target.value)}
              title="Modelo do aparelho"
            >
              <optgroup label="Telefones">
                {phones.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} · {d.width}×{d.height}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Tablets">
                {tablets.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} · {d.width}×{d.height}
                  </option>
                ))}
              </optgroup>
              <option value="custom">Personalizado…</option>
            </select>
            {selValue === 'custom' && (
              <span className="custom-res">
                <input
                  className="res-input"
                  type="number"
                  value={customW}
                  onChange={(e) => setCustomW(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && applyCustom()}
                  title="Largura (px)"
                />
                <span className="res-x">×</span>
                <input
                  className="res-input"
                  type="number"
                  value={customH}
                  onChange={(e) => setCustomH(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && applyCustom()}
                  title="Altura (px)"
                />
                <button className="nav-btn" onClick={applyCustom} title="Aplicar resolução">
                  OK
                </button>
              </span>
            )}
          </div>
        ) : isStitch ? (
          <span className="stitch-toolbar-label">✨ Design gerado pelo Stitch — revise e aprove abaixo</span>
        ) : (
          <>
            <input
              className="addr"
              value={addr}
              onChange={(e) => setAddr(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && go()}
              placeholder="Digite a URL…"
            />
            <button className="nav-btn" onClick={go} title="Ir">
              <IconArrowRight />
            </button>
            <button className={`select-toggle ${selectMode ? 'active' : ''}`} onClick={toggleSelect} title="Selecionar um elemento e enviá-lo ao chat">
              <IconPointer size={14} /> Selecionar
            </button>
          </>
        )}
      </div>

      {isStitch &&
        (stitchApplied ? (
          <div className="stitch-approve-bar applied">
            <span className="stitch-approve-text">✓ Design aprovado — adaptando ao projeto e atualizando o preview…</span>
          </div>
        ) : (
          <div className="stitch-approve-bar">
            <span className="stitch-approve-text">Aprovar este design e aplicar no projeto?</span>
            <div className="stitch-approve-actions">
              <button className="btn ghost" onClick={() => onStitchDecision('discard')} title="Descartar o design">
                Descartar
              </button>
              <button className="btn primary" onClick={() => onStitchDecision('apply')} title="Aplicar este design no projeto (o agente adapta ao que você pediu)">
                ✓ Aplicar no projeto
              </button>
            </div>
          </div>
        ))}

      <div className={`browser-stage ${isAndroid ? 'android' : ''}`} ref={stageRef}>
        {!state.launched && (
          <div className="browser-placeholder">
            <p>O navegador abre automaticamente quando o agente precisar.</p>
          </div>
        )}
        {isAndroid ? (
          <div className="device-frame" data-type={deviceType} style={{ width: frame.w, height: frame.h }}>
            {deviceType === 'phone' && <span className="device-punch" />}
            <div className="device-screen">{canvasEl}</div>
          </div>
        ) : (
          canvasEl
        )}
      </div>

      <div className="browser-status">
        {selectMode ? (
          <span className="picking-hint">Modo seleção — clique em qualquer elemento para adicioná-lo à sua mensagem</span>
        ) : isAndroid ? (
          <span className="title-text">
            📱 {matchId ? findDevice(matchId)!.name : 'Personalizado'} · {cur.w}×{cur.h}
          </span>
        ) : (
          <span className="title-text">{state.title || 'Nenhuma página carregada'}</span>
        )}
      </div>
    </section>
  )
}
