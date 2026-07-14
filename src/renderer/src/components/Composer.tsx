import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type RefObject
} from 'react'
import type { FileAttachment, FileRefAttachment, ImageAttachment, MentionHit, PickedElement, SkillInfo } from '@shared/ipc'
import { IconArrowUp, IconAt, IconBox, IconChevronDown, IconClose, IconFile, IconFolder, IconMic, IconPaperclip, IconShieldCheck, IconSpinner, IconStop } from './Icons'
import { fileMeta, fmtSize } from '../files'
import { useUI } from '../ui/UiProvider'
import { frameRms, newVadState, shouldRotatePreroll, vadStep, type VadState } from '../vad'
import { looksLikeFileUrl, looksLikeLocalPath } from '@shared/mime'

/** Max size for a single non-image attachment (keeps the IPC payload sane). */
const MAX_FILE_BYTES = 25 * 1024 * 1024

const MAX_LINES = 8

/** A project the user can reference (its folder path), shown in the @ menu. */
export interface RefProject {
  path: string
  name: string
}

interface Props {
  disabled: boolean
  busy: boolean
  chips: PickedElement[]
  onRemoveChip: (i: number) => void
  onSend: (
    text: string,
    images: ImageAttachment[],
    files: FileAttachment[],
    fileRefs: FileRefAttachment[]
  ) => void
  onInterrupt: () => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  /** Projects from history, offered in the @ reference menu. */
  projects: RefProject[]
  /** Active conversation's project root — searched live by the "@" autocomplete. */
  projectRoot: string | null
  /** Whether an OpenAI key is set (enables the mic dictation). */
  voiceReady: boolean
  /** Called when the user taps the mic without a key set (open Settings). */
  onNeedVoiceKey: () => void
  /** Active conversation id — when it changes, the box loads that chat's draft. */
  convId: string | null
  /** Saved draft text for the active conversation (restored into the box). */
  draft: string
  /** Persist a conversation's draft — called with an explicit convId (blur /
   *  conversation switch / send), NOT on every keystroke (that used to cause a
   *  full app re-render per letter — see `flushDraft` below). */
  onDraftChange: (convId: string, text: string) => void
  /** True when the conversation's project folder no longer exists — blocks typing
   *  (the box becomes read-only and any interaction shows the error). */
  projectMissing: boolean
  /** Error shown when the user tries to use the box while the project is missing. */
  projectMissingMsg: string
}

/** Recording waveform (WhatsApp-style): number of bars in the scrolling strip and
 *  how often (ms) a new amplitude sample is pushed onto it. ~90ms × 48 bars ≈ 4.3s
 *  of history visible, scrolling right→left as you speak. */
const WAVE_BARS = 48
const WAVE_SAMPLE_MS = 90

// Minimal shapes covering only what `stopRecording` needs from MediaRecorder /
// MediaStream — lets the stop-ordering logic be unit-tested with plain fakes,
// no real browser recording APIs required.
interface StoppableRecorder {
  state: string
  stop(): void
  addEventListener(type: 'stop', listener: () => void, options?: { once?: boolean }): void
  removeEventListener(type: 'stop', listener: () => void): void
}
interface StoppableStream {
  getTracks(): { stop(): void }[]
}

/** Stop a MediaRecorder + its underlying mic stream in the SAFE order.
 *
 * `MediaRecorder.stop()` is asynchronous — per spec it queues a task that
 * fires a final `dataavailable` (flushing whatever audio the encoder hasn't
 * emitted yet) and only THEN fires `stop`. Killing the stream's tracks right
 * after calling `.stop()` (synchronously, in the same tick) races that queued
 * flush: the track can die before the encoder grabs the last frames, silently
 * truncating the tail of the recording — this is what was cutting off the
 * last sentence when a user clicked "stop" right after finishing it.
 *
 * The fix: wait for the recorder's own `stop` EVENT (not just calling the
 * method) before stopping the tracks. If the recorder is already inactive (or
 * absent — dictation was "armed"/silent, nothing was recording), there's
 * nothing to flush, so tracks stop immediately.
 */
export function stopRecording(
  rec: StoppableRecorder | null,
  stream: StoppableStream | null,
  onDone: () => void
): void {
  const stopTracks = (): void => {
    stream?.getTracks().forEach((t) => t.stop())
    onDone()
  }
  if (rec && rec.state !== 'inactive') {
    rec.addEventListener('stop', stopTracks, { once: true })
    try {
      rec.stop()
    } catch {
      // Already stopping/stopped — the 'stop' event may never fire; don't
      // leave the caller hanging or the listener dangling.
      rec.removeEventListener('stop', stopTracks)
      stopTracks()
    }
  } else {
    stopTracks()
  }
}

/** MediaRecorder mime type the browser supports for the mic (OpenAI accepts webm/ogg/mp4). */
function pickAudioMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c
  }
  return ''
}

/** Read an image File as a base64 attachment (strips the data-URL prefix). */
function fileToAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const m = /^data:([^;]+);base64,(.*)$/.exec(String(reader.result))
      if (m) resolve({ mediaType: m[1], data: m[2] })
      else reject(new Error('imagem inválida'))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** Read any file as a base64 FileAttachment (keeps name/type/size for the chip). */
function fileToFileAttachment(file: File): Promise<FileAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const m = /^data:([^;]*);base64,(.*)$/.exec(String(reader.result))
      resolve({
        name: file.name || 'arquivo',
        mediaType: m?.[1] || file.type || 'application/octet-stream',
        data: m?.[2] || '',
        size: file.size
      })
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] || p
}

/** lowercase + strip accents (project filter rule), for local skill matching. */
function foldText(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

/** One row in the autocomplete: a project file/folder ('@') or a skill ('/'). */
interface PickerItem {
  /** Inserted right after the trigger: a file path ('@') or a skill name ('/'). */
  id: string
  title: string
  subtitle: string
  kind: '@' | '/'
  isDir?: boolean
}

/**
 * If the caret sits inside a `trigger`-token (`@` or `/`), return where the
 * trigger is and the text typed after it; otherwise null. The trigger only
 * counts at the start of the box or right after whitespace, and the token ends
 * at the first space — so "ler @src/ma" → { start, query: "src/ma" }, "/plan" →
 * { start: 0, query: "plan" }, but "a@b", "x/y" or "@x y|" → null.
 */
function findToken(
  text: string,
  caret: number,
  trigger: '@' | '/'
): { start: number; query: string } | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === trigger) {
      const before = i === 0 ? '' : text[i - 1]
      if (i === 0 || /\s/.test(before)) return { start: i, query: text.slice(i + 1, caret) }
      return null
    }
    if (/\s/.test(ch)) return null
  }
  return null
}

/**
 * Split text for the highlight backdrop: wrap every `@…`/`/…` token (at the
 * start or right after whitespace) in a <mark>, so the mirror layer behind the
 * textarea paints a gray pill under it — confirming a picked file/skill. Only
 * complete tokens (trigger + at least one char) are wrapped.
 */
function highlightNodes(text: string): (string | JSX.Element)[] {
  const nodes: (string | JSX.Element)[] = []
  const re = /(^|\s)([@/]\S+)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const tokenStart = m.index + m[1].length
    if (tokenStart > last) nodes.push(text.slice(last, tokenStart))
    nodes.push(
      <mark className="hl-mention" key={tokenStart}>
        {m[2]}
      </mark>
    )
    last = tokenStart + m[2].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

export function Composer(props: Props): JSX.Element {
  const { notify } = useUI()
  const [value, setValue] = useState(props.draft)
  const [menuOpen, setMenuOpen] = useState(false)
  // The conversation `value` currently belongs to. When the active conversation
  // changes we swap in that chat's saved draft (so switching never loses text).
  const convIdRef = useRef(props.convId)
  // Mirrors `value` for code that needs the LATEST text without re-subscribing
  // effects/listeners on every keystroke (the conversation-switch effect and the
  // window-blur flush below both read this instead of depending on `value`).
  const valueRef = useRef(value)
  valueRef.current = value

  // Local-only edit — just updates the box. Does NOT persist to disk: saving on
  // every keystroke used to force a full app re-render per letter (slow while
  // typing). Persistence happens only via `flushDraft`, at blur/switch/send.
  const updateValue = (next: string): void => {
    setValue(next)
  }

  // Save `text` as `convId`'s draft. Takes an explicit id (not "whatever's
  // active now") so a flush triggered by a conversation switch always targets
  // the OUTGOING conversation, never the one just switched into.
  const flushDraft = (convId: string | null, text: string): void => {
    if (convId) props.onDraftChange(convId, text)
  }

  // Switching conversations → flush the outgoing chat's unsaved text (never
  // lose it just because the switch happened before the field was blurred),
  // then restore the new chat's saved draft into the box.
  useEffect(() => {
    if (convIdRef.current !== props.convId) {
      flushDraft(convIdRef.current, valueRef.current)
      convIdRef.current = props.convId
      setValue(props.draft)
    }
  }, [props.convId, props.draft])

  // Extra safety net: the whole app losing OS focus (e.g. Alt+Tab, closing via
  // Alt+F4) doesn't necessarily blur the textarea first — flush on window blur
  // too, so a typed draft is never lost. Mounted once; always reads the latest
  // conversation/text via refs.
  useEffect(() => {
    const onWindowBlur = (): void => flushDraft(convIdRef.current, valueRef.current)
    window.addEventListener('blur', onWindowBlur)
    return () => window.removeEventListener('blur', onWindowBlur)
  }, [])

  const [images, setImages] = useState<ImageAttachment[]>([])
  const [files, setFiles] = useState<FileAttachment[]>([])
  // Attachments resolved from a pasted local path or URL (never read into
  // memory by this app — main only stat'd/downloaded them). `resolvingCount`
  // tracks in-flight resolutions so the composer can block sending until
  // every pasted line has settled (resolved into a chip, or given up).
  const [fileRefs, setFileRefs] = useState<FileRefAttachment[]>([])
  const [resolvingCount, setResolvingCount] = useState(0)
  const refMenu = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // ---- "@" / "/" autocomplete ----
  // `picker.kind` is '@' (project files, live-searched in main) or '/' (skills,
  // loaded once per project and filtered locally). Selecting inserts `@<path>`
  // or `/<skill>` — the agent resolves either (file by Read/Glob, skill by name).
  const [picker, setPicker] = useState<{ kind: '@' | '/'; start: number; query: string } | null>(null)
  const [pickerItems, setPickerItems] = useState<PickerItem[]>([])
  const [pickerIndex, setPickerIndex] = useState(0)
  const pickerMenu = useRef<HTMLDivElement>(null)
  const pickerReq = useRef(0) // request id, so stale searches don't overwrite newer ones
  const skillsCache = useRef<{ root: string; items: SkillInfo[] } | null>(null)
  const pickerOpen = picker !== null && pickerItems.length > 0
  // Mirror layer behind the textarea that paints the gray pill under @/ tokens.
  const composerHl = useRef<HTMLDivElement>(null)

  // ---- voice dictation (mic → text, OpenAI gpt-4o-transcribe) ----
  // Records one utterance per segment, cut at NATURAL PAUSES by a local VAD (voice
  // activity detection, see ../vad — no external library), then appends each
  // transcript. Two reasons it's segmented rather than one growing recording:
  //   1. A MediaRecorder file is only valid once stopped — sending the still-open
  //      webm makes the API decode it as empty (the "nothing shows up" bug).
  //   2. The VAD closes a segment only when you pause (silence), never mid-word, so
  //      nothing gets cut in half (the old fixed ~4s timer split words).
  // SILENCE IS NEVER SENT, and the word onset is never clipped: a short pre-roll
  // segment is ALWAYS recording (see VAD_PREROLL_MS). Silent rolls are rotated
  // out and their blobs discarded — a quiet stretch of any length never reaches
  // the API (no hallucinated words over silence). When speech starts mid-roll,
  // that roll already holds the instants BEFORE the trigger frame, so the attack
  // of the first word (soft onsets below the threshold) is preserved instead of
  // the old behavior of starting the recorder only at the trigger and eating it.
  const [recording, setRecording] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const mimeRef = useRef<string>('')
  // Text already in the box when dictation started, and the transcript built so far.
  const baseTextRef = useRef('')
  const transcriptRef = useRef('')

  // ---- mic device picker (the caret next to the mic) ----
  const [micMenuOpen, setMicMenuOpen] = useState(false)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  // Selected input device id ('' = system default). Persisted so it sticks.
  const [micId, setMicId] = useState<string>(() => localStorage.getItem('agentcode.micId') ?? '')
  const micWrap = useRef<HTMLDivElement>(null)

  // Current recording segment (one utterance). `vad` carries the speech/silence
  // state the meter loop advances; `vad.hadSpeech` gates whether it's transcribed.
  const segRef = useRef<{ chunks: Blob[]; vad: VadState } | null>(null)

  // ---- live recording waveform (WhatsApp-style scrolling strip) + meter ----
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef<number | null>(null)
  const barsRef = useRef<HTMLSpanElement | null>(null)
  // Scrolling waveform state: the amplitude history (one entry per sample, newest
  // last), the loudest frame since the last sample, when that sample was taken, the
  // elapsed-time label node, and when recording started.
  const levelsRef = useRef<number[]>([])
  const wavePeakRef = useRef(0)
  const waveTickRef = useRef(0)
  const timeRef = useRef<HTMLSpanElement | null>(null)
  const recStartRef = useRef(0)
  // Whether we've already surfaced a transcription error this session (avoid spam).
  const errNotifiedRef = useRef(false)

  // Per-frame loop (no React re-render): reads the raw waveform once and uses its
  // RMS for both the VAD and the scrolling recording waveform.
  const runMeter = (): void => {
    const a = analyserRef.current
    if (!a) {
      rafRef.current = requestAnimationFrame(runMeter)
      return
    }
    const time = new Uint8Array(a.fftSize)
    a.getByteTimeDomainData(time)
    const rms = frameRms(time)
    const now = performance.now()

    // VAD com pré-rolo: um rolo curto está SEMPRE gravando. Enquanto ninguém fala,
    // o rolo é rotacionado (descartado e recomeçado) a cada VAD_PREROLL_MS — o
    // silêncio nunca chega à API. Quando a fala começa, o rolo corrente já contém
    // os milissegundos ANTERIORES ao gatilho, então o ataque da primeira palavra
    // não é mais comido; daí o segmento segue até a pausa natural (vadStep).
    const seg = segRef.current
    const stream = streamRef.current
    if (seg && stream) {
      const { end } = vadStep(seg.vad, rms, now)
      if (end || shouldRotatePreroll(seg.vad, now)) {
        endUtterance() // onstop transcreve se teve fala; descarta se era só silêncio
        startSegment(stream, newVadState(now)) // reabre o próximo rolo na hora
      }
    } else if (stream) {
      startSegment(stream, newVadState(now)) // primeiro rolo, logo que o mic abre
    }

    // Waveform: keep the loudest frame since the last sample, then every
    // WAVE_SAMPLE_MS push it as a new bar so the strip scrolls right→left like
    // WhatsApp. The newest sample sits at the far right; older ones march left.
    wavePeakRef.current = Math.max(wavePeakRef.current, rms)
    if (now - waveTickRef.current >= WAVE_SAMPLE_MS) {
      waveTickRef.current = now
      const levels = levelsRef.current
      levels.push(wavePeakRef.current)
      wavePeakRef.current = 0
      if (levels.length > WAVE_BARS) levels.splice(0, levels.length - WAVE_BARS)
      const bars = barsRef.current
      if (bars) {
        const n = bars.children.length
        const offset = n - levels.length // empty bars on the left until history fills
        for (let i = 0; i < n; i++) {
          const lvl = i >= offset ? levels[i - offset] : 0
          const h = Math.max(0.08, Math.min(1, lvl * 3.2)) // amplify; keep a tiny stub
          ;(bars.children[i] as HTMLElement).style.transform = `scaleY(${h})`
        }
      }
      const label = timeRef.current
      if (label && recStartRef.current) {
        const s = Math.floor((now - recStartRef.current) / 1000)
        label.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
      }
    }
    rafRef.current = requestAnimationFrame(runMeter)
  }

  const startMeter = (stream: MediaStream): void => {
    try {
      const ctx = new AudioContext()
      void ctx.resume().catch(() => {}) // may start suspended; resume so data flows
      const src = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      src.connect(analyser)
      audioCtxRef.current = ctx
      analyserRef.current = analyser
      rafRef.current = requestAnimationFrame(runMeter)
    } catch {
      /* metering is best-effort — recording still works without the ring */
    }
  }

  const stopMeter = (): void => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    analyserRef.current = null
    void audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
  }

  const blobToBase64 = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => {
        // Take everything after "base64," — the mime can carry params (e.g.
        // "audio/webm;codecs=opus"), so a strict ^data:[^;]*;base64, regex fails
        // and would drop the whole payload. Split on the marker instead.
        const s = String(r.result)
        const i = s.indexOf('base64,')
        resolve(i >= 0 ? s.slice(i + 'base64,'.length) : '')
      }
      r.onerror = () => reject(r.error)
      r.readAsDataURL(blob)
    })

  // Transcribe one finalized segment blob and append its text to the box.
  const transcribeBlob = async (blob: Blob, type: string): Promise<void> => {
    try {
      if (blob.size === 0) return
      if (typeof window.api.transcribeAudio !== 'function') {
        if (!errNotifiedRef.current) {
          errNotifiedRef.current = true
          notify('erro', 'Transcrição indisponível. Feche e reabra o app (start.bat) para aplicar a atualização.')
        }
        return
      }
      const b64 = await blobToBase64(blob)
      if (!b64) return
      const r = await window.api.transcribeAudio(b64, type)
      if (r.ok && typeof r.text === 'string') {
        const t = r.text.trim()
        if (t) {
          transcriptRef.current = transcriptRef.current ? `${transcriptRef.current} ${t}` : t
          const base = baseTextRef.current
          updateValue(base ? `${base} ${transcriptRef.current}` : transcriptRef.current)
        }
      } else if (!r.ok && r.error === 'no-key') {
        stopDictation()
        props.onNeedVoiceKey()
      } else if (!r.ok && !errNotifiedRef.current) {
        errNotifiedRef.current = true
        notify('erro', `Transcrição falhou: ${r.error ?? 'erro'}`)
      }
    } catch (err) {
      if (!errNotifiedRef.current) {
        errNotifiedRef.current = true
        notify('erro', `Erro na transcrição: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // Start one recording segment (a pre-roll: it opens BEFORE any speech). If the
  // roll stays silent past VAD_PREROLL_MS it's rotated out and its blob discarded;
  // if speech starts mid-roll, the roll keeps going until the natural pause — so
  // the audio sent always includes the instants right before the first word.
  const startSegment = (stream: MediaStream, vad: VadState): void => {
    const rec = new MediaRecorder(stream, mimeRef.current ? { mimeType: mimeRef.current } : undefined)
    const seg = { chunks: [] as Blob[], vad }
    segRef.current = seg
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) seg.chunks.push(e.data)
    }
    rec.onstop = () => {
      const type = seg.chunks[0]?.type || mimeRef.current || 'audio/webm'
      const blob = new Blob(seg.chunks, { type })
      // Rolos de puro silêncio (rotacionados sem fala) caem aqui e são descartados
      // — silêncio nunca é enviado pra API, então nada de palavras alucinadas.
      if (!seg.vad.hadSpeech || blob.size === 0) return
      void transcribeBlob(blob, type)
    }
    recorderRef.current = rec
    rec.start() // no timeslice — one whole, finalized file when stopped
  }

  // Close the current segment: its onstop transcribes (se teve fala) ou descarta
  // (rolo silencioso). O meter loop reabre o próximo rolo de pré-rolo em seguida.
  const endUtterance = (): void => {
    const rec = recorderRef.current
    recorderRef.current = null
    segRef.current = null // back to armed
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop()
      } catch {
        /* already stopping */
      }
    }
  }

  const stopDictation = (): void => {
    // Stop the meter/VAD first so a pending rAF can't reopen a segment mid-teardown.
    stopMeter()
    const rec = recorderRef.current
    const stream = streamRef.current
    recorderRef.current = null
    segRef.current = null
    streamRef.current = null
    // stopRecording waits for the recorder's real 'stop' event (tail flushed,
    // transcribeBlob already kicked off via its onstop) before killing the mic
    // — see its doc comment for why stopping tracks synchronously here used to
    // clip the last sentence.
    stopRecording(rec, stream, () => {
      setRecording(false)
      props.textareaRef.current?.focus()
    })
  }

  const startDictation = async (): Promise<void> => {
    if (!props.voiceReady) {
      props.onNeedVoiceKey()
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      notify('erro', 'Captura de áudio indisponível neste contexto (precisa rodar em https/localhost).')
      return
    }
    mimeRef.current = pickAudioMime()
    try {
      const constraints: MediaStreamConstraints = {
        audio: micId ? { deviceId: { exact: micId } } : true
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      streamRef.current = stream
      startMeter(stream)
      errNotifiedRef.current = false
      transcriptRef.current = ''
      baseTextRef.current = value.trim()
      // Reset the scrolling waveform + elapsed timer for this recording.
      levelsRef.current = []
      wavePeakRef.current = 0
      waveTickRef.current = 0
      recStartRef.current = performance.now()
      // segRef fica null aqui de propósito: o meter loop abre o primeiro rolo de
      // pré-rolo no primeiro frame (rolos silenciosos são descartados na rotação).
      setRecording(true)
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      let msg = 'Não consegui acessar o microfone.'
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        msg =
          'Permissão de microfone negada. No Windows: Configurações → Privacidade e segurança → Microfone → ative "Acesso ao microfone" e "Permitir que apps da área de trabalho acessem o microfone".'
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        msg = 'Nenhum microfone encontrado. Conecte um microfone e tente de novo.'
      } else if (name === 'NotReadableError') {
        msg = 'O microfone está em uso por outro app. Feche-o e tente de novo.'
      } else if (name === 'OverconstrainedError') {
        // The saved device is gone — fall back to the system default next time.
        setMicId('')
        localStorage.removeItem('agentcode.micId')
        msg = 'O microfone escolhido não está disponível; voltei para o padrão. Tente de novo.'
      } else if (err instanceof Error) {
        msg = `Falha no microfone: ${err.name || err.message}`
      }
      notify('erro', msg)
      stopDictation()
    }
  }

  // Stop recording and free the mic if the composer unmounts mid-dictation.
  useEffect(() => () => stopDictation(), [])

  const toggleMic = (): void => {
    if (recording) stopDictation()
    else void startDictation()
  }

  // Refresh the input-device list (labels need a prior mic permission to show).
  const refreshMics = async (): Promise<void> => {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices()
      setMics(devs.filter((d) => d.kind === 'audioinput'))
    } catch {
      /* enumeration blocked — leave the list empty */
    }
  }

  const openMicMenu = (): void => {
    setMicMenuOpen((o) => !o)
    if (!micMenuOpen) void refreshMics()
  }

  const chooseMic = (id: string): void => {
    setMicId(id)
    localStorage.setItem('agentcode.micId', id)
    setMicMenuOpen(false)
    // If recording, restart on the newly chosen device so it takes effect now.
    if (recording) {
      stopDictation()
      setTimeout(() => void startDictation(), 60)
    }
  }

  // Close the mic menu on outside click / Escape.
  useEffect(() => {
    if (!micMenuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (micWrap.current && !micWrap.current.contains(e.target as Node)) setMicMenuOpen(false)
    }
    const onEsc = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') setMicMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [micMenuOpen])

  // Auto-grow the textarea up to MAX_LINES, then scroll.
  useEffect(() => {
    const ta = props.textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    const cs = getComputedStyle(ta)
    const lh = parseFloat(cs.lineHeight) || 21
    // scrollHeight includes vertical padding (border-box), so the cap must too —
    // otherwise the box scrolls one line before reaching MAX_LINES.
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
    const max = lh * MAX_LINES + padY
    const next = Math.min(ta.scrollHeight, max)
    ta.style.height = `${next}px`
    ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden'
  }, [value, props.textareaRef])

  // Close the @ menu on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (refMenu.current && !refMenu.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onEsc = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [menuOpen])

  // The box is "blocked" (visible but not editable) when the project folder is
  // gone: a conversation is active, so it isn't `disabled`, but typing/sending
  // must be prevented and any interaction shows why.
  const blocked = props.projectMissing && !props.disabled
  const onBlocked = (e?: { preventDefault: () => void }): void => {
    e?.preventDefault()
    notify('erro', props.projectMissingMsg)
    props.textareaRef.current?.blur()
  }

  const submit = (): void => {
    if (props.disabled || blocked) return
    if (resolvingCount > 0) return // still resolving pasted path(s)/URL(s)
    if (
      !value.trim() &&
      props.chips.length === 0 &&
      images.length === 0 &&
      files.length === 0 &&
      fileRefs.length === 0
    )
      return
    props.onSend(value, images, files, fileRefs)
    updateValue('') // clears the box
    // The message was already sent — flush the now-empty draft explicitly so the
    // stale (pre-send) text doesn't reappear if the user comes back to this chat.
    flushDraft(props.convId, '')
    setImages([])
    setFiles([])
    setFileRefs([])
    setPicker(null)
    setPickerItems([])
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // While the picker menu is open, the arrow keys / Enter / Tab / Esc drive it
    // instead of the textarea (Enter must pick an item, not send the message).
    if (pickerOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setPickerIndex((i) => (i + 1) % pickerItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setPickerIndex((i) => (i - 1 + pickerItems.length) % pickerItems.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        choosePicker(pickerItems[pickerIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setPicker(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  // The Composer isn't remounted per conversation (only MessageList is), so a
  // slow resolution (a URL download, or stat'ing/reading a huge local file)
  // must not land its result on whatever conversation happens to be open when
  // it finishes. Callers capture `convIdRef.current` as `pastedConvId` right
  // before starting an async resolution, then run every resulting state
  // update through this guard — a conversation switch mid-resolution silently
  // drops the result instead of attaching it to the wrong chat.
  const applyIfStillActive = (pastedConvId: string | null, fn: () => void): void => {
    if (convIdRef.current === pastedConvId) fn()
  }

  // Same size cap `readFileBytes` enforces in main — checked here BEFORE
  // calling it so a huge image never gets read into memory just to be
  // rejected; it falls back to a plain chip instead of a preview.
  const MAX_IMAGE_PREVIEW_BYTES = 50 * 1024 * 1024

  // Resolve a File that has a real path on disk (via webUtils.getPathForFile)
  // but is too large for the base64/FileReader path (addFiles' `others`/`imgs`
  // size check). Reuses `resolvePastedPath` (stat only, no bytes) — mirrors
  // `resolvePastedLine` below, including the same anti-leak guard.
  const resolveLargeFile = async (file: File, pastedConvId: string | null): Promise<void> => {
    const path = window.api.getPathForFile(file)
    if (!path) {
      applyIfStillActive(pastedConvId, () =>
        notify('erro', `Arquivo maior que 25 MB precisa ter um caminho no disco: ${file.name}`)
      )
      return
    }
    const resolved = await window.api.resolvePastedPath(path)
    if (!resolved.ok) {
      applyIfStillActive(pastedConvId, () => notify('erro', `Arquivo não encontrado: ${resolved.error}`))
      return
    }
    if (resolved.isImage && resolved.size <= MAX_IMAGE_PREVIEW_BYTES) {
      const bytes = await window.api.readFileBytes(resolved.path)
      if (!bytes.ok) {
        applyIfStillActive(pastedConvId, () => notify('erro', `Falha ao ler imagem: ${bytes.error}`))
        return
      }
      applyIfStillActive(pastedConvId, () =>
        setImages((prev) => [...prev, { mediaType: resolved.mediaType, data: bytes.base64 }])
      )
      return
    }
    applyIfStillActive(pastedConvId, () =>
      setFileRefs((prev) => [
        ...prev,
        { name: resolved.name, path: resolved.path, mediaType: resolved.mediaType, size: resolved.size }
      ])
    )
  }

  // Collect attachments (from the picker, paste, or drag-drop). Small files
  // (≤MAX_FILE_BYTES) go through FileReader → base64, same as always. Larger
  // ones are resolved by real disk path instead (resolveLargeFile) — no size
  // cap, since the bytes never cross IPC.
  const addFiles = async (list: FileList | File[]): Promise<void> => {
    const arr = [...list]
    const imgs = arr.filter((f) => f.type.startsWith('image/') && f.size <= MAX_FILE_BYTES)
    const others = arr.filter((f) => !f.type.startsWith('image/') && f.size <= MAX_FILE_BYTES)
    const large = arr.filter((f) => f.size > MAX_FILE_BYTES)
    if (imgs.length) {
      const attached = await Promise.all(imgs.map(fileToAttachment))
      setImages((prev) => [...prev, ...attached])
    }
    if (others.length) {
      const attached = await Promise.all(others.map(fileToFileAttachment))
      setFiles((prev) => [...prev, ...attached])
    }
    if (large.length) {
      const pastedConvId = convIdRef.current
      setResolvingCount((n) => n + large.length)
      await Promise.all(large.map((f) => resolveLargeFile(f, pastedConvId)))
      setResolvingCount((n) => n - large.length)
    }
  }

  // Resolve one pasted line already known to look like a local path or a file
  // URL. Images go through `readFileBytes` (same as a blob paste — real
  // preview + vision block); everything else becomes a `FileRefAttachment`
  // (path only, no bytes ever cross IPC). Failures notify and are reported to
  // the caller so the original line can be put back as plain text.
  const resolvePastedLine = async (line: string, pastedConvId: string | null): Promise<{ ok: boolean; line: string }> => {
    const isUrl = looksLikeFileUrl(line)
    const resolved = isUrl
      ? await window.api.downloadPastedUrl(line, props.convId ?? '')
      : await window.api.resolvePastedPath(line)
    if (!resolved.ok) {
      applyIfStillActive(pastedConvId, () =>
        notify('erro', `${isUrl ? 'Falha ao baixar' : 'Arquivo não encontrado'}: ${resolved.error}`)
      )
      return { ok: false, line }
    }
    if (resolved.isImage) {
      const bytes = await window.api.readFileBytes(resolved.path)
      if (!bytes.ok) {
        applyIfStillActive(pastedConvId, () => notify('erro', `Falha ao ler imagem: ${bytes.error}`))
        return { ok: false, line }
      }
      applyIfStillActive(pastedConvId, () =>
        setImages((prev) => [...prev, { mediaType: resolved.mediaType, data: bytes.base64 }])
      )
    } else {
      applyIfStillActive(pastedConvId, () =>
        setFileRefs((prev) => [
          ...prev,
          { name: resolved.name, path: resolved.path, mediaType: resolved.mediaType, size: resolved.size }
        ])
      )
    }
    return { ok: true, line }
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (blocked) {
      onBlocked(e)
      return
    }
    const pasted = [...e.clipboardData.items]
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null)
    if (pasted.length) {
      e.preventDefault()
      void addFiles(pasted)
      return
    }

    // No real file in the clipboard — check if the pasted TEXT is one or more
    // lines that look like a local path or a file URL. Only intercept the
    // paste (preventDefault) when at least one line qualifies; a normal
    // paragraph paste is untouched.
    const text = e.clipboardData.getData('text/plain')
    const lines = text.split(/\r\n|\r|\n/)
    const candidates = lines.filter((l) => l.trim() && (looksLikeLocalPath(l) || looksLikeFileUrl(l)))
    if (candidates.length === 0) return

    e.preventDefault()
    const remaining = lines.filter((l) => !candidates.includes(l))
    // Insert whatever text ISN'T a recognized path/URL at the caret, same as a
    // normal paste would — the recognized lines are consumed into attachments.
    const ta = props.textareaRef.current
    const leftover = remaining.join('\n')
    if (leftover) {
      const start = ta?.selectionStart ?? value.length
      const end = ta?.selectionEnd ?? value.length
      updateValue(value.slice(0, start) + leftover + value.slice(end))
    }

    const pastedConvId = convIdRef.current
    setResolvingCount((n) => n + candidates.length)
    void Promise.all(candidates.map((line) => resolvePastedLine(line, pastedConvId))).then((results) => {
      setResolvingCount((n) => n - results.length)
      if (convIdRef.current !== pastedConvId) return // switched conversations mid-resolution
      // Lines that failed to resolve go back into the box as plain text so
      // nothing pasted is silently dropped. Reads valueRef (not `value`) since
      // this runs after the paste event closure is long gone.
      const failedLines = results.filter((r) => !r.ok).map((r) => r.line)
      if (failedLines.length) {
        const cur = valueRef.current
        updateValue(`${cur}${cur ? '\n' : ''}${failedLines.join('\n')}`)
      }
    })
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (blocked) {
      onBlocked(e)
      return
    }
    if (e.dataTransfer.files.length) {
      e.preventDefault()
      void addFiles(e.dataTransfer.files)
    }
  }

  // Insert an `@<path>` mention at the caret. The agent resolves it with its
  // native Read/Glob/LS tools — we don't read the file ourselves.
  const insertRef = (path: string): void => {
    const mention = `@${path} `
    const ta = props.textareaRef.current
    if (!ta) {
      updateValue(value + mention)
      return
    }
    const start = ta.selectionStart ?? value.length
    const end = ta.selectionEnd ?? value.length
    const next = value.slice(0, start) + mention + value.slice(end)
    updateValue(next)
    requestAnimationFrame(() => {
      ta.focus()
      const pos = start + mention.length
      ta.setSelectionRange(pos, pos)
    })
  }

  const pickFile = async (): Promise<void> => {
    setMenuOpen(false)
    const p = await window.api.pickFile()
    if (p) insertRef(p)
  }

  const pickFolder = async (): Promise<void> => {
    setMenuOpen(false)
    const p = await window.api.pickDirectory()
    if (p) insertRef(p)
  }

  // Recompute the active @mention from the box's current text + caret position.
  const syncPicker = (text: string, caret: number): void => {
    if (props.disabled || blocked) {
      setPicker(null)
      return
    }
    const token = findToken(text, caret, '@') || findToken(text, caret, '/')
    if (token) {
      // Re-check the character to see what kind it is
      const kind = text[token.start] as '@' | '/'
      setPicker({ kind, ...token })
    } else {
      setPicker(null)
    }
  }

  // Live-search the project whenever the @query (or active project) changes.
  // Debounced, and tagged with a request id so a slow earlier search can't
  // overwrite a newer one's results.
  useEffect(() => {
    if (!picker) {
      setPickerItems([])
      return
    }
    if (picker.kind === '@') {
      if (!props.projectRoot || typeof window.api.mentionSearch !== 'function') {
        setPickerItems([])
        return
      }
      const id = ++pickerReq.current
      const t = setTimeout(() => {
        window.api
          .mentionSearch(props.projectRoot!, picker.query)
          .then((hits) => {
            if (id === pickerReq.current) {
              setPickerItems(hits.map((h) => ({ id: h.path, title: h.name, subtitle: h.path, kind: '@', isDir: h.isDir })))
              setPickerIndex(0)
            }
          })
          .catch(() => {
            if (id === pickerReq.current) setPickerItems([])
          })
      }, 90)
      return () => clearTimeout(t)
    } else {
      if (typeof window.api.listSkills !== 'function') {
        setPickerItems([])
        return
      }
      const id = ++pickerReq.current
      const root = props.projectRoot ?? ''
      const loadSkills = async (): Promise<void> => {
        try {
          if (!skillsCache.current || skillsCache.current.root !== root) {
            skillsCache.current = { root, items: await window.api.listSkills(root) }
          }
          if (id !== pickerReq.current) return
          // Accent- and case-insensitive match on name AND description; skills
          // whose name starts with the query come first (project filter rule).
          const q = foldText(picker.query.trim())
          const matched = skillsCache.current.items
            .filter((s) => !q || foldText(s.name).includes(q) || foldText(s.description).includes(q))
            .sort((a, b) => {
              const as = q && foldText(a.name).startsWith(q) ? 0 : 1
              const bs = q && foldText(b.name).startsWith(q) ? 0 : 1
              return as - bs || a.name.localeCompare(b.name)
            })
            .map((s): PickerItem => ({
              id: s.name,
              title: s.name,
              subtitle: s.description || 'Skill',
              kind: '/'
            }))
          setPickerItems(matched)
          setPickerIndex(0)
        } catch {
          if (id === pickerReq.current) setPickerItems([])
        }
      }
      void loadSkills()
    }
  }, [picker, props.projectRoot])

  // Close the @menu on outside click (item clicks use mousedown+preventDefault,
  // so they fire before this and aren't treated as "outside").
  useEffect(() => {
    if (!picker) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (pickerMenu.current?.contains(t)) return
      if (props.textareaRef.current?.contains(t)) return
      setPicker(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [picker, props.textareaRef])

  // Keep the highlighted item visible as you arrow through a long list.
  useEffect(() => {
    if (!pickerOpen) return
    const el = pickerMenu.current?.children[pickerIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [pickerIndex, pickerOpen])

  // Insert the chosen file/folder as an `@<path>` mention, replacing the token.
  const choosePicker = (hit: PickerItem): void => {
    if (!picker) return
    const end = picker.start + 1 + picker.query.length
    const insert = hit.kind === '@' ? `@${hit.id} ` : `/${hit.id} `
    const next = value.slice(0, picker.start) + insert + value.slice(end)
    updateValue(next)
    setPicker(null)
    setPickerItems([])
    const ta = props.textareaRef.current
    if (ta) {
      requestAnimationFrame(() => {
        ta.focus()
        const pos = picker.start + insert.length
        ta.setSelectionRange(pos, pos)
      })
    }
  }

  return (
    <div className="composer">
      {props.chips.length > 0 && (
        <div className="chips">
          {props.chips.map((c, i) => (
            <span className="chip" key={i} title={`${c.tabName ? c.tabName + ' · ' : ''}${c.selector}`}>
              {c.tabName && <span className="chip-tab">{c.tabName}</span>}
              <span className="chip-tag">{c.tagName}</span>
              {c.id ? `#${c.id}` : c.text.slice(0, 24) || c.selector.slice(0, 24)}
              <button className="chip-x" onClick={() => props.onRemoveChip(i)}>
                <IconClose size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="img-previews">
          {images.map((img, i) => (
            <span className="img-thumb" key={i}>
              <img src={`data:${img.mediaType};base64,${img.data}`} alt="anexo" />
              <button
                className="img-x"
                title="Remover"
                onClick={() => setImages((prev) => prev.filter((_, idx) => idx !== i))}
              >
                <IconClose size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="file-chips">
          {files.map((f, i) => {
            const meta = fileMeta(f.name)
            return (
              <span className="file-chip" key={i} title={`${f.name} · ${fmtSize(f.size)}`}>
                <span className={`file-badge kind-${meta.kind}`}>{meta.ext}</span>
                <span className="file-chip-info">
                  <span className="file-chip-name">{f.name}</span>
                  {f.size > 0 && <span className="file-chip-size">{fmtSize(f.size)}</span>}
                </span>
                <button
                  className="file-x"
                  title="Remover"
                  onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                >
                  <IconClose size={12} />
                </button>
              </span>
            )
          })}
        </div>
      )}
      {fileRefs.length > 0 && (
        <div className="file-chips">
          {fileRefs.map((f, i) => {
            const meta = fileMeta(f.name)
            return (
              <span className="file-chip" key={i} title={`${f.name} · ${fmtSize(f.size)} · ${f.path}`}>
                <span className={`file-badge kind-${meta.kind}`}>{meta.ext}</span>
                <span className="file-chip-info">
                  <span className="file-chip-name">{f.name}</span>
                  {f.size > 0 && <span className="file-chip-size">{fmtSize(f.size)}</span>}
                </span>
                <button
                  className="file-x"
                  title="Remover"
                  onClick={() => setFileRefs((prev) => prev.filter((_, idx) => idx !== i))}
                >
                  <IconClose size={12} />
                </button>
              </span>
            )
          })}
        </div>
      )}
      {resolvingCount > 0 && (
        <div className="file-resolving" role="status" aria-live="polite">
          <IconSpinner className="spinner" size={13} />
          Resolvendo {resolvingCount} arquivo{resolvingCount > 1 ? 's' : ''}…
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files) void addFiles(e.target.files)
          e.target.value = ''
        }}
      />
      {recording && (
        <div className="rec-meter" role="status" aria-live="polite">
          <span className="rec-dot" />
          <span className="rec-time" ref={timeRef}>
            0:00
          </span>
          <span className="rec-wave" ref={barsRef} aria-hidden="true">
            {Array.from({ length: WAVE_BARS }, (_, i) => (
              <i key={i} />
            ))}
          </span>
          <span className="rec-meter-label">clique no microfone para parar e transcrever</span>
        </div>
      )}
      {pickerOpen && (
        <div className="mention-menu" ref={pickerMenu} role="listbox">
          {pickerItems.map((it, i) => (
            <button
              type="button"
              key={it.id}
              className={`mention-item${i === pickerIndex ? ' active' : ''}`}
              role="option"
              aria-selected={i === pickerIndex}
              onMouseEnter={() => setPickerIndex(i)}
              // mousedown (not click) + preventDefault: act before the textarea
              // blurs, so the caret/selection is still intact when we insert.
              onMouseDown={(e) => {
                e.preventDefault()
                choosePicker(it)
              }}
              title={it.subtitle}
            >
              {it.kind === '@' ? (
                it.isDir ? <IconFolder size={15} /> : <IconFile size={15} />
              ) : (
                <IconBox size={15} />
              )}
              <span className="mention-name">{it.title}</span>
              <span className="mention-path">{it.subtitle}</span>
            </button>
          ))}
        </div>
      )}
      <div className="composer-row" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
        <div className="ref-wrap" ref={refMenu}>
          <button
            className={`ref-btn ${menuOpen ? 'active' : ''}`}
            onClick={() => setMenuOpen((o) => !o)}
            disabled={props.disabled || blocked}
            title="Referenciar arquivo, pasta ou projeto"
          >
            <IconAt />
          </button>
          {menuOpen && (
            <div className="ref-menu">
              <button className="ref-item" onClick={pickFile}>
                <span className="ref-row"><IconFile size={15} /> Arquivo…</span>
              </button>
              <button className="ref-item" onClick={pickFolder}>
                <span className="ref-row"><IconFolder size={15} /> Pasta…</span>
              </button>
              {props.projects.length > 0 && (
                <>
                  <div className="ref-sep">Projetos do histórico</div>
                  {props.projects.map((p) => (
                    <button
                      key={p.path}
                      className="ref-item project"
                      onClick={() => {
                        setMenuOpen(false)
                        insertRef(p.path)
                      }}
                      title={p.path}
                    >
                      <span className="ref-row"><IconBox size={15} /> {p.name}</span>
                      <span className="ref-path">{p.path}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
        <button
          className="ref-btn"
          onClick={() => fileInput.current?.click()}
          disabled={props.disabled || blocked}
          title="Anexar arquivo ou imagem (ou cole/arraste no campo)"
        >
          <IconPaperclip />
        </button>
        <div className="mic-wrap" ref={micWrap}>
          <button
            className={`ref-btn mic-btn ${recording ? 'recording' : ''}`}
            onClick={toggleMic}
            disabled={props.disabled || blocked}
            title={recording ? 'Parar e transcrever' : 'Falar (transcreve para texto)'}
          >
            <IconMic />
          </button>
          <button
            className="mic-caret"
            onClick={openMicMenu}
            disabled={props.disabled || blocked}
            title="Escolher microfone"
          >
            <IconChevronDown size={12} />
          </button>
          {micMenuOpen && (
            <div className="mic-menu">
              <div className="mic-menu-label">Microfone</div>
              <button className="mic-item" onClick={() => chooseMic('')}>
                <span className="mic-check">{micId === '' ? '✓' : ''}</span> Padrão do sistema
              </button>
              {mics.map((d, i) => (
                <button key={d.deviceId || i} className="mic-item" onClick={() => chooseMic(d.deviceId)}>
                  <span className="mic-check">{micId === d.deviceId ? '✓' : ''}</span>
                  {d.label || `Microfone ${i + 1}`}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="composer-input-wrap">
          {/* Mirror layer: same metrics as the textarea, paints the gray pills
              behind @/ tokens. The textarea (transparent bg) sits on top. */}
          <div className="composer-highlight" ref={composerHl} aria-hidden="true">
            {highlightNodes(value)}
          </div>
          <textarea
            ref={props.textareaRef}
            className="composer-input"
            placeholder={
              props.disabled
                ? 'Inicie uma sessão primeiro…'
                : blocked
                  ? 'A pasta do projeto não existe mais — não dá para digitar.'
                  : 'Mensagem para o Claude…  (Enter envia, Shift+Enter quebra linha)'
            }
            value={value}
            disabled={props.disabled}
            readOnly={blocked}
            onMouseDown={blocked ? onBlocked : undefined}
            onFocusCapture={blocked ? () => onBlocked() : undefined}
            onChange={(e) => {
              updateValue(e.target.value)
              syncPicker(e.target.value, e.target.selectionStart ?? e.target.value.length)
            }}
            onKeyDown={onKey}
            // "Salvar quando o usuário clica em outra coisa": the mention/skill
            // picker's own items use mousedown+preventDefault specifically to
            // avoid blurring the box while picking, so this only fires on a
            // real "left the composer" — never mid-autocomplete.
            onBlur={() => flushDraft(props.convId, value)}
            onClick={(e) => syncPicker(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
            onKeyUp={(e) => {
              // Re-detect the token when the caret moves (not while the menu is
              // driving the arrows — those are handled in onKeyDown).
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                syncPicker(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)
              }
            }}
            onScroll={(e) => {
              if (composerHl.current) composerHl.current.scrollTop = e.currentTarget.scrollTop
            }}
            onPaste={onPaste}
            rows={1}
          />
        </div>
        {props.busy && (
          <button className="btn stop" onClick={props.onInterrupt} title="Parar tarefa atual">
            <IconStop size={14} />
          </button>
        )}
        <button
          className="ref-btn"
          onClick={() => props.onSend('/code-review', [], [], [])}
          disabled={props.disabled || blocked}
          title="Revisar código (chama a skill code-review)"
        >
          <IconShieldCheck />
        </button>
        <button
          className="btn send"
          onClick={submit}
          disabled={props.disabled || blocked || resolvingCount > 0}
          title={resolvingCount > 0 ? 'Aguardando resolver anexo(s)…' : props.busy ? 'Adicionar à fila' : 'Enviar'}
        >
          <IconArrowUp />
        </button>
      </div>
    </div>
  )
}
