/**
 * O campo de mensagem: anexos (galeria/câmera/arquivo ou colar imagem), ditado,
 * enviar, e — fora da Central — modelo/esforço e modos da conversa. Na Central, a
 * citação do modo resposta fica acima do campo e o envio leva o `replyTo`.
 */
import { useRef, useState } from 'react'
import { client, toast } from '../app/runtime'
import { CENTRAL_CONV_ID } from '../core/client'
import { fmtBytes } from '../core/format'
import { errorText, statusOf } from '../core/net'
import { useStore } from '../core/store'
import type { FileAttachment, ImageAttachment } from '../core/types'
import { Icon } from '../ui/icons'
import { centralNoteSent, centralSendFailed } from '../central/centralActions'
import { centralUi, setCentralReply, takeCentralReply } from '../central/centralStore'
import { fileToAttachment, imageToAttachment, isImage, MAX_ATTACHMENTS } from './attachments'
import { ModelBar } from './ModelBar'
import { useDictation } from './useDictation'

const MAX_INPUT_H = 140

export function Composer(): JSX.Element {
  const convId = useStore(client.store, (s) => s.convId)
  const central = convId === CENTRAL_CONV_ID
  const replyTo = useStore(centralUi, (s) => s.replyTo)
  const [text, setText] = useState('')
  const [images, setImages] = useState<ImageAttachment[]>([])
  const [files, setFiles] = useState<FileAttachment[]>([])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const grow = (): void => {
    const t = inputRef.current
    if (!t) return
    t.style.height = 'auto'
    t.style.height = Math.min(t.scrollHeight, MAX_INPUT_H) + 'px'
  }

  // Ditado: o texto entra depois do que já foi digitado.
  const mic = useDictation((dictated) => {
    const t = dictated.trim()
    if (!t) return
    setText((cur) => (cur.trim() ? cur.trim() + ' ' + t : t))
    requestAnimationFrame(() => {
      grow()
      inputRef.current?.focus()
    })
  })

  const addFiles = (list: File[]): void => {
    const imgs = list.filter(isImage)
    const others = list.filter((f) => !isImage(f))
    if (imgs.length) {
      Promise.all(imgs.map(imageToAttachment)).then(
        (atts) => setImages((cur) => [...cur, ...atts].slice(0, MAX_ATTACHMENTS)),
        () => toast('Imagem inválida.')
      )
    }
    if (others.length) {
      Promise.all(others.map(fileToAttachment)).then(
        (atts) => setFiles((cur) => [...cur, ...atts].slice(0, MAX_ATTACHMENTS)),
        (e: Error) => toast('Anexo ignorado: ' + (e?.message || 'erro'))
      )
    }
  }

  const send = (): void => {
    const body = text.trim()
    if ((!body && !images.length && !files.length) || !convId) return
    const sentImages = images
    const sentFiles = files
    const reply = central ? takeCentralReply() : null
    if (central) centralNoteSent(body, sentImages.length + sentFiles.length)
    setText('')
    setImages([])
    setFiles([])
    requestAnimationFrame(grow)
    client.send({ text: body, images: sentImages, files: sentFiles, replyTo: reply }).catch((err) => {
      if (central) centralSendFailed(body)
      // Não perde o que foi escrito: volta ao campo.
      setText((cur) => (cur ? cur : body))
      setImages((cur) => (cur.length ? cur : sentImages))
      setFiles((cur) => (cur.length ? cur : sentFiles))
      requestAnimationFrame(grow)
      toast(statusOf(err) ? 'Não enviei: ' + errorText(err) : 'Sem conexão — a mensagem não foi enviada.')
    })
  }

  return (
    <footer className="composer">
      {central && replyTo && (
        <div className="c-quote c-replybar" style={{ ['--c' as string]: replyTo.color || 'var(--muted)' }}>
          <div className="c-quote-body">
            {replyTo.who && <span className="c-quote-who">{replyTo.who}</span>}
            <span className="c-quote-text">{replyTo.text}</span>
          </div>
          <button type="button" className="c-quote-x" aria-label="Cancelar resposta" onClick={() => setCentralReply(null)}>
            ×
          </button>
        </div>
      )}
      {(images.length > 0 || files.length > 0) && (
        <div className="preview-tray">
          {images.map((im, i) => (
            <div className="preview-item" key={`i${i}`}>
              <img src={`data:${im.mediaType};base64,${im.data}`} alt="" />
              <button type="button" className="rm" aria-label="Remover" onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          {files.map((f, i) => (
            <div className="preview-item preview-file" key={`f${i}`}>
              <span className="file-chip">📎 {f.name} · {fmtBytes(f.size)}</span>
              <button type="button" className="rm" aria-label="Remover" onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
        </div>
      )}
      {!central && <ModelBar />}
      <div className="composer-row">
        <button type="button" className="icon-btn attach-btn" title="Anexar" aria-label="Anexar" onClick={() => fileRef.current?.click()}>
          <Icon name="image" size={22} />
        </button>
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          placeholder={central ? 'Fale com o agent…' : 'Enviar comando...'}
          onChange={(e) => {
            setText(e.currentTarget.value)
            grow()
          }}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData?.items ?? [])
              .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
              .map((it) => it.getAsFile())
              .filter((f): f is File => !!f)
            if (pasted.length) {
              e.preventDefault()
              addFiles(pasted)
            }
          }}
        />
        {mic.available && (
          <button
            type="button"
            className={`icon-btn mic-btn ${mic.state}`}
            title={mic.state === 'recording' ? 'Parar e transcrever' : mic.state === 'transcribing' ? 'Transcrevendo…' : 'Falar'}
            aria-label="Falar"
            onClick={mic.toggle}
          >
            {mic.state === 'transcribing' ? <span className="spinner" /> : <Icon name="mic" size={22} />}
          </button>
        )}
        <button type="button" className="send-btn" title="Enviar" aria-label="Enviar" onClick={send}>
          <Icon name="send" size={22} strokeWidth={2} />
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.currentTarget.files) addFiles(Array.from(e.currentTarget.files))
          e.currentTarget.value = ''
        }}
      />
    </footer>
  )
}
