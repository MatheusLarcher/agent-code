import { useState } from 'react'
import type { Conversation } from '../types'
import { useUI } from '../ui/UiProvider'
import { IconSpinner } from './Icons'

export interface SidebarProject {
  path: string
  name: string
  conversations: Conversation[]
}

interface Props {
  collapsed: boolean
  onToggleCollapse: () => void
  projects: SidebarProject[]
  recents: Conversation[]
  activeId: string | null
  /** Conversations with a turn currently in progress (drives the spinners). */
  busyIds: Set<string>
  onSelect: (id: string) => void
  onNewChat: () => void
  onNewProject: () => void
  /** Start a new conversation inside a specific project folder. */
  onNewChatIn: (path: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  /** Open a search hit, scrolling to the matching message (null → just open). */
  onSelectResult: (convId: string, msgId: string | null) => void
}

/* ---- tiny inline icons (stroke = currentColor) ---- */
const sv = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

const IconPanel = (): JSX.Element => (
  <svg width="17" height="17" viewBox="0 0 24 24" {...sv}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="9" y1="4" x2="9" y2="20" />
  </svg>
)
const IconPlus = (): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...sv}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
)
const IconFolder = (): JSX.Element => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...sv}>
    <path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
)
const IconChat = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...sv}>
    <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z" />
  </svg>
)
const IconChevron = ({ open }: { open: boolean }): JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 24 24" {...sv} className={`caret ${open ? 'open' : ''}`}>
    <polyline points="9 6 15 12 9 18" />
  </svg>
)
/** Two chevrons pointing at each other (recolher) or apart (expandir). */
const IconCollapseAll = ({ expanded }: { expanded: boolean }): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...sv}>
    {expanded ? (
      <>
        <polyline points="6 9 12 4 18 9" />
        <polyline points="6 15 12 20 18 15" />
      </>
    ) : (
      <>
        <polyline points="6 4 12 9 18 4" />
        <polyline points="6 20 12 15 18 20" />
      </>
    )}
  </svg>
)
const IconTrash = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...sv}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
)
/* ---- prompt search helpers ---- */

/** Lowercase + strip accents so "selênio" matches "selenio" (accent-insensitive). */
function fold(s: string): string {
  const n = s.toLowerCase().normalize('NFD')
  let out = ''
  for (let i = 0; i < n.length; i++) {
    const code = n.charCodeAt(i)
    if (code >= 0x300 && code <= 0x36f) continue
    out += n[i]
  }
  return out
}

/** A short, single-line excerpt of `text` centered on the (case-insensitive) hit. */
function makeSnippet(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  const at = i >= 0 ? i : 0
  const start = Math.max(0, at - 28)
  let s = text.slice(start, at + q.length + 60).replace(/\s+/g, ' ').trim()
  if (start > 0) s = '… ' + s
  if (at + q.length + 60 < text.length) s = s + ' …'
  return s
}

interface PromptMatch {
  snippet: string
  /** Id of the matching USER message, or null when the project/title matched. */
  messageId: string | null
  rank: number
  source: 'project' | 'title' | 'prompt'
}

function matchKind(value: string, fq: string): number {
  const fv = fold(value)
  if (fv === fq) return 3
  if (fv.startsWith(fq)) return 2
  if (fv.includes(fq)) return 1
  return 0
}

/** Match project, title, or the first matching USER prompt, with relevance rank. */
function matchPrompt(c: Conversation, projectName: string, q: string, fq: string): PromptMatch | null {
  const projectKind = matchKind(projectName, fq)
  if (projectKind) {
    return { snippet: `Projeto: ${projectName}`, messageId: null, rank: 300 + projectKind, source: 'project' }
  }

  const titleKind = matchKind(c.title, fq)
  if (titleKind) {
    return { snippet: makeSnippet(c.title, q), messageId: null, rank: 200 + titleKind, source: 'title' }
  }

  for (const m of c.messages) {
    if (m.kind === 'user' && typeof m.text === 'string') {
      const promptKind = matchKind(m.text, fq)
      if (promptKind) {
        return { snippet: makeSnippet(m.text, q), messageId: m.id, rank: 100 + promptKind, source: 'prompt' }
      }
    }
  }
  return null
}

interface ConvRowProps {
  c: Conversation
  nested?: boolean
  active: boolean
  busy: boolean
  editing: boolean
  editValue: string
  /** Matching excerpt shown under the title while filtering (prompt hits). */
  snippet?: string
  onSelect: (id: string) => void
  onStartEdit: () => void
  onEditChange: (v: string) => void
  onCommit: () => void
  onCancel: () => void
  onDelete: (c: Conversation) => void
}

/**
 * A single conversation row. Defined at module scope (NOT inside Sidebar) so its
 * component type is stable across renders — otherwise selecting a row would remount
 * its DOM nodes between the two clicks and the browser would never fire `dblclick`.
 */
function ConvRow({
  c,
  nested,
  active,
  busy,
  editing,
  editValue,
  snippet,
  onSelect,
  onStartEdit,
  onEditChange,
  onCommit,
  onCancel,
  onDelete
}: ConvRowProps): JSX.Element {
  return (
    <div
      className={`conv-row ${active ? 'active' : ''} ${nested ? 'nested' : ''}`}
      onClick={() => {
        if (!editing) onSelect(c.id)
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onStartEdit()
      }}
      title={editing ? undefined : `${c.title} — duplo-clique para renomear`}
    >
      <span className="conv-ico">
        {busy ? <IconSpinner className="spinner" /> : <IconChat />}
      </span>
      {editing ? (
        <input
          className="conv-rename"
          value={editValue}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => onEditChange(e.target.value)}
          onBlur={onCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onCommit()
            } else if (e.key === 'Escape') {
              onCancel()
            }
          }}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      ) : snippet ? (
        <div className="search-result-text">
          <span className="conv-title">{c.title}</span>
          <span className="search-snippet">{snippet}</span>
        </div>
      ) : (
        <span className="conv-title">{c.title}</span>
      )}
      <button
        className="conv-del"
        title="Excluir conversa"
        onClick={(e) => {
          e.stopPropagation()
          onDelete(c)
        }}
      >
        <IconTrash />
      </button>
    </div>
  )
}

export function Sidebar(props: Props): JSX.Element {
  const { collapsed, projects, recents, activeId } = props
  const ui = useUI()
  // Project paths the user has manually collapsed (default: everything expanded).
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set())
  // Edit identity is per RENDERED ROW (`editing.key`), not per conversation id —
  // the same conversation is shown twice (under its project and under "Chats"),
  // so keying by id would mount two <input autoFocus> and the focus-steal would
  // blur+commit the first one instantly, closing edit mode before you could type.
  const [editing, setEditing] = useState<{ key: string; id: string } | null>(null)
  const [editValue, setEditValue] = useState('')
  // Free-text search over the user's own prompts across every conversation.
  const [query, setQuery] = useState('')

  const toggleProject = (path: string): void =>
    setCollapsedProjects((prev) => {
      const next = new Set(prev)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })

  const startEdit = (key: string, c: Conversation): void => {
    setEditing({ key, id: c.id })
    setEditValue(c.title)
  }
  const commitEdit = (): void => {
    if (editing) props.onRename(editing.id, editValue)
    setEditing(null)
  }
  const cancelEdit = (): void => setEditing(null)

  const confirmDelete = async (c: Conversation): Promise<void> => {
    const ok = await ui.confirm({
      title: 'Excluir conversa',
      message: `Tem certeza que deseja excluir "${c.title}"? Esta ação não pode ser desfeita.`,
      confirmLabel: 'Excluir',
      cancelLabel: 'Cancelar',
      danger: true
    })
    if (ok) {
      props.onDelete(c.id)
      ui.notify('sucesso', 'Conversa excluída.')
    }
  }

  const renderConv = (c: Conversation, nested: boolean, sectionKey: string, m?: PromptMatch | null): JSX.Element => {
    const rowKey = `${sectionKey}:${c.id}`
    return (
      <ConvRow
        key={rowKey}
        c={c}
        nested={nested}
        active={c.id === activeId}
        busy={props.busyIds.has(c.id)}
        editing={editing?.key === rowKey}
        editValue={editValue}
        snippet={m && m.source === 'prompt' ? m.snippet : undefined}
        onSelect={m ? (id) => props.onSelectResult(id, m.messageId) : props.onSelect}
        onStartEdit={() => startEdit(rowKey, c)}
        onEditChange={setEditValue}
        onCommit={commitEdit}
        onCancel={cancelEdit}
        onDelete={confirmDelete}
      />
    )
  }

  // ---- collapsed rail ----
  if (collapsed) {
    return (
      <aside className="sidebar collapsed">
        <div className="sidebar-head">
          <button className="sidebar-collapse" title="Expandir barra" onClick={props.onToggleCollapse}>
            <IconPanel />
          </button>
        </div>
        <button className="rail-btn accent" title="Nova conversa" onClick={props.onNewChat}>
          <IconPlus />
        </button>
        <div className="rail-projects">
          {projects.map((p) => (
            <button
              key={p.path}
              className={`rail-btn ${p.conversations.some((c) => c.id === activeId) ? 'active' : ''}`}
              title={p.name}
              onClick={() => {
                props.onToggleCollapse()
                if (p.conversations[0]) props.onSelect(p.conversations[0].id)
              }}
            >
              <IconFolder />
            </button>
          ))}
        </div>
      </aside>
    )
  }

  // ---- expanded sidebar ----
  const q = query.trim()
  const fq = fold(q)

  // Searching FILTERS the same project tree (it doesn't rebuild the list as a flat
  // result feed): a project whose name matches keeps all its conversations; the
  // others keep only the conversations that match by title or by one of the user's
  // own prompts (that excerpt is shown under the title).
  interface FilteredConv {
    c: Conversation
    m: PromptMatch | null
  }
  const visibleProjects: Array<{ p: SidebarProject; convs: FilteredConv[] }> = q
    ? projects
        .map((p) => {
          const projectHit = matchKind(p.name, fq) > 0
          const convs: FilteredConv[] = projectHit
            ? p.conversations.map((c) => ({ c, m: { snippet: '', messageId: null, rank: 0, source: 'project' as const } }))
            : p.conversations
                .map((c) => ({ c, m: matchPrompt(c, '', q, fq) }))
                .filter((x): x is FilteredConv => x.m != null)
          return { p, convs }
        })
        .filter((x) => x.convs.length > 0)
    : projects.map((p) => ({ p, convs: p.conversations.map((c) => ({ c, m: null })) }))

  const visibleRecents: FilteredConv[] = q
    ? recents
        .map((c) => ({ c, m: matchPrompt(c, '', q, fq) }))
        .filter((x): x is FilteredConv => x.m != null)
    : recents.map((c) => ({ c, m: null }))

  const allCollapsed = projects.length > 0 && projects.every((p) => collapsedProjects.has(p.path))
  const toggleAllProjects = (): void =>
    setCollapsedProjects(allCollapsed ? new Set() : new Set(projects.map((p) => p.path)))

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <span className="logo">✦</span>
          <span className="brand-text">Agent Code</span>
        </div>
        <button className="sidebar-collapse" title="Minimizar barra" onClick={props.onToggleCollapse}>
          <IconPanel />
        </button>
      </div>

      <div className="side-search">
        <input
          className="side-search-input"
          type="search"
          value={query}
          placeholder="Buscar conversas ou projetos…"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="sidebar-scroll">
        <section className="side-section">
          <div className="side-section-head">
            <span className="side-section-title">Projetos</span>
            {projects.length > 0 && (
              <button
                className="side-add"
                title={allCollapsed ? 'Expandir todos os projetos' : 'Recolher todos os projetos'}
                onClick={toggleAllProjects}
              >
                <IconCollapseAll expanded={!allCollapsed} />
              </button>
            )}
            <button className="side-add" title="Abrir pasta como projeto" onClick={props.onNewProject}>
              <IconPlus />
            </button>
          </div>

          {projects.length === 0 && <div className="side-empty">Nenhum projeto</div>}
          {projects.length > 0 && visibleProjects.length === 0 && (
            <div className="side-empty">Nenhum projeto encontrado.</div>
          )}

          <div className="project-list">
            {visibleProjects.map(({ p, convs }) => {
              // While filtering, matching projects stay open so the hits are visible.
              const open = q ? true : !collapsedProjects.has(p.path)
              const busy = convs.some((x) => props.busyIds.has(x.c.id))
              return (
                <div className={`project-item ${open ? 'open' : ''}`} key={p.path}>
                  <div className={`project-row ${busy ? 'busy' : ''}`}>
                    <button className="project-row-main" onClick={() => toggleProject(p.path)} title={p.path}>
                      <IconChevron open={open} />
                      <span className="project-folder">
                        {busy ? <IconSpinner className="spinner" size={15} /> : <IconFolder />}
                      </span>
                      <span className="project-name">{p.name}</span>
                      <span className="project-count">{convs.length}</span>
                    </button>
                    <button
                      className="project-add"
                      title="Nova conversa neste projeto"
                      onClick={() => props.onNewChatIn(p.path)}
                    >
                      <IconPlus />
                    </button>
                  </div>
                  {open && (
                    <div className="project-convs">
                      {convs.map(({ c, m }) => renderConv(c, true, `proj:${p.path}`, m))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>

        <section className="side-section">
          <div className="side-section-head">
            <span className="side-section-title">Chats</span>
          </div>
          {visibleRecents.length === 0 ? (
            <div className="side-empty">{q ? 'Nenhum chat encontrado.' : 'Nenhum chat'}</div>
          ) : (
            <div className="conv-list">{visibleRecents.map(({ c, m }) => renderConv(c, false, 'chat', m))}</div>
          )}
        </section>
      </div>
    </aside>
  )
}
