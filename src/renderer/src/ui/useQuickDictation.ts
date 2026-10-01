import { useEffect, useRef, useState } from 'react'
import { encodeWav } from '../wav'

/**
 * Minimal push-to-talk dictation for small text fields (e.g. the question modal's
 * "Outro…" answer): click to start, click again to stop; the whole take is encoded
 * as WAV and transcribed once. The Composer keeps its own VAD-segmented flow.
 */
export function useQuickDictation(
  onText: (text: string) => void,
  onError: (msg: string) => void
): { recording: boolean; busy: boolean; toggle: () => void } {
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const rec = useRef<{ stream: MediaStream; ctx: AudioContext; chunks: Float32Array[] } | null>(null)

  const release = (): { chunks: Float32Array[]; rate: number } | null => {
    const r = rec.current
    rec.current = null
    if (!r) return null
    r.stream.getTracks().forEach((t) => t.stop())
    void r.ctx.close().catch(() => {})
    return { chunks: r.chunks, rate: r.ctx.sampleRate }
  }

  useEffect(() => () => void release(), [])

  const start = async (): Promise<void> => {
    if (!navigator.mediaDevices?.getUserMedia) return onError('Captura de áudio indisponível.')
    try {
      const micId = localStorage.getItem('agentcode.micId') ?? ''
      const stream = await navigator.mediaDevices.getUserMedia({ audio: micId ? { deviceId: { exact: micId } } : true })
      const ctx = new AudioContext()
      void ctx.resume().catch(() => {})
      const chunks: Float32Array[] = []
      const src = ctx.createMediaStreamSource(stream)
      const proc = ctx.createScriptProcessor(4096, 1, 1)
      proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
      const mute = ctx.createGain()
      mute.gain.value = 0 // the processor must reach the destination to fire; keep it silent
      src.connect(proc)
      proc.connect(mute)
      mute.connect(ctx.destination)
      rec.current = { stream, ctx, chunks }
      setRecording(true)
    } catch (err) {
      onError(`Não consegui acessar o microfone: ${err instanceof Error ? err.name || err.message : String(err)}`)
    }
  }

  const stop = async (): Promise<void> => {
    setRecording(false)
    const take = release()
    if (!take || take.chunks.length === 0) return
    setBusy(true)
    try {
      const blob = encodeWav(take.chunks, take.rate)
      const b64 = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => {
          const s = String(fr.result)
          const i = s.indexOf('base64,')
          resolve(i >= 0 ? s.slice(i + 7) : '')
        }
        fr.onerror = () => reject(fr.error)
        fr.readAsDataURL(blob)
      })
      const r = await window.api.transcribeAudio(b64, 'audio/wav')
      if (r.ok && r.text?.trim()) onText(r.text.trim())
      else if (!r.ok) onError(`Transcrição falhou: ${r.error ?? 'erro'}`)
    } catch (err) {
      onError(`Erro na transcrição: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return { recording, busy, toggle: () => void (recording ? stop() : start()) }
}
