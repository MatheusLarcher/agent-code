import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from 'react'
import type { BrowserState } from '@shared/ipc'

export function BrowserPanel({ state }: { state: BrowserState }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const lastMove = useRef(0)
  const [addr, setAddr] = useState('')
  const [selectMode, setSelectMode] = useState(false)

  // Draw incoming screencast frames onto the canvas.
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
      img.src = `data:image/jpeg;base64,${f.data}`
    })
    return off
  }, [])

  useEffect(() => {
    if (state.url) setAddr(state.url)
  }, [state.url])

  const norm = (e: MouseEvent<HTMLCanvasElement>): { nx: number; ny: number } => {
    const r = e.currentTarget.getBoundingClientRect()
    return { nx: (e.clientX - r.left) / r.width, ny: (e.clientY - r.top) / r.height }
  }

  const onMove = (e: MouseEvent<HTMLCanvasElement>): void => {
    const now = performance.now()
    if (now - lastMove.current < 33) return // ~30fps
    lastMove.current = now
    const { nx, ny } = norm(e)
    void window.api.sendBrowserInput({ type: 'move', nx, ny })
  }

  const onClick = (e: MouseEvent<HTMLCanvasElement>): void => {
    e.currentTarget.focus()
    const { nx, ny } = norm(e)
    const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left'
    void window.api.sendBrowserInput({ type: 'click', nx, ny, button })
  }

  const onWheel = (e: WheelEvent<HTMLCanvasElement>): void => {
    const { nx, ny } = norm(e as unknown as MouseEvent<HTMLCanvasElement>)
    void window.api.sendBrowserInput({ type: 'wheel', nx, ny, dx: e.deltaX, dy: e.deltaY })
  }

  const onKey = (e: KeyboardEvent<HTMLCanvasElement>): void => {
    e.preventDefault()
    const text = e.key.length === 1 ? e.key : undefined
    void window.api.sendBrowserInput({ type: 'key', key: e.key, text })
  }

  const go = (): void => {
    if (addr.trim()) void window.api.navigate(addr.trim())
  }

  const toggleSelect = (): void => {
    const next = !selectMode
    setSelectMode(next)
    void window.api.setSelectMode(next)
  }

  return (
    <section className="browser-panel">
      <div className="browser-toolbar">
        <button className="nav-btn" onClick={() => window.api.browserBack()} title="Back">
          ‹
        </button>
        <button className="nav-btn" onClick={() => window.api.browserForward()} title="Forward">
          ›
        </button>
        <button className="nav-btn" onClick={() => window.api.browserReload()} title="Reload">
          ⟳
        </button>
        <input
          className="addr"
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
          placeholder="Enter URL…"
        />
        <button className="nav-btn" onClick={go} title="Go">
          →
        </button>
        <button className={`select-toggle ${selectMode ? 'active' : ''}`} onClick={toggleSelect} title="Pick an element and send it to chat">
          ⊹ Select
        </button>
      </div>

      <div className="browser-stage">
        {!state.launched && (
          <div className="browser-placeholder">
            <p>The browser opens automatically when the agent needs it,</p>
            <p>or open it now:</p>
            <button className="btn primary" onClick={() => window.api.launchBrowser()}>
              Open browser
            </button>
          </div>
        )}
        <canvas
          ref={canvasRef}
          className={`browser-canvas ${selectMode ? 'picking' : ''} ${state.launched ? '' : 'hidden'}`}
          tabIndex={0}
          onMouseMove={onMove}
          onClick={onClick}
          onContextMenu={(e) => e.preventDefault()}
          onWheel={onWheel}
          onKeyDown={onKey}
        />
      </div>

      <div className="browser-status">
        {selectMode ? (
          <span className="picking-hint">Select mode — click any element to add it to your message</span>
        ) : (
          <span className="title-text">{state.title || 'No page loaded'}</span>
        )}
      </div>
    </section>
  )
}
