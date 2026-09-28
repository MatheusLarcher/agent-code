import { Fragment, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { splitMediaText } from '@shared/inlineMedia'
import { fileMeta, fmtSize } from '../files'
import type { BubbleMedia } from './inlineAttachments'

/**
 * Texto da bolha do usuário com os anexos NO LUGAR onde foram postos: cada
 * `{{midia:N}}` vira a miniatura (pequena, amplia no hover/foco) ou o chip do
 * arquivo. Imagem que não voltou do banco (as miniaturas não são gravadas)
 * aparece como chip com o nome, na mesma posição.
 */
export function InlineMediaText({
  text,
  media,
  images,
  files,
  renderText
}: {
  text: string
  media: readonly BubbleMedia[]
  images?: readonly string[]
  files?: readonly { name: string; size: number }[]
  renderText: (text: string) => ReactNode
}): JSX.Element {
  return (
    <>
      {splitMediaText(text).map((part, k) =>
        'text' in part ? (
          <Fragment key={k}>{renderText(part.text)}</Fragment>
        ) : (
          <MediaItem key={k} n={part.media} entry={media[part.media - 1]} images={images} files={files} />
        )
      )}
    </>
  )
}

function MediaItem({
  n,
  entry,
  images,
  files
}: {
  n: number
  entry: BubbleMedia | undefined
  images?: readonly string[]
  files?: readonly { name: string; size: number }[]
}): JSX.Element {
  const [rect, setRect] = useState<DOMRect | null>(null)
  if (entry?.t === 'i') {
    const src = images?.[entry.i]
    if (!src) return <Chip ext="IMG" kind="file" label={entry.name} title={`midia:${n} = ${entry.name}`} />
    return (
      <>
        <img
          className="inline-att inline-att-image msg-inline-img"
          src={src}
          alt={`midia:${n} = ${entry.name}`}
          tabIndex={0}
          onMouseEnter={(e) => setRect(e.currentTarget.getBoundingClientRect())}
          onMouseLeave={() => setRect(null)}
          onFocus={(e) => setRect(e.currentTarget.getBoundingClientRect())}
          onBlur={() => setRect(null)}
        />
        {rect &&
          createPortal(
            <div
              className="inline-att-preview"
              role="tooltip"
              style={{
                left: Math.max(8, Math.min(rect.left, window.innerWidth - 280)),
                bottom: Math.max(8, window.innerHeight - rect.top + 8)
              }}
            >
              <img src={src} alt="" />
              <div className="inline-att-preview-cap">
                <b>midia:{n}</b> {entry.name}
              </div>
            </div>,
            document.body
          )}
      </>
    )
  }
  const f = entry?.t === 'f' ? files?.[entry.i] : undefined
  if (!f) return <>{`[mídia ${n}]`}</>
  const meta = fileMeta(f.name)
  return (
    <Chip
      ext={meta.ext}
      kind={meta.kind}
      label={f.name}
      title={`midia:${n} = ${f.name}${f.size ? ` · ${fmtSize(f.size)}` : ''}`}
    />
  )
}

function Chip({ ext, kind, label, title }: { ext: string; kind: string; label: string; title: string }): JSX.Element {
  return (
    <span className="msg-inline-chip" title={title} aria-label={title} tabIndex={0}>
      <span className={`file-badge kind-${kind}`}>{ext}</span>
      <span className="msg-inline-chip-name">{label}</span>
    </span>
  )
}
