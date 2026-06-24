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
import { IconArrowUp, IconAt, IconBox, IconClose, IconFile, IconFolder, IconMic, IconPaperclip, IconStop } from './Icons'
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
  // Records continuously and re-transcribes the audio-so-far every few seconds, so
  // the composer fills in live as you speak (ChatGPT-style). Always transcribing
  // from the start of the utterance keeps the text consistent (it just grows).
  const [recording, setRecording] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const flushTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const inFlight = useRef(false)
  // Text already in the box when dictation started — the transcript is appended to it.
  const baseTextRef = useRef('')

  const blobToBase64 = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => {
        const m = /^data:[^;]*;base64,(.*)$/.exec(String(r.result))
        resolve(m?.[1] ?? '')
      }
      r.onerror = () => reject(r.error)
      r.readAsDataURL(blob)
    })

  // Transcribe everything captured so far and reflect it in the textarea.
  const flushTranscript = async (final: boolean): Promise<void> => {
    if (inFlight.current && !final) return
    if (chunksRef.current.length === 0) return
    inFlight.current = true
    try {
      const type = chunksRef.current[0]?.type || 'audio/webm'
      const blob = new Blob(chunksRef.current, { type })
      const b64 = await blobToBase64(blob)
      if (!b64) return
      const r = await window.api.transcribeAudio(b64, type)
      if (r.ok && typeof r.text === 'string') {
        const t = r.text.trim()
        const base = baseTextRef.current
        setValue(base && t ? `${base} ${t}` : base + t)
      } else if (!r.ok && r.error === 'no-key') {
        stopDictation()
        props.onNeedVoiceKey()
      } else if (!r.ok && final) {
        notify('erro', `Transcrição falhou: ${r.error ?? 'erro'}`)
      }
    } finally {
      inFlight.current = false
    }
  }

  const stopDictation = (): void => {
    if (flushTimer.current) {
      clearInterval(flushTimer.current)
      flushTimer.current = null
    }
    const rec = recorderRef.current
    recorderRef.current = null
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop()
      } catch {
        /* already stopped */
      }
    }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setRecording(false)
  }

  const startDictation = async (): Promise<void> => {
    if (!props.voiceReady) {
      props.onNeedVoiceKey()
      return
    }
    const mime = pickAudioMime()
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      chunksRef.current = []
      baseTextRef.current = value.trim()
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      recorderRef.current = rec
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = () => {
        void flushTranscript(true).then(() => props.textareaRef.current?.focus())
      }
      rec.start(1000) // emit a chunk every second so a partial blob is always available
      setRecording(true)
      // Re-transcribe the growing audio for the live effect.
      flushTimer.current = setInterval(() => void flushTranscript(false), 2500)
    } catch {
      notify('erro', 'Não consegui acessar o microfone. Verifique a permissão.')
      stopDictation()
    }
  }

  // Stop recording and free the mic if the composer unmounts mid-dictation.
  useEffect(() => () => stopDictation(), [])

  const toggleMic = (): void => {
    if (recording) stopDictation()
    else void startDictation()
  }

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
        <button
          className={`ref-btn mic-btn ${recording ? 'recording' : ''}`}
          onClick={toggleMic}
          disabled={props.disabled}
          title={recording ? 'Parar e transcrever' : 'Falar (transcreve para texto)'}
        >
          <IconMic />
        </button>
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
