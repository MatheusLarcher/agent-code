/**
 * Seção "Anexos" do editor de card: cada anexo com miniatura (imagem) ou
 * ícone, o tipo, Abrir (app padrão do sistema) e Remover (tira do card; o
 * arquivo continua em midia/). "Anexar arquivo…" importa pelo seletor do
 * sistema e põe os nomes novos no card — quem grava é o autosave do editor.
 */
import { useRef, useState, type ChangeEvent } from 'react'
import type { PlanMediaDto } from '@shared/ipc'
import { MAX_ANEXOS_POR_CARD, MEDIA_KIND_LABEL } from '@shared/planningMedia'
import type { DroppedFile } from './mediaDrop'
import { MediaKindIcon, displayName, kindOfAnexo, useMediaThumb } from './mediaView'

export interface CardAttachmentsProps {
  anexos: readonly string[]
  /** As mídias do plano (tipo e tamanho); anexo fora dela está sumido de midia/. */
  media?: readonly PlanMediaDto[]
  onChange: (anexos: string[]) => void
  /** Sem ele, o botão "Anexar arquivo…" não aparece. */
  onImport?: (files: readonly DroppedFile[]) => Promise<PlanMediaDto[] | null>
  onOpen?: (name: string) => void
}

function sizeText(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
}

function AnexoRow({
  name,
  media,
  onOpen,
  onRemove
}: {
  name: string
  media?: readonly PlanMediaDto[]
  onOpen?: (name: string) => void
  onRemove: () => void
}): JSX.Element {
  const kind = kindOfAnexo(name, media)
  const info = media?.find((m) => m.name === name)
  const thumb = useMediaThumb(name, kind === 'imagem' && !!info)
  const shown = displayName(name)
  const missing = !!media && !info
  return (
    <li className="pl-anexo" data-testid={`pl-anexo-${name}`}>
      {kind === 'imagem' && thumb && thumb !== 'loading' ? (
        <img className="pl-media-thumb" src={thumb} alt={shown} draggable={false} />
      ) : (
        <span className={`pl-anexo-icon${thumb === 'loading' ? ' pl-media-thumb loading' : ''}`}>
          <MediaKindIcon kind={kind} size={18} />
        </span>
      )}
      <span className="pl-anexo-info">
        <span className="pl-anexo-name" title={name}>
          {shown}
        </span>
        <span className={`pl-anexo-kind${missing ? ' missing' : ''}`}>
          {missing ? 'Não está mais na pasta midia/' : [MEDIA_KIND_LABEL[kind], sizeText(info?.size)].filter(Boolean).join(' · ')}
        </span>
      </span>
      <span className="pl-anexo-actions">
        {onOpen && !missing && (
          <button type="button" className="btn small ghost" onClick={() => onOpen(name)} title="Abrir no programa padrão do sistema">
            Abrir
          </button>
        )}
        <button type="button" className="btn small ghost" onClick={onRemove} aria-label={`Remover ${shown} do card`} title="Tirar do card (o arquivo fica na pasta midia/)">
          Remover
        </button>
      </span>
    </li>
  )
}

export function CardAttachments({ anexos, media, onChange, onImport, onOpen }: CardAttachmentsProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const full = anexos.length >= MAX_ANEXOS_POR_CARD

  async function onPick(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // escolher o mesmo arquivo de novo também dispara
    if (!files.length || !onImport) return
    setImporting(true)
    try {
      const imported = await onImport(files)
      if (!imported?.length) return
      const next = [...anexos]
      for (const m of imported) if (!next.includes(m.name) && next.length < MAX_ANEXOS_POR_CARD) next.push(m.name)
      onChange(next)
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="pl-field">
      <span className="pl-field-label" id="pl-ed-anexos">
        Anexos{anexos.length ? ` (${anexos.length})` : ''}
      </span>
      {anexos.length > 0 && (
        <ul className="pl-anexos" aria-labelledby="pl-ed-anexos">
          {anexos.map((name) => (
            <AnexoRow
              key={name}
              name={name}
              media={media}
              onOpen={onOpen}
              onRemove={() => onChange(anexos.filter((a) => a !== name))}
            />
          ))}
        </ul>
      )}
      {onImport && (
        <div className="pl-anexos-add">
          <button
            type="button"
            className="btn small"
            disabled={importing || full}
            onClick={() => inputRef.current?.click()}
            title={full ? `Máximo de ${MAX_ANEXOS_POR_CARD} anexos por card` : 'Copiar arquivos para a pasta midia/ do plano e anexar a este card'}
          >
            {importing ? 'Anexando…' : 'Anexar arquivo…'}
          </button>
          <input ref={inputRef} type="file" multiple aria-label="Escolher arquivos para anexar" onChange={(e) => void onPick(e)} />
          {!anexos.length && <span className="pl-field-hint">Ou solte o arquivo em cima do card no canvas.</span>}
        </div>
      )}
    </div>
  )
}
