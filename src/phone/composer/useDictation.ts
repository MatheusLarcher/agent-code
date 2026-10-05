/**
 * Microfone do composer: grava com o MediaRecorder e transcreve NO APARELHO
 * (Parakeet, voice/localStt.ts) quando o modelo está instalado — só o texto vai ao
 * PC. Sem o modelo (ou se a transcrição local falhar), o áudio vai ao
 * `/api/transcribe` do PC, como plano B.
 */
import { useEffect, useRef, useState } from 'react'
import { client, toast } from '../app/runtime'
import { HttpError } from '../core/net'
import { useStore } from '../core/store'
import { handleRecording, refreshStt, stt, sttReady } from '../voice/localStt'

export type MicState = 'idle' | 'recording' | 'transcribing'

function pickAudioMime(): string {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  if (typeof MediaRecorder === 'undefined') return ''
  return cands.find((c) => MediaRecorder.isTypeSupported(c)) ?? ''
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result)
      const i = s.indexOf('base64,')
      resolve(i >= 0 ? s.slice(i + 7) : '')
    }
    r.onerror = () => resolve('')
    r.readAsDataURL(blob)
  })
}

export function useDictation(insert: (text: string) => void): {
  available: boolean
  state: MicState
  toggle: () => void
} {
  const voiceReady = useStore(client.store, (s) => s.voiceReady)
  useStore(stt, (s) => `${s.installed}${s.usePc}${s.available}`)
  const [state, setState] = useState<MicState>('idle')
  const rec = useRef<{ recorder: MediaRecorder | null; stream: MediaStream | null; chunks: Blob[] }>({ recorder: null, stream: null, chunks: [] })
  const insertRef = useRef(insert)
  insertRef.current = insert

  useEffect(() => {
    void refreshStt()
    return () => {
      // Saiu da tela gravando: solta o microfone sem transcrever.
      const r = rec.current
      if (r.recorder && r.recorder.state !== 'inactive') {
        r.recorder.onstop = null
        try {
          r.recorder.stop()
        } catch {
          /* já parando */
        }
      }
      r.stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  // O mic aparece quando o PC transcreve ou o modelo do aparelho está instalado.
  const available = voiceReady || sttReady()

  const stopStream = (): void => {
    rec.current.stream?.getTracks().forEach((t) => t.stop())
    rec.current.stream = null
    rec.current.recorder = null
  }

  const transcribeOnPc = async (blob: Blob, type: string): Promise<void> => {
    setState('transcribing')
    try {
      const b64 = await blobToBase64(blob)
      if (!b64) return
      const d = await client.post<{ ok?: boolean; text?: string; error?: string }>('/api/transcribe', { audioBase64: b64, mimeType: type }, 120000)
      if (d?.ok && d.text) insertRef.current(d.text)
      else toast('Transcrição falhou: ' + (d?.error || 'erro'))
    } catch (err) {
      const body = err instanceof HttpError ? (err.body as { error?: string } | null) : null
      toast('Falha ao transcrever o áudio' + (body?.error ? `: ${body.error}` : '.'))
    } finally {
      setState('idle')
    }
  }

  const transcribe = (blob: Blob, type: string): void => {
    setState('transcribing')
    handleRecording(blob, {
      pcReady: client.state.voiceReady,
      toPc: () => void transcribeOnPc(blob, type),
      insert: (t) => insertRef.current(t),
      done: () => setState('idle'),
      fail: (msg) => {
        setState('idle')
        toast(msg)
      }
    })
  }

  const start = (): void => {
    if (!available) return toast('A voz não está disponível nesta versão do app do PC.')
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      return toast('Microfone indisponível aqui. Use o app instalado (no navegador via http a gravação é bloqueada).')
    }
    const mime = pickAudioMime()
    navigator.mediaDevices.getUserMedia({ audio: true }).then(
      (stream) => {
        const r = rec.current
        r.stream = stream
        r.chunks = []
        const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
        r.recorder = recorder
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size) r.chunks.push(e.data)
        }
        recorder.onstop = () => {
          const type = r.chunks[0]?.type || mime || 'audio/webm'
          const blob = new Blob(r.chunks, { type })
          stopStream()
          if (blob.size) transcribe(blob, type)
          else setState('idle')
        }
        recorder.start() // um arquivo inteiro, finalizado no stop
        setState('recording')
      },
      (e: { name?: string }) => {
        stopStream()
        setState('idle')
        toast(
          e?.name === 'NotAllowedError'
            ? 'Permissão de microfone negada. Libere o microfone para o app nas configurações do Android.'
            : `Não consegui acessar o microfone (${e?.name || 'erro'}).`
        )
      }
    )
  }

  const stop = (): void => {
    setState('transcribing')
    const r = rec.current.recorder
    if (r && r.state !== 'inactive') {
      try {
        r.stop()
      } catch {
        /* já parando */
      }
    }
  }

  return {
    available,
    state,
    toggle: () => (state === 'recording' ? stop() : state === 'idle' ? start() : undefined)
  }
}
