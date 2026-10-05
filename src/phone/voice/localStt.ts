/**
 * Ditado no próprio aparelho: Parakeet TDT 0.6B v3 pelo plugin Capacitor local
 * "ParakeetStt" (smartfone-remote/plugins/parakeet-stt). Só o TEXTO vai ao PC.
 * O modelo (~490 MB) não vem no APK: instala pelo card Voz das Configurações, ou
 * sozinho na 1ª gravação (esse 1º áudio ainda vai ao PC enquanto isso). Qualquer
 * falha local cai no `/api/transcribe` do PC, como plano B.
 *
 * Sem @capacitor/core no bundle: fala com a ponte nativa que o Android injeta
 * (window.Capacitor.nativePromise / addListener) — porta do www/localStt.js.
 */
import { createStore } from '../core/store'

const PLUGIN = 'ParakeetStt'
const PREF_PC = 'agentRemote.voice.usePc'
const TARGET_RATE = 16000

export interface SttState {
  available: boolean
  installed: boolean
  installing: boolean
  progress: number
  device: string
  soc: string
  bytes: number
  error: string
  usePc: boolean
}

export const stt = createStore<SttState>({
  available: false, installed: false, installing: false, progress: 0, device: 'cpu', soc: '', bytes: 0, error: '',
  usePc: localStorage.getItem(PREF_PC) === '1'
})

let autoTried = false // uma instalação automática por sessão; as outras são pelo card
let progressSub = false

/** Dentro do app instalado com o plugin compilado. */
export function sttAvailable(): boolean {
  const cap = window.Capacitor
  if (!cap || typeof cap.nativePromise !== 'function') return false
  return (cap.PluginHeaders ?? []).some((h) => h?.name === PLUGIN)
}

function call<T>(method: string, opts: Record<string, unknown> = {}): Promise<T> {
  return window.Capacitor!.nativePromise!(PLUGIN, method, opts) as Promise<T>
}

/** A próxima gravação será transcrita no celular. */
export function sttReady(): boolean {
  const s = stt.get()
  return s.available && !s.usePc && s.installed
}

export function setUsePc(on: boolean): void {
  localStorage.setItem(PREF_PC, on ? '1' : '0')
  stt.set({ usePc: on })
}

export async function refreshStt(): Promise<void> {
  const available = sttAvailable()
  stt.set({ available })
  if (!available) return
  try {
    const s = await call<{ installed?: boolean; installing?: boolean; progress?: number; device?: string; soc?: string; bytes?: number }>('status')
    stt.set({
      installed: !!s.installed, installing: !!s.installing, progress: s.progress || 0,
      device: s.device || 'cpu', soc: s.soc || '', bytes: s.bytes || 0
    })
  } catch {
    /* mantém o que já sabia */
  }
}

export async function installStt(): Promise<boolean> {
  if (!sttAvailable()) throw new Error('Indisponível neste app.')
  if (stt.get().installing) return false
  stt.set({ installing: true, progress: 0, error: '' })
  if (!progressSub && window.Capacitor?.addListener) {
    progressSub = true
    window.Capacitor.addListener(PLUGIN, 'progress', (ev) => {
      stt.set({ progress: (ev as { percent?: number } | null)?.percent || 0 })
    })
  }
  try {
    await call('install')
    stt.set({ installing: false, error: '' })
    await refreshStt()
    return true
  } catch (e) {
    stt.set({ installing: false, error: (e as Error)?.message || 'falha' })
    throw e
  }
}

export function cancelSttInstall(): Promise<unknown> {
  return sttAvailable() ? call('cancel') : Promise.resolve()
}

export async function removeStt(): Promise<void> {
  await call('remove')
  await refreshStt()
}

// ---- áudio: blob do MediaRecorder → Float32 mono 16 kHz → base64 ----------------

async function toPcm16k(blob: Blob): Promise<Float32Array> {
  const buf = await blob.arrayBuffer()
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) throw new Error('Áudio indisponível neste aparelho.')
  const ctx = new AC()
  let decoded: AudioBuffer
  try {
    decoded = await new Promise<AudioBuffer>((resolve, reject) => {
      void ctx.decodeAudioData(buf, resolve, reject)
    })
  } catch (e) {
    throw new Error(`Não consegui decodificar o áudio (${(e as Error)?.message || 'formato'}).`)
  } finally {
    void ctx.close().catch(() => undefined)
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE))
  // OfflineAudioContext com 1 canal mistura e reamostra numa passada só.
  const off = new OfflineAudioContext(1, frames, TARGET_RATE)
  const src = off.createBufferSource()
  src.buffer = decoded
  src.connect(off.destination)
  src.start(0)
  const rendered = await off.startRendering()
  return rendered.getChannelData(0)
}

/** Float32 little-endian (o Android é little-endian) → base64, em fatias para não estourar a pilha. */
export function floatsToBase64(f32: Float32Array): string {
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)))
  }
  return btoa(s)
}

async function transcribeLocal(blob: Blob): Promise<string> {
  const pcm = await toPcm16k(blob)
  const r = await call<{ text?: string }>('transcribe', { pcm: floatsToBase64(pcm) })
  return String(r?.text || '').trim()
}

export interface DictationRoute {
  /** O PC oferece transcrição (plano B). */
  pcReady: boolean
  toPc: () => void
  insert: (text: string) => void
  done: () => void
  fail: (msg: string) => void
}

/**
 * Encaminha uma gravação: no celular quando o modelo está instalado; senão o PC
 * (e, na 1ª vez, começa a instalar o modelo em segundo plano).
 */
export function handleRecording(blob: Blob, ctx: DictationRoute): void {
  const s = stt.get()
  if (!sttAvailable() || s.usePc) return ctx.toPc()
  if (s.installed) {
    transcribeLocal(blob).then(
      (text) => {
        if (text) ctx.insert(text)
        ctx.done()
      },
      (e: Error) => {
        if (ctx.pcReady) ctx.toPc()
        else ctx.fail('Transcrição no celular falhou: ' + (e?.message || 'erro'))
      }
    )
    return
  }
  if (!s.installing && !autoTried) {
    autoTried = true
    installStt().catch(() => undefined) // o card Voz mostra o erro; o PC segue funcionando
  }
  if (ctx.pcReady) return ctx.toPc()
  const now = stt.get()
  ctx.fail(
    now.installing
      ? `Instalando a voz no celular (${now.progress}%). Tente de novo quando terminar.`
      : 'Voz indisponível: instale o modelo em Configurações → Voz.'
  )
}
