/**
 * Leitor de QR pela câmera. O quadro vivo é desenhado num <canvas>; o <video> fica
 * minúsculo e escondido — no WebView, um <video> visível vira superfície nativa e
 * engole os toques (o "Cancelar" deixava de responder). Decodifica a ~8 fps:
 * decodificar a cada quadro satura a thread principal e a tela para de responder.
 * Um QR legível que não é de uma ponte avisa por `onForeign` UMA vez por abertura e o
 * leitor continua aberto, procurando o QR certo.
 */
import { useEffect, useRef } from 'react'
import type { PairConfig } from '../core/config'
import { decodeFrame } from './decode'

export function Scanner({ onResult, onCancel, onFail, onForeign }: {
  onResult: (cfg: PairConfig) => void
  onCancel: () => void
  onFail: (msg: string) => void
  /** Leu um QR que não é da ponte (chamado uma vez por abertura do leitor). */
  onForeign?: () => void
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cb = useRef({ onResult, onFail, onForeign })
  cb.current = { onResult, onFail, onForeign }

  useEffect(() => {
    let stream: MediaStream | null = null
    let timer = 0
    let stopped = false
    let foreignWarned = false // o aviso de "QR de outra coisa" sai uma vez; o mesmo QR na frente da câmera não o repete
    const stop = (): void => {
      stopped = true
      if (timer) clearTimeout(timer)
      stream?.getTracks().forEach((t) => t.stop())
      stream = null
      if (videoRef.current) videoRef.current.srcObject = null
    }
    const tick = (): void => {
      const v = videoRef.current
      const c = canvasRef.current
      if (stopped || !v || !c) return
      if (v.readyState >= 2 && v.videoWidth) {
        const ctx = c.getContext('2d', { willReadFrequently: true })
        if (ctx) {
          if (c.width !== v.videoWidth) c.width = v.videoWidth
          if (c.height !== v.videoHeight) c.height = v.videoHeight
          ctx.drawImage(v, 0, 0, c.width, c.height)
          const img = ctx.getImageData(0, 0, c.width, c.height)
          const found = decodeFrame(img.data, img.width, img.height)
          if (found && 'cfg' in found) {
            stop()
            cb.current.onResult(found.cfg)
            return
          }
          if (found && !foreignWarned) {
            foreignWarned = true
            cb.current.onForeign?.()
          }
        }
      }
      timer = window.setTimeout(tick, 120)
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      cb.current.onFail(
        window.isSecureContext
          ? 'Câmera indisponível neste aparelho.'
          : 'A câmera só funciona no app instalado (no navegador por http ela é bloqueada).'
      )
      return
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        stream = s
        const v = videoRef.current
        if (!v) return
        // muted + autoplay + playsinline: o WebView toca o MediaStream sem gesto.
        v.srcObject = s
        v.muted = true
        v.playsInline = true
        const play = (): void => void v.play().catch(() => undefined)
        v.onloadedmetadata = play
        play()
        timer = window.setTimeout(tick, 300)
      })
      .catch((e: { name?: string }) => {
        stop()
        cb.current.onFail(
          e?.name === 'NotAllowedError'
            ? 'Permissão de câmera negada. Libere a câmera para o app nas configurações do Android.'
            : `Não foi possível abrir a câmera (${e?.name || 'erro'}).`
        )
      })
    return stop
  }, [])

  return (
    // Toque em qualquer lugar do leitor também cancela.
    <div className="scanner" onClick={onCancel}>
      <canvas ref={canvasRef} className="scan-view" />
      <video ref={videoRef} className="scan-src" autoPlay playsInline muted />
      <div className="scan-mask"><div className="scan-frame" /></div>
      <p className="scan-hint">Aponte a câmera para o QR exibido no PC</p>
      <button type="button" className="btn ghost scan-cancel" onClick={onCancel}>Cancelar</button>
    </div>
  )
}
