import type { SpeechSetupProgress } from '../shared/ipc'

/** Subset of the engine's VoiceProgress (src/main/voice/protocol.ts) read here. */
export interface EngineProgress {
  phase: 'download' | 'load' | 'ready' | 'synthesize' | 'decode' | 'transcribe'
  file?: string
  loaded?: number
  total?: number
}

export type VoiceTask = 'tts' | 'stt'

const TEXT: Record<VoiceTask, { downloading: string; loading: string; done: string; error: string }> = {
  tts: {
    downloading: 'Baixando a voz para leitura (Kokoro)…',
    loading: 'Carregando a voz…',
    done: 'Voz pronta.',
    error: 'Não consegui preparar a voz.'
  },
  stt: {
    downloading: 'Baixando o reconhecimento de voz (Parakeet)…',
    loading: 'Carregando o reconhecimento de voz…',
    done: 'Reconhecimento de voz pronto.',
    error: 'Não consegui preparar o reconhecimento de voz.'
  }
}

export interface SetupReporter {
  /** Feed every engine progress event here. */
  onProgress(p: EngineProgress): void
  /** The call ended; closes the notice if one was opened. */
  finish(error?: unknown): void
}

/**
 * Turns the engine's per-file progress into the single `SpeechSetupProgress`
 * notice the Composer shows. Bytes are summed over
 * every file seen so far, so the bar moves once across the whole download
 * instead of restarting per file. Nothing is sent when the models were already
 * loaded (the normal case after the first use) — the notice exists only for the
 * slow first time. Repeated percentages are dropped to keep IPC quiet.
 */
export function createSetupReporter(task: VoiceTask, send: (p: SpeechSetupProgress) => void): SetupReporter {
  const files = new Map<string, { loaded: number; total: number }>()
  let shown = false
  let finished = false
  let last = ''
  const emit = (p: SpeechSetupProgress): void => {
    const key = `${p.stage}:${p.percent ?? ''}:${p.totalMb ?? ''}`
    if (key === last) return
    last = key
    shown = true
    send(p)
  }
  const text = TEXT[task]
  return {
    onProgress(p) {
      if (finished) return
      if (p.phase === 'download' || p.phase === 'load') {
        if (p.file && typeof p.total === 'number' && p.total > 0) {
          files.set(p.file, { loaded: Math.min(p.loaded ?? 0, p.total), total: p.total })
        }
        let loaded = 0
        let total = 0
        for (const f of files.values()) {
          loaded += f.loaded
          total += f.total
        }
        const percent = total > 0 ? Math.min(100, Math.floor((loaded / total) * 100)) : undefined
        if (p.phase === 'download') {
          emit({
            stage: 'downloading',
            message: text.downloading,
            percent,
            totalMb: total > 0 ? Math.round(total / (1024 * 1024)) : undefined
          })
        } else {
          emit({ stage: 'loading', message: text.loading, percent })
        }
        return
      }
      // The real work started, so every model is in place: close the notice.
      // ('ready' is per model — the sessions still load after it.)
      if (shown && (p.phase === 'synthesize' || p.phase === 'transcribe')) {
        finished = true
        emit({ stage: 'done', message: text.done })
      }
    },
    finish(error) {
      if (finished) return
      finished = true
      if (error !== undefined) {
        if (shown) emit({ stage: 'error', message: text.error })
      } else if (shown) {
        emit({ stage: 'done', message: text.done })
      }
    }
  }
}
