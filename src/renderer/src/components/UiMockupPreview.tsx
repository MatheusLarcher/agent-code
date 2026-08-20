import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { UiMockupArtifact } from '@shared/ipc'
import { isSafeUiMockupArtifact } from '@shared/uiMockup'

const VIEWPORTS = {
  desktop: { width: 1024, height: 640, initialScale: 0.55 },
  mobile: { width: 390, height: 760, initialScale: 0.72 }
} as const

function UiMockupPreviewComponent({ artifact }: { artifact: UiMockupArtifact }): JSX.Element | null {
  const valid = isSafeUiMockupArtifact(artifact)
  const frame = valid ? VIEWPORTS[artifact.viewport] : VIEWPORTS.desktop
  const cardRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState<number>(frame.initialScale)

  const fit = useCallback((): void => {
    const available = cardRef.current?.clientWidth ?? 0
    if (available > 0) setScale(Math.min(1, available / frame.width))
  }, [frame.width])

  useLayoutEffect(() => {
    fit()
    const element = cardRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    return () => observer.disconnect()
  }, [fit])

  if (!valid) return null

  return (
    <div className="msg assistant ui-mockup-message">
      <div className={`ui-mockup-card ${artifact.viewport}`}>
        <div className="ui-mockup-title">{artifact.title}</div>
        <div ref={cardRef} className={`ui-mockup-viewport ${artifact.viewport}`}>
          <div
            className="ui-mockup-stage"
            style={{ width: frame.width * scale, height: frame.height * scale }}
          >
            <iframe
              title={artifact.title}
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={artifact.html}
              width={frame.width}
              height={frame.height}
              style={{ transform: `scale(${scale})` }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

/** Streaming assistant text re-renders MessageList frequently. A persisted
 *  artifact is immutable, so avoid rescanning up to 250 kB of HTML each time. */
export const UiMockupPreview = memo(UiMockupPreviewComponent)
