import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type RefObject
} from 'react'
import type {
  FileAttachment,
  FileRefAttachment,
  ImageAttachment,
  MentionHit,
  PickedElement,
  SkillInfo,
  SpeechSetupProgress
} from '@shared/ipc'
import { IconArrowUp, IconAt, IconBox, IconChevronDown, IconClose, IconFile, IconFolder, IconMic, IconPaperclip, IconShieldCheck, IconSpinner, IconStop } from './Icons'
import { useUI } from '../ui/UiProvider'
import { frameRms, newVadState, shouldRotatePreroll, vadStep, type VadState } from '../vad'
import { encodeWav } from '../wav'
import { useChatDisplay } from './chatDisplay'
import { detectRefTrigger, type RefCard } from '../planning/cardRefs'
import { CardRefSuggestions, useCardRefAutocomplete } from '../planning/CardRefSuggestions'
import { InlineEditor, type EditorElement } from '../inlineMedia/InlineEditor'
import { useInlineAttachments } from '../inlineMedia/useInlineAttachments'
import { offsetFromPoint, TOKEN } from '../inlineMedia/editorModel'
import type { DraftMedia, InlineAtt } from '../inlineMedia/inlineAttachments'

import { boxMetrics, composerBoxHeight } from './composerHeight'
import { useHasTextSignal, type HasTextListener } from './useHasTextSignal'

const NO_CARDS: readonly RefCard[] = []

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
  /** Recebe o campo de texto (o App só usa `focus()`). */
  textareaRef: RefObject<HTMLElement | null>
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
  /** Saved draft text for the active conversation (restored into the box).
   *  Com anexos no texto, leva `{{midia:N}}` e a lista vem em `draftMedia`. */
  draft: string
  draftMedia?: readonly unknown[]
  /** Persist a conversation's draft — called with an explicit convId (blur /
   *  conversation switch / send), NOT on every keystroke (that used to cause a
   *  full app re-render per letter — see `flushDraft` below). `media` só vem
   *  quando o rascunho tem anexo. */
  onDraftChange: (convId: string, text: string, media?: DraftMedia[]) => void
  /** True when the conversation's project folder no longer exists — blocks typing
   *  (the box becomes read-only and any interaction shows the error). */
  projectMissing: boolean
  /** Error shown when the user tries to use the box while the project is missing. */
  projectMissingMsg: string
  /** Avisado só na troca "sem texto" ↔ "com texto" (anexo sozinho não é texto),
   *  inclusive pelo rascunho restaurado ao trocar de conversa. Ver useHasTextSignal. */
  onHasTextChange?: HasTextListener
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
function highlightNodes(text: string, token?: (k: number) => JSX.Element | null): (string | JSX.Element)[] {
  const nodes: (string | JSX.Element)[] = []
  const re = /(^|\s)([@/][^\s￼]+)/g
  let last = 0
  let m: RegExpExecArray | null
  // Anexo no texto (U+FFFC): o espelho põe a MESMA imagem, invisível, para as
  // pílulas seguintes continuarem alinhadas com o campo.
  let k = 0
  const plain = (s: string, key: number): void => {
    s.split(TOKEN).forEach((part, i) => {
      if (i > 0) {
        const t = token?.(k++)
        if (t) nodes.push(<span key={`t${key}-${i}`}>{t}</span>)
      }
      if (part) nodes.push(part)
    })
  }
  while ((m = re.exec(text)) !== null) {
    const tokenStart = m.index + m[1].length
    if (tokenStart > last) plain(text.slice(last, tokenStart), last)
    nodes.push(
      <mark className="hl-mention" key={tokenStart}>
        {m[2]}
      </mark>
    )
    last = tokenStart + m[2].length
  }
  if (last < text.length) plain(text.slice(last), last)
  return nodes
}

export function Composer(props: Props): JSX.Element {
  const { notify } = useUI()
  // The conversation `value` currently belongs to. When the active conversation
  // changes we swap in that chat's saved draft (so switching never loses text).
  const convIdRef = useRef(props.convId)
  // O campo (contenteditable com anexos no meio do texto; ver inlineMedia/).
  // `value` tem 1 caractere TOKEN por anexo; `media.order` diz qual é qual.
  const editorRef = useRef<EditorElement | null>(null)
  const media = useInlineAttachments({
    editorRef,
    convIdRef,
    notify,
    initialDraft: props.draft,
    initialMedia: props.draftMedia
  })
  const [value, setValue] = useState(media.initialValue)
  const [menuOpen, setMenuOpen] = useState(false)
  // Mirrors `value` for code that needs the LATEST text without re-subscribing
  // effects/listeners on every keystroke (the conversation-switch effect and the
  // window-blur flush below both read this instead of depending on `value`).
  const valueRef = useRef(value)
  valueRef.current = value
  useHasTextSignal(value, props.onHasTextChange)

  // Local-only edit — just updates the box. Does NOT persist to disk: saving on
  // every keystroke used to force a full app re-render per letter (slow while
  // typing). Persistence happens only via `flushDraft`, at blur/switch/send.
  const updateValue = (next: string): void => {
    setValue(next)
  }

  // Save `text` as `convId`'s draft. Takes an explicit id (not "whatever's
  // active now") so a flush triggered by a conversation switch always targets
  // the OUTGOING conversation, never the one just switched into.
  // Com anexo no texto, o rascunho leva `{{midia:N}}` + a lista dos anexos.
  // Anexo sem cópia em disco é copiado antes (o rascunho guarda só o caminho):
  // aí a gravação chega depois, e só vale se nenhuma mais nova veio no meio.
  const draftSeq = useRef(new Map<string, number>())
  const flushDraft = (convId: string | null, text: string): void => {
    if (!convId) return
    const seq = (draftSeq.current.get(convId) ?? 0) + 1
    draftSeq.current.set(convId, seq)
    const save = (d: { text: string; media: DraftMedia[] }): void => {
      if (draftSeq.current.get(convId) !== seq) return
      if (d.media.length) props.onDraftChange(convId, d.text, d.media)
      else props.onDraftChange(convId, d.text)
    }
    const d = media.draftOf(text, convId)
    if (d instanceof Promise) void d.then(save)
    else save(d)
  }

  // Switching conversations → flush the outgoing chat's unsaved text (never
  // lose it just because the switch happened before the field was blurred),
  // then restore the new chat's saved draft into the box.
  useEffect(() => {
    if (convIdRef.current !== props.convId) {
      flushDraft(convIdRef.current, valueRef.current)
      convIdRef.current = props.convId
      setValue(media.load(props.convId ?? '', props.draft, props.draftMedia))
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

  // Anexos em resolução (arquivo sendo lido, caminho/URL colado): o envio espera.
  const resolvingCount = media.resolving
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

  // ---- "[[" referência a card (só com cards no contexto: o chat do Agent Manager) ----
  // Mesmo hook/lista do editor de card (CardRefSuggestions): insere [[Título]].
  // Sem cards no contexto, nada disto age — o Composer fica como sempre.
  const chatDisplay = useChatDisplay()
  const cardRefs = chatDisplay.cardRefs ?? NO_CARDS
  const cardAc = useCardRefAutocomplete({ cards: cardRefs, value, onChange: updateValue, inputRef: editorRef })

  // ---- voice dictation (mic → text, OpenAI gpt-4o-transcribe) ----
  // Records one utterance per segment, cut at NATURAL PAUSES by a local VAD (voice
  // activity detection, see ../vad — no external library), then appends each
  // transcript. Two reasons it's segmented rather than one growing recording:
  //   1. Each pause yields a complete file the API can transcribe right away,
  //      so the text streams into the box while you keep talking.
  //   2. The VAD closes a segment only when you pause (silence), never mid-word, so
  //      nothing gets cut in half (the old fixed ~4s timer split words).
  // The audio itself is captured as RAW PCM from the meter's AudioContext and
  // encoded as uncompressed 16-bit WAV (see ../wav) — MediaRecorder is not used
  // (it can only produce lossy webm/opus, which degraded the STT input).
  // SILENCE IS NEVER SENT, and the word onset is never clipped: a short pre-roll
  // segment is ALWAYS recording (see VAD_PREROLL_MS). Silent rolls are rotated
  // out and their blobs discarded — a quiet stretch of any length never reaches
  // the API (no hallucinated words over silence). When speech starts mid-roll,
  // that roll already holds the instants BEFORE the trigger frame, so the attack
  // of the first word (soft onsets below the threshold) is preserved instead of
  // the old behavior of starting the recorder only at the trigger and eating it.
  const [recording, setRecording] = useState(false)
  // Preparação do reconhecimento de voz local (baixar/carregar o modelo). Fica
  // visível até terminar: sem isso o microfone parece travado na primeira vez,
  // que é justamente quando o download de centenas de MB acontece.
  const [speechSetup, setSpeechSetup] = useState<SpeechSetupProgress | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  // Sample rate of the capture AudioContext — needed to build the WAV header.
  const sampleRateRef = useRef(48000)
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
  const segRef = useRef<{ chunks: Float32Array[]; vad: VadState } | null>(null)

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
      // Raw PCM capture for the WAV segments. A ScriptProcessor only fires when
      // connected to the destination, so route it through a zero-gain node —
      // otherwise the mic would play back through the speakers (feedback).
      sampleRateRef.current = ctx.sampleRate
      const proc = ctx.createScriptProcessor(4096, 1, 1)
      proc.onaudioprocess = (e) => {
        const seg = segRef.current
        if (seg) seg.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
      }
      const mute = ctx.createGain()
      mute.gain.value = 0
      src.connect(proc)
      proc.connect(mute)
      mute.connect(ctx.destination)
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
  const startSegment = (_stream: MediaStream, vad: VadState): void => {
    // The ScriptProcessor in startMeter pushes PCM into whichever segment is
    // current — opening a roll is just swapping in a fresh chunk list.
    segRef.current = { chunks: [], vad }
  }

  // Close the current segment: encode as WAV and transcribe (se teve fala) ou
  // descarta (rolo silencioso). O meter loop reabre o próximo rolo em seguida.
  const endUtterance = (): void => {
    const seg = segRef.current
    segRef.current = null // back to armed
    // Rolos de puro silêncio (rotacionados sem fala) são descartados — silêncio
    // nunca é enviado pra API, então nada de palavras alucinadas.
    if (!seg || !seg.vad.hadSpeech || seg.chunks.length === 0) return
    void transcribeBlob(encodeWav(seg.chunks, sampleRateRef.current), 'audio/wav')
  }

  const stopDictation = (): void => {
    // Stop the meter/VAD first so a pending rAF can't reopen a segment mid-teardown.
    // Every PCM frame captured up to this instant is already in segRef (no async
    // encoder flush like MediaRecorder had), so the tail of the last sentence is
    // safe: endUtterance() below encodes and transcribes it synchronously.
    stopMeter()
    endUtterance()
    const stream = streamRef.current
    streamRef.current = null
    stopRecording(null, stream, () => {
      setRecording(false)
      editorRef.current?.focus()
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

  // Acompanha a preparação do reconhecimento de voz no computador. A faixa fica
  // na tela enquanto baixa e sai sozinha ao terminar; erro fica um pouco mais
  // para dar tempo de ler.
  useEffect(() => {
    // `window.api` não existe em teste de componente isolado nem numa build
    // antiga do preload — a faixa é opcional, o ditado não pode quebrar por ela.
    if (typeof window.api?.onSpeechSetupProgress !== 'function') return
    let clear: ReturnType<typeof setTimeout> | undefined
    const off = window.api.onSpeechSetupProgress((p) => {
      clearTimeout(clear)
      setSpeechSetup(p)
      if (p.stage === 'done') clear = setTimeout(() => setSpeechSetup(null), 1600)
      if (p.stage === 'error') clear = setTimeout(() => setSpeechSetup(null), 6000)
    })
    return () => {
      clearTimeout(clear)
      off()
    }
  }, [])

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

  // Auto-grow: 1 line when empty, +1 line per line of text up to MAX_LINES, then scroll.
  // scrollHeight includes vertical padding (border-box); the floor is the CSS min-height.
  const fitHeight = useCallback((): void => {
    const ta = editorRef.current
    if (!ta) return
    ta.style.height = 'auto'
    const box = composerBoxHeight(boxMetrics(getComputedStyle(ta), ta.scrollHeight))
    ta.style.height = `${box.height}px`
    ta.style.overflowY = box.scroll ? 'auto' : 'hidden'
  }, [])
  // `compact` (Agent Manager minimizado) troca o teto da caixa no CSS (3 linhas): refaz também.
  useEffect(() => fitHeight(), [value, media.version, fitHeight, chatDisplay.compact])
  // A largura do campo muda sem o texto mudar (janela redimensionada, coluna abaixo ou
  // acima de 560px, Agent Manager minimizado/maximizado): a quebra automática muda o
  // número de linhas, então a altura é refeita. Só a largura conta — a altura é a
  // que este próprio efeito aplica.
  useEffect(() => {
    const ta = editorRef.current
    if (!ta || typeof ResizeObserver === 'undefined') return
    let lastWidth = -1
    const ro = new ResizeObserver((entries) => {
      const width = entries[entries.length - 1]?.contentRect.width ?? -1
      if (width === lastWidth) return
      lastWidth = width
      fitHeight()
    })
    ro.observe(ta)
    return () => ro.disconnect()
  }, [fitHeight])

  // O App foca o campo por `textareaRef` (atalhos, troca de conversa).
  useEffect(() => {
    const ref = props.textareaRef as { current: HTMLElement | null }
    ref.current = editorRef.current
    return () => {
      if (ref.current === editorRef.current) ref.current = null
    }
  }, [props.textareaRef])

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
    editorRef.current?.blur()
  }

  // A lista do "[[" só aparece com algum card casando (como o menu @//): sem
  // casamento nada abre, e Enter/Esc seguem normais.
  const refsOn = cardRefs.length > 0 && !props.disabled && !blocked
  const refsOpen = refsOn && cardAc.open && cardAc.items.length > 0
  const syncCardRefs = (text: string, caret: number | null): void => {
    if (refsOn) cardAc.sync(text, caret)
  }

  const submit = (): void => {
    if (props.disabled || blocked) return
    if (resolvingCount > 0) return // still resolving pasted path(s)/URL(s)
    // Anexo no texto vira {{midia:N}} no ponto dele; sem anexo, o texto sai igual.
    const msg = media.serialize(value)
    const attached = msg.images.length + msg.files.length + msg.fileRefs.length
    if (!msg.text.trim() && props.chips.length === 0 && attached === 0) return
    props.onSend(msg.text, msg.images, msg.files, msg.fileRefs)
    media.commitSend() // cópias do rascunho: a do arquivo enviado fica; as outras saem do disco
    media.reset()
    updateValue('') // clears the box
    // The message was already sent — flush the now-empty draft explicitly so the
    // stale (pre-send) text doesn't reappear if the user comes back to this chat.
    flushDraft(props.convId, '')
    setPicker(null)
    setPickerItems([])
    cardAc.close(false)
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Enter que confirma a composição do IME (acentos, japonês…) não é envio.
    if (e.nativeEvent.isComposing) return
    // Lista do "[[" aberta: setas, Enter/Tab (escolhe o card, não envia) e Esc são dela.
    if (refsOpen && cardAc.handleKeyDown(e)) return
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

  // Colar: arquivo/imagem vira anexo no cursor; texto entra SEMPRE como texto
  // puro (nada de HTML no campo). Linha que é caminho local ou URL de arquivo
  // vira anexo no lugar dela (ver useInlineAttachments.pasteText). A resolução
  // que termina depois de trocar de conversa é descartada lá dentro.
  const onPaste = (e: ClipboardEvent<HTMLDivElement>): void => {
    if (blocked) {
      onBlocked(e)
      return
    }
    e.preventDefault()
    const pasted = [...e.clipboardData.items]
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null)
    if (pasted.length) {
      void media.addFiles(pasted)
      return
    }
    const text = e.clipboardData.getData('text/plain')
    if (text) media.pasteText(text)
  }

  // Arrastar arquivos: entram no ponto do texto onde foram soltos.
  const dropCaret = (e: DragEvent<HTMLDivElement>): number | null => {
    const el = editorRef.current
    const doc = el?.ownerDocument as (Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }) | undefined
    const r = doc?.caretRangeFromPoint?.(e.clientX, e.clientY)
    return el && r && el.contains(r.startContainer) ? offsetFromPoint(el, r.startContainer, r.startOffset) : null
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (blocked) {
      onBlocked(e)
      return
    }
    if (e.dataTransfer.files.length) {
      e.preventDefault()
      void media.addFiles(e.dataTransfer.files, dropCaret(e))
      return
    }
    // Texto arrastado de fora também entra como texto puro.
    const text = e.dataTransfer.getData('text/plain')
    if (text && e.target instanceof Node && editorRef.current?.contains(e.target)) {
      e.preventDefault()
      editorRef.current.insertParts([text], dropCaret(e))
    }
  }

  // Insert an `@<path>` mention at the caret. The agent resolves it with its
  // native Read/Glob/LS tools — we don't read the file ourselves.
  const insertRef = (path: string): void => {
    const mention = `@${path} `
    const ta = editorRef.current
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
    // Dentro de um "[[" aberto quem sugere é a lista de cards, não o menu @//.
    if (props.disabled || blocked || (refsOn && detectRefTrigger(text, caret))) {
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
      if (editorRef.current?.contains(t)) return
      setPicker(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [picker])

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
    const ta = editorRef.current
    if (ta) {
      requestAnimationFrame(() => {
        ta.focus()
        const pos = picker.start + insert.length
        ta.setSelectionRange(pos, pos)
      })
    }
  }

  const placeholder = props.disabled
    ? 'Inicie uma sessão primeiro…'
    : blocked
      ? 'A pasta do projeto não existe mais — não dá para digitar.'
      : 'Mensagem para o Claude…  (Enter envia, Shift+Enter quebra linha)'

  // O k-ésimo anexo do texto, no espelho: invisível, só ocupa o lugar. A miniatura
  // tem tamanho fixo no CSS, então vai sem `src` (não repete a data: URL da foto);
  // o chip leva o SVG pequeno, que dá a largura do nome.
  const mirrorToken = (k: number): JSX.Element | null => {
    const att: InlineAtt | undefined = media.atts.get(media.order[k] ?? '')
    if (!att) return null
    return <img className={`inline-att inline-att-${att.kind}`} src={att.kind === 'image' ? undefined : att.src} alt="" />
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
          if (e.target.files) void media.addFiles(e.target.files)
          e.target.value = ''
        }}
      />
      {speechSetup && (
        <div className={`speech-setup ${speechSetup.stage}`} role="status" aria-live="polite">
          <span className="speech-setup-icon" aria-hidden="true">
            {speechSetup.stage === 'done' ? '✓' : speechSetup.stage === 'error' ? '!' : <IconSpinner className="spinner" size={14} />}
          </span>
          <div className="speech-setup-body">
            <span className="speech-setup-msg">
              {speechSetup.message}
              {speechSetup.stage === 'downloading' && speechSetup.totalMb
                ? ` (~${speechSetup.totalMb} MB)`
                : ''}
            </span>
            {speechSetup.stage !== 'done' && speechSetup.stage !== 'error' && (
              <span className="speech-setup-bar">
                <i
                  className={speechSetup.percent == null ? 'indeterminate' : ''}
                  style={speechSetup.percent == null ? undefined : { width: `${speechSetup.percent}%` }}
                />
              </span>
            )}
          </div>
          {speechSetup.stage === 'downloading' && speechSetup.percent != null && (
            <span className="speech-setup-pct">{speechSetup.percent}%</span>
          )}
        </div>
      )}
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
      {refsOpen && (
        <CardRefSuggestions
          className="composer-card-refs"
          id={cardAc.listId}
          items={cardAc.items}
          active={cardAc.active}
          onPick={cardAc.pick}
          onActiveChange={cardAc.setActive}
        />
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
          {/* Mirror layer: same metrics as the box, paints the gray pills
              behind @/ tokens (and the placeholder). The box (transparent bg) sits on top. */}
          <div className="composer-highlight" ref={composerHl} aria-hidden="true">
            {value ? highlightNodes(value, mirrorToken) : <span className="composer-placeholder">{placeholder}</span>}
          </div>
          <InlineEditor
            editorRef={editorRef}
            className="composer-input"
            {...{ placeholder }}
            aria-placeholder={placeholder}
            aria-label="Mensagem"
            aria-disabled={props.disabled || undefined}
            aria-readonly={blocked || undefined}
            value={value}
            order={media.order}
            atts={media.atts}
            editable={!props.disabled && !blocked}
            {...(refsOn ? cardAc.inputAria : undefined)}
            onMouseDown={blocked ? onBlocked : undefined}
            onFocusCapture={blocked ? () => onBlocked() : undefined}
            onEdit={(text, order, caret) => {
              updateValue(text)
              media.setOrder(order)
              syncPicker(text, caret)
              syncCardRefs(text, caret)
            }}
            // O cursor andou (clique, setas): o "[[" em volta dele decide a lista de cards.
            onCaret={(text, caret) => syncCardRefs(text, caret)}
            onKeyDown={onKey}
            // "Salvar quando o usuário clica em outra coisa": the mention/skill
            // picker's own items use mousedown+preventDefault specifically to
            // avoid blurring the box while picking, so this only fires on a
            // real "left the composer" — never mid-autocomplete (the "[[" card
            // list does the same; leaving the box just hides it).
            onBlur={() => {
              flushDraft(props.convId, value)
              cardAc.close(false)
            }}
            onClick={() => syncPicker(value, editorRef.current?.selectionStart ?? 0)}
            onKeyUp={(e) => {
              // Re-detect the token when the caret moves (not while the menu is
              // driving the arrows — those are handled in onKeyDown).
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                syncPicker(value, editorRef.current?.selectionStart ?? 0)
              }
            }}
            onScroll={(e) => {
              if (composerHl.current) composerHl.current.scrollTop = e.currentTarget.scrollTop
            }}
            onPaste={onPaste}
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
