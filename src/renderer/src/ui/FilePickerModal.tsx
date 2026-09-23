import { useEffect, useMemo, useRef, useState } from 'react'
import type { MentionHit } from '@shared/ipc'
import { IconArrowUp, IconFile, IconFolder } from '../components/Icons'

interface Props {
  /** Absolute project root — browsing is scoped to inside this folder. */
  root: string
  /** Called with the chosen file's absolute path. */
  onPick: (absPath: string) => void
  onClose: () => void
}

/** Last path segment (folder name) of an absolute path, for the title. */
function baseName(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
}

/**
 * Project-scoped file picker. Opens when a file preview tab is created manually
 * (no file yet): the user navigates folders or fuzzy-searches to pick a file to
 * preview. Reuses `mentionSearch` (the "@" autocomplete backend), which lists a
 * folder's top level on an empty query and searches recursively otherwise.
 */
export function FilePickerModal({ root, onPick, onClose }: Props): JSX.Element {
  // Browsing position, always kept with forward slashes (Node accepts them on
  // Windows too) so path math is uniform.
  const rootFwd = useMemo(() => root.replace(/\\/g, '/').replace(/\/+$/, ''), [root])
  const [dir, setDir] = useState(rootFwd)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MentionHit[]>([])
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // List the current folder (or search under it), debounced so typing is cheap.
  useEffect(() => {
    let active = true
    setLoading(true)
    const t = setTimeout(() => {
      window.api
        .mentionSearch(dir, query)
        .then((res) => {
          if (active) setHits(res)
        })
        .catch(() => {
          if (active) setHits([])
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    }, 120)
    return () => {
      active = false
      clearTimeout(t)
    }
  }, [dir, query])

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const atRoot = dir === rootFwd
  const relDir = atRoot ? '' : dir.slice(rootFwd.length + 1)

  const goUp = (): void => {
    if (atRoot) return
    const parent = dir.slice(0, dir.lastIndexOf('/'))
    setDir(parent.length >= rootFwd.length ? parent : rootFwd)
    setQuery('')
  }

  const openHit = (h: MentionHit): void => {
    const abs = `${dir}/${h.path}`
    if (h.isDir) {
      setDir(abs)
      setQuery('')
    } else {
      onPick(abs)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card file-picker-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="modal-title">Selecionar arquivo do projeto</h3>
        <div className="fp-path" title={dir}>
          <button className="fp-up" onClick={goUp} disabled={atRoot} title="Pasta acima">
            <IconArrowUp size={14} />
          </button>
          <span className="fp-crumb">
            <IconFolder size={14} /> {baseName(rootFwd)}
            {relDir ? ` / ${relDir}` : ''}
          </span>
        </div>
        <input
          ref={inputRef}
          className="fp-search"
          type="text"
          placeholder="Buscar arquivo nesta pasta…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="fp-list">
          {loading && hits.length === 0 ? (
            <div className="fp-empty">Carregando…</div>
          ) : hits.length === 0 ? (
            <div className="fp-empty">{query ? 'Nenhum arquivo encontrado.' : 'Pasta vazia.'}</div>
          ) : (
            hits.map((h) => (
              <button key={h.path} className="fp-row" onClick={() => openHit(h)}>
                <span className="fp-ico">{h.isDir ? <IconFolder size={15} /> : <IconFile size={15} />}</span>
                <span className="fp-name">{query ? h.path : h.name}</span>
                {h.isDir && <span className="fp-chev">›</span>}
              </button>
            ))
          )}
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  )
}
