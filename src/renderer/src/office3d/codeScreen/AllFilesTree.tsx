/**
 * "Todos os arquivos" do Explorador: a árvore do projeto (cwd da conversa),
 * lida do disco UMA pasta por vez (window.api.projectDir) ao expandir. As pastas
 * abertas ficam no dono (CodeView), então sobrevivem a alternar o modo; as
 * listagens ficam aqui. O arquivo que o Agent alterou ou leu leva o marcador de
 * sempre (U/M/lido); clicar em qualquer arquivo o abre no editor (onBrowse).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectDirListing } from '@shared/ipc'
import { FileGlyph, Icon } from './icons'
import { madeBy, ModelTags } from './modelTags'
import { Marker, named, type TabItem } from './parts'
import { normalizePath, slashed } from './pathGuard'

type DirState = { kind: 'loading' } | { kind: 'ok'; listing: ProjectDirListing } | { kind: 'error'; message: string }

export interface AllFilesTreeProps {
  cwd: string
  /** Os arquivos que o Agent alterou e leu (o marcador na árvore). */
  known: readonly TabItem[]
  active: string | null
  mixed: boolean
  /** Pastas abertas (caminho relativo, com '/'). */
  expanded: ReadonlySet<string>
  onToggleDir: (rel: string) => void
  onBrowse: (path: string) => void
}

/** Há como listar as pastas do projeto (o app do PC); no celular não: "Todos os arquivos" some. */
export function canListProject(): boolean {
  return typeof window !== 'undefined' && typeof window.api?.projectDir === 'function'
}

/** O caminho absoluto de um relativo do projeto, na barra do próprio cwd. */
export function absoluteOf(cwd: string, rel: string): string {
  const sep = cwd.includes('\\') ? '\\' : '/'
  const base = cwd.endsWith(sep) ? cwd.slice(0, -1) : cwd
  return `${base}${sep}${rel.split('/').join(sep)}`
}

/** Indentação por nível, no passo do Explorador. */
const pad = (depth: number): { paddingLeft: number } => ({ paddingLeft: 8 + depth * 12 })

export function AllFilesTree({ cwd, known, active, mixed, expanded, onToggleDir, onBrowse }: AllFilesTreeProps): JSX.Element {
  const [dirs, setDirs] = useState<ReadonlyMap<string, DirState>>(new Map())
  const asked = useRef(new Set<string>())
  const byKey = useMemo(() => new Map(known.map((t) => [t.key, t])), [known])

  // A raiz e cada pasta aberta ainda não pedida: uma chamada por pasta.
  const wanted = ['', ...expanded].filter((rel) => !asked.current.has(rel))
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!cwd) return
    const api = typeof window !== 'undefined' ? window.api : undefined
    for (const rel of wanted) {
      asked.current.add(rel)
      // Uma resposta só se perde se a árvore saiu da tela (abrir outra pasta não cancela as em voo).
      const set = (s: DirState): void => {
        if (mounted.current) setDirs((m) => new Map(m).set(rel, s))
      }
      set({ kind: 'loading' })
      if (typeof api?.projectDir !== 'function') {
        set({ kind: 'error', message: 'Não deu para listar os arquivos aqui.' })
        continue
      }
      api
        .projectDir(cwd, rel)
        .then((listing) => set(listing.error ? { kind: 'error', message: listing.error } : { kind: 'ok', listing }))
        .catch(() => set({ kind: 'error', message: 'Não deu para ler a pasta.' }))
    }
    // `wanted` é derivado de `expanded`; a chave diz tudo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, wanted.join('\n')])

  if (!cwd) return <p className="cm-side-empty">Conversa sem pasta de projeto: não há arquivos para listar.</p>

  const list = (rel: string, depth: number): JSX.Element => {
    const st = dirs.get(rel)
    if (!st || st.kind === 'loading') return <p className="cm-side-empty cm-tree-note" style={pad(depth + 1)}>Lendo a pasta…</p>
    if (st.kind === 'error') return <p className="cm-side-empty cm-tree-note" role="alert" style={pad(depth + 1)}>{st.message}</p>
    const { entries, truncated } = st.listing
    if (entries.length === 0) return <p className="cm-side-empty cm-tree-note" style={pad(depth + 1)}>Pasta vazia.</p>
    return (
      <ul className="cm-tree" aria-label={depth === 0 ? 'Todos os arquivos do projeto' : undefined}>
        {entries.map((e) => {
          if (e.isDir) {
            const open = expanded.has(e.path)
            return (
              <li key={e.path}>
                <button type="button" className="cm-folder cm-tree-dir" style={pad(depth)} aria-expanded={open} title={e.path} onClick={() => onToggleDir(e.path)}>
                  <Icon name="chevron" className={open ? 'cm-open' : 'cm-closed'} />
                  <Icon name="folder" />
                  <span>{e.name}</span>
                </button>
                {open && list(e.path, depth + 1)}
              </li>
            )
          }
          const path = absoluteOf(cwd, e.path)
          const key = normalizePath(path)
          const t: TabItem = byKey.get(key) ?? { key, path, name: e.name, status: null, typing: false }
          return (
            <li key={e.path}>
              <button
                type="button"
                className={`cm-file${key === active ? ' active' : ''}${t.preview ? ' read' : ''}`}
                style={pad(depth + 1)}
                aria-current={key === active ? 'true' : undefined}
                aria-label={named(t)}
                title={`${slashed(path)}${t.range ? ` · linhas ${t.range}` : ''}${madeBy(t.models)}`}
                data-path={path}
                onClick={() => onBrowse(path)}
              >
                <FileGlyph path={path} />
                <span className="cm-file-name">{e.name}</span>
                {t.range && <span className="cm-file-range">{t.range}</span>}
                <ModelTags models={t.models} mixed={mixed} />
                <Marker t={t} />
              </button>
            </li>
          )
        })}
        {truncated && (
          <li className="cm-side-empty cm-tree-note" style={pad(depth + 1)}>
            Pasta com mais arquivos do que dá para listar aqui.
          </li>
        )}
      </ul>
    )
  }

  return list('', 0)
}
