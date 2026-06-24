import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type RefObject
} from 'react'
import type { FileAttachment, ImageAttachment, PickedElement } from '@shared/ipc'
import { IconArrowUp, IconAt, IconBox, IconChevronDown, IconClose, IconFile, IconFolder, IconMic, IconPaperclip, IconStop } from './Icons'
import { fileMeta, fmtSize } from '../files'
import { useUI } from '../ui/UiProvider'

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
  onSend: (text: string, images: ImageAttachment[], files: FileAttachment[]) => void
  onInterrupt: () => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  /** Projects from history, offered in the @ reference menu. */
  projects: RefProject[]
  /** Whether an OpenAI key is set (enables the mic dictation). */
  voiceReady: boolean
  /** Called when the user taps the mic without a key set (open Settings). */
  onNeedVoiceKey: () => void
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

export function Composer(props: Props): JSX.Element {
  const { notify } = useUI()
  const [value, setValue] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [images, setImages] = useState<ImageAttachment[]>([])
  const [files, setFiles] = useState<FileAttachment[]>([])
  const refMenu = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // ---- voice dictation (mic → text, OpenAI gpt-4o-mini-transcribe) ----
  // Records in ~4s FINALIZED segments and appends each transcript, filling the box
  // as you speak. Why segments instead of re-transcribing a growing recording: a
  // MediaRecorder file is only valid once stopped — sending the still-open webm
  // makes the API decode it as empty (the "nothing shows up" bug). Each segment is
  // stopped (a complete, decodable file), transcribed, then a new segment starts.
  const [recording, setRecording] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const segTimer = useRef<ReturnType<typeof setInterval> | null>(null)
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

  // ---- live input-level meter (so you can SEE the mic is picking up sound) ----
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef<number | null>(null)
  const barsRef = useRef<HTMLSpanElement | null>(null)
  // Whether we've already surfaced a transcription error this session (avoid spam).
  const errNotifiedRef = useRef(false)

  // Drive the visible VU bars straight from the analyser (no per-frame re-render).
  const runMeter = (): void => {
    const a = analyserRef.current
    const bars = barsRef.current
    if (a && bars) {
      const data = new Uint8Array(a.frequencyBinCount)
      a.getByteFrequencyData(data)
      const n = bars.children.length
      const band = Math.max(1, Math.floor(data.length / n))
      for (let i = 0; i < n; i++) {
        let sum = 0
        for (let j = 0; j < band; j++) sum += data[i * band + j]
        const avg = sum / band / 255 // 0..1
        const h = Math.max(0.12, Math.min(1, avg * 1.8))
        ;(bars.children[i] as HTMLElement).style.transform = `scaleY(${h})`
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
          setValue(base ? `${base} ${transcriptRef.current}` : transcriptRef.current)
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

  // Start one recording segment. Its own chunks finalize into a valid file on stop.
  const startSegment = (stream: MediaStream): void => {
    const rec = new MediaRecorder(stream, mimeRef.current ? { mimeType: mimeRef.current } : undefined)
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data)
    }
    rec.onstop = () => {
      const type = chunks[0]?.type || mimeRef.current || 'audio/webm'
      const blob = new Blob(chunks, { type })
      if (chunks.length === 0 || blob.size === 0) return
      void transcribeBlob(blob, type)
    }
    recorderRef.current = rec
    rec.start() // no timeslice — one whole, finalized file when stopped
  }

  // Close the current segment (→ transcribed via its onstop) and open the next.
  const cycleSegment = (): void => {
    const rec = recorderRef.current
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop()
      } catch {
        /* already stopping */
      }
    }
    if (streamRef.current) startSegment(streamRef.current)
  }

  const stopDictation = (): void => {
    if (segTimer.current) {
      clearInterval(segTimer.current)
      segTimer.current = null
    }
    const rec = recorderRef.current
    recorderRef.current = null
    // Stop the last segment first so its onstop fires and transcribes the tail,
    // THEN tear down the stream/meter (stopping tracks first can drop that data).
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop()
      } catch {
        /* already stopped */
      }
    }
    stopMeter()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setRecording(false)
    props.textareaRef.current?.focus()
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
      startSegment(stream)
      setRecording(true)
      // Every few seconds, finalize the current segment (→ transcribed) and start
      // a new one, so text fills in while you keep talking.
      segTimer.current = setInterval(cycleSegment, 4000)
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
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 21
    const max = lh * MAX_LINES
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

  const submit = (): void => {
    if (props.disabled) return
    if (!value.trim() && props.chips.length === 0 && images.length === 0 && files.length === 0) return
    props.onSend(value, images, files)
    setValue('')
    setImages([])
    setFiles([])
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  // Collect attachments (from the picker, paste, or drag-drop). Images go to the
  // native vision path (base64 image blocks); every other file type becomes a
  // chip and is saved to disk by main so the agent can open it by path.
  const addFiles = async (list: FileList | File[]): Promise<void> => {
    const arr = [...list]
    const imgs = arr.filter((f) => f.type.startsWith('image/'))
    const others = arr.filter((f) => !f.type.startsWith('image/') && f.size <= MAX_FILE_BYTES)
    if (imgs.length) {
      const attached = await Promise.all(imgs.map(fileToAttachment))
      setImages((prev) => [...prev, ...attached])
    }
    if (others.length) {
      const attached = await Promise.all(others.map(fileToFileAttachment))
      setFiles((prev) => [...prev, ...attached])
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const pasted = [...e.clipboardData.items]
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null)
    if (pasted.length) {
      e.preventDefault()
      void addFiles(pasted)
    }
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
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
      setValue((v) => v + mention)
      return
    }
    const start = ta.selectionStart ?? value.length
    const end = ta.selectionEnd ?? value.length
    const next = value.slice(0, start) + mention + value.slice(end)
    setValue(next)
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
          <span className="rec-bars" ref={barsRef}>
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
          <span className="rec-meter-label">Ouvindo… clique no microfone para parar e transcrever</span>
        </div>
      )}
      <div className="composer-row" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
        <div className="ref-wrap" ref={refMenu}>
          <button
            className={`ref-btn ${menuOpen ? 'active' : ''}`}
            onClick={() => setMenuOpen((o) => !o)}
            disabled={props.disabled}
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
          disabled={props.disabled}
          title="Anexar arquivo ou imagem (ou cole/arraste no campo)"
        >
          <IconPaperclip />
        </button>
        <div className="mic-wrap" ref={micWrap}>
          <button
            className={`ref-btn mic-btn ${recording ? 'recording' : ''}`}
            onClick={toggleMic}
            disabled={props.disabled}
            title={recording ? 'Parar e transcrever' : 'Falar (transcreve para texto)'}
          >
            <IconMic />
          </button>
          <button
            className="mic-caret"
            onClick={openMicMenu}
            disabled={props.disabled}
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
        <textarea
          ref={props.textareaRef}
          className="composer-input"
          placeholder={props.disabled ? 'Inicie uma sessão primeiro…' : 'Mensagem para o Claude…  (Enter envia, Shift+Enter quebra linha)'}
          value={value}
          disabled={props.disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          rows={1}
        />
        {props.busy && (
          <button className="btn stop" onClick={props.onInterrupt} title="Parar tarefa atual">
            <IconStop size={14} />
          </button>
        )}
        <button
          className="btn send"
          onClick={submit}
          disabled={props.disabled}
          title={props.busy ? 'Adicionar à fila' : 'Enviar'}
        >
          <IconArrowUp />
        </button>
      </div>
    </div>
  )
}
