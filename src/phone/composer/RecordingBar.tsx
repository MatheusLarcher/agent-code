/**
 * A barra de gravação (estilo WhatsApp) que ocupa a linha do composer enquanto o
 * ditado grava: 🗑 cancelar · ponto pulsando + cronômetro · medidor ao vivo · ✓
 * parar e transcrever. Transcrevendo, mostra "Transcrevendo…" até o texto entrar no campo.
 */
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/icons'
import { noFocusSteal } from '../ui/noFocusSteal'
import type { MicState } from './useDictation'

const BARS = 28
const SAMPLE_MS = 70

/** 7300 ms → "0:07"; 65 s → "1:05". */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Forma de onda rolando: o nível (RMS) do microfone a cada ~70 ms, sem re-render do React. */
function Waveform({ analyser }: { analyser: AnalyserNode | null }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!analyser || typeof requestAnimationFrame !== 'function') return
    const data = new Uint8Array(analyser.fftSize)
    const levels: number[] = new Array(BARS).fill(0)
    let raf = 0
    let last = 0
    const tick = (t: number): void => {
      raf = requestAnimationFrame(tick)
      if (t - last < SAMPLE_MS) return
      last = t
      analyser.getByteTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128
        sum += v * v
      }
      levels.shift()
      levels.push(Math.min(1, Math.sqrt(sum / data.length) * 4))
      const bars = ref.current?.children
      if (!bars) return
      for (let i = 0; i < bars.length; i++) (bars[i] as HTMLElement).style.transform = `scaleY(${(0.12 + 0.88 * levels[i]).toFixed(3)})`
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [analyser])
  return (
    <div className="rec-wave" ref={ref} aria-hidden="true">
      {Array.from({ length: BARS }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  )
}

export function RecordingBar({ state, startedAt, analyser, onCancel, onStop }: {
  state: Exclude<MicState, 'idle'>
  startedAt: number
  analyser: AnalyserNode | null
  onCancel: () => void
  onStop: () => void
}): JSX.Element {
  const recording = state === 'recording'
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!recording) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [recording])
  const elapsed = fmtClock(startedAt ? now - startedAt : 0)

  return (
    <div className={`rec-bar ${state}`} role="group" aria-label={recording ? 'Gravando áudio' : 'Transcrevendo áudio'}>
      <button type="button" className="icon-btn rec-cancel" aria-label="Cancelar gravação" title="Cancelar" disabled={!recording} {...noFocusSteal} onClick={onCancel}>
        <Icon name="trash" size={22} />
      </button>
      {recording ? (
        <>
          <span className="rec-dot" aria-hidden="true" />
          <span className="rec-time" role="timer" aria-label={`Gravando há ${elapsed}`}>{elapsed}</span>
          <Waveform analyser={analyser} />
        </>
      ) : (
        <span className="rec-status" role="status">
          <span className="spinner" />
          Transcrevendo…
        </span>
      )}
      <button type="button" className="send-btn rec-stop" aria-label="Parar e transcrever" title="Parar e transcrever" disabled={!recording} {...noFocusSteal} onClick={onStop}>
        <Icon name="check" size={22} strokeWidth={2.2} />
      </button>
    </div>
  )
}
