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
import { IconArrowUp, IconAt, IconBox, IconClose, IconFile, IconFolder, IconPaperclip, IconStop } from './Icons'
import { fileMeta, fmtSize } from '../files'

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
  const [value, setValue] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [images, setImages] = useState<ImageAttachment[]>([])
  const [files, setFiles] = useState<FileAttachment[]>([])
  const refMenu = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

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
