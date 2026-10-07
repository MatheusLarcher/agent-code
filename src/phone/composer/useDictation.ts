/**
 * Microfone do composer: grava com o MediaRecorder e transcreve NO APARELHO
 * (Parakeet, voice/localStt.ts) quando o modelo está instalado — só o texto vai ao
 * PC. Sem o modelo (ou se a transcrição local falhar), o áudio vai ao
 * `/api/transcribe` do PC, como plano B. Gravando, expõe o início (cronômetro) e
 * um AnalyserNode do mesmo stream (medidor da barra de gravação); cancelar descarta
 * sem transcrever e solta o microfone.
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

/** Fecha o AudioContext do medidor sem estourar (já fechado, WebView antigo). */
function closeAudio(ctx: AudioContext | null): void {
  if (!ctx) return
  try {
    void Promise.resolve(ctx.close()).catch(() => undefined)
  } catch {
    /* já fechado */
  }
}

/** Medidor de nível: um AnalyserNode no MESMO stream do gravador (não vai para a saída de som). */
function meterFor(ctx: AudioContext | null, stream: MediaStream): AnalyserNode | null {
  if (!ctx) return null
  try {
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    ctx.createMediaStreamSource(stream).connect(analyser)
    void Promise.resolve(ctx.resume?.()).catch(() => undefined)
    return analyser
  } catch {
    return null
  }
}

export interface Dictation {
  available: boolean
  state: MicState
  /** Toque para começar; toque de novo para parar e transcrever. */
  toggle: () => void
  /** Descarta a gravação sem transcrever e solta o microfone. */
  cancel: () => void
  /** Quando a gravação atual começou (Date.now), para o cronômetro; 0 fora dela. */
  startedAt: number
  /** Nível ao vivo do microfone (null sem Web Audio). */
  analyser: AnalyserNode | null
}

interface Rec {
  recorder: MediaRecorder | null
  stream: MediaStream | null
  chunks: Blob[]
  audio: AudioContext | null
}

const NO_METER = { startedAt: 0, analyser: null }

export function useDictation(insert: (text: string) => void): Dictation {
  const voiceReady = useStore(client.store, (s) => s.voiceReady)
  useStore(stt, (s) => `${s.installed}${s.usePc}${s.available}`)
  const [state, setState] = useState<MicState>('idle')
  const [meter, setMeter] = useState<{ startedAt: number; analyser: AnalyserNode | null }>(NO_METER)
  const rec = useRef<Rec>({ recorder: null, stream: null, chunks: [], audio: null })
  const alive = useRef(true)
  const insertRef = useRef(insert)
  insertRef.current = insert

  /** Solta o microfone e o medidor. */
  const release = (): void => {
    const r = rec.current
    r.stream?.getTracks().forEach((t) => t.stop())
    r.stream = null
    r.recorder = null
    closeAudio(r.audio)
    r.audio = null
  }

  /** Para o gravador SEM transcrever (cancelar ou sair da tela) e solta tudo. */
  const discard = (): void => {
    const r = rec.current.recorder
    if (r && r.state !== 'inactive') {
      r.onstop = null
      try {
        r.stop()
      } catch {
        /* já parando */
      }
    }
    release()
  }

  useEffect(() => {
    alive.current = true
    void refreshStt()
    return () => {
      // Saiu da tela gravando: solta o microfone sem transcrever.
      alive.current = false
      discard()
    }
  }, [])

  // O mic aparece quando o PC transcreve ou o modelo do aparelho está instalado.
  const available = voiceReady || sttReady()

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
    // O AudioContext do medidor nasce aqui, ainda dentro do toque (fora dele o WebView o deixa suspenso).
    const AC = window.AudioContext || window.webkitAudioContext
    let audio: AudioContext | null = null
    try {
      audio = AC ? new AC() : null
    } catch {
      audio = null
    }
    rec.current.audio = audio
    navigator.mediaDevices.getUserMedia({ audio: true }).then(
      (stream) => {
        if (!alive.current) {
          // A tela fechou enquanto o Android pedia o microfone: solta já.
          stream.getTracks().forEach((t) => t.stop())
          closeAudio(audio)
          return
        }
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
          release()
          setMeter(NO_METER)
          if (blob.size) transcribe(blob, type)
          else setState('idle')
        }
        recorder.start() // um arquivo inteiro, finalizado no stop
        setMeter({ startedAt: Date.now(), analyser: meterFor(audio, stream) })
        setState('recording')
      },
      (e: { name?: string }) => {
        release()
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

  const cancel = (): void => {
    if (state !== 'recording') return
    discard()
    setMeter(NO_METER)
    setState('idle')
  }

  return {
    available,
    state,
    toggle: () => (state === 'recording' ? stop() : state === 'idle' ? start() : undefined),
    cancel,
    startedAt: meter.startedAt,
    analyser: meter.analyser
  }
}
