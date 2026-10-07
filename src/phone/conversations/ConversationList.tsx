/**
 * A aba Conversas (o antigo drawer): as conversas por projeto, como a barra
 * lateral do PC, com busca nos seus prompts (no PC, em todas as conversas), "+"
 * para criar conversa num projeto que o PC conhece, e renomear/excluir. Cada
 * projeto começa recolhido; tocar no cabeçalho abre/fecha.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { client, nav, openConversation, openTab, toast } from '../app/runtime'
import { CENTRAL_CONV_ID } from '../core/client'
import { basename } from '../core/format'
import { errorText } from '../core/net'
import { createStore, useStore } from '../core/store'
import type { ConvSummary, SearchResult } from '../core/types'
import { ReconnectBar } from '../chat/ChatBars'
import { centralSnapshot, tint } from '../central/centralActions'
import { BACK, useBackHandler } from '../shell/backButton'
import { StatusPill } from '../shell/StatusMenu'
import { CollapsibleGroup } from '../ui/Collapsible'
import { Icon } from '../ui/icons'

interface Group {
  cwd: string
  convs: ConvSummary[]
}

function groupByProject(conversations: ConvSummary[], projects: string[]): Group[] {
  const groups = new Map<string, ConvSummary[]>()
  const sorted = conversations.filter((c) => c.id !== CENTRAL_CONV_ID).sort((a, b) => b.updatedAt - a.updatedAt)
  for (const c of sorted) {
    const k = c.cwd || ''
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(c)
  }
  // Projetos que o PC conhece sem conversa carregada ainda ganham o "+".
  for (const p of projects) if (p && !groups.has(p)) groups.set(p, [])
  return [...groups.entries()].map(([cwd, convs]) => ({ cwd, convs }))
}

/**
 * Projetos abertos na lista. Tudo começa recolhido ao abrir o app; durante o uso o
 * que foi aberto continua aberto (a lista desmonta ao entrar numa conversa), só em memória.
 */
export const openProjects = createStore<{ open: Record<string, boolean> }>({ open: {} })

function toggleProject(cwd: string): void {
  openProjects.set((s) => ({ open: { ...s.open, [cwd]: !s.open[cwd] } }))
}

export function ConversationList(): JSX.Element {
  const conversations = useStore(client.store, (s) => s.conversations)
  const projects = useStore(client.store, (s) => s.projects)
  const convId = useStore(client.store, (s) => s.convId)
  const loaded = useStore(client.store, (s) => s.loaded)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  const open = useStore(openProjects, (s) => s.open)
  const groups = useMemo(() => groupByProject(conversations, projects), [conversations, projects])
  const latestQuery = useRef('')
  // Voltar fecha o menu da conversa (e o renomear dentro dele), sem salvar.
  useBackHandler(
    BACK.modal,
    () => {
      setMenu(null)
      setRenaming(null)
    },
    menu !== null
  )

  useEffect(() => {
    const q = query.trim()
    latestQuery.current = q
    if (!q) {
      setResults(null)
      return
    }
    const t = setTimeout(() => {
      client.search(q).then(
        (r) => {
          if (latestQuery.current === q) setResults(r) // resposta velha não sobrescreve
        },
        () => undefined // oscilação de rede: mantém a lista atual
      )
    }, 220)
    return () => clearTimeout(t)
  }, [query])

  const create = (cwd: string): void => {
    client.conversationAction({ type: 'create', cwd }).then(
      (id) => id && openConversation(id),
      (err) => toast(errorText(err))
    )
  }

  const rename = (): void => {
    if (!renaming) return
    const title = renaming.title.trim()
    const id = renaming.id
    setRenaming(null)
    setMenu(null)
    if (title) client.conversationAction({ type: 'rename', convId: id, title }).catch((err) => toast(errorText(err)))
  }

  const remove = (c: ConvSummary): void => {
    setMenu(null)
    if (!window.confirm(`Excluir a conversa "${c.title || 'Conversa'}"? Isso apaga no PC também.`)) return
    client.conversationAction({ type: 'delete', convId: c.id }).catch((err) => toast(errorText(err)))
  }

  const central = conversations.find((c) => c.id === CENTRAL_CONV_ID)
  const empty = loaded && groups.length === 0

  return (
    <div className="tab-view list-view">
      <header className="topbar">
        <div className="topbar-title"><span className="t">Conversas</span></div>
        <StatusPill />
        <button type="button" className="icon-btn" aria-label="Configurações" onClick={() => nav.set({ settingsOpen: true })}>
          <Icon name="gear" size={20} />
        </button>
      </header>
      <ReconnectBar />
      <div className="hist-search">
        <Icon name="search" size={16} className="hist-search-ico" />
        <input type="search" inputMode="search" autoComplete="off" placeholder="Buscar nos meus prompts…" aria-label="Buscar nos meus prompts" value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
      </div>
      <div className="history-list">
        {results ? (
          results.length === 0 ? (
            <div className="hist-empty">Nenhum prompt encontrado para “{query.trim()}”.</div>
          ) : (
            results.map((r) => (
              <button key={r.id} type="button" className={`hist-row hist-result${r.id === convId ? ' active' : ''}`} onClick={() => openConversation(r.id, r.messageId)}>
                <span className="hist-title">{r.title || 'Conversa'}</span>
                {r.snippet && <span className="hist-snippet">{r.snippet}</span>}
              </button>
            ))
          )
        ) : empty ? (
          <div className="empty-state">
            <strong>Nenhuma conversa no PC ainda</strong>
            Crie uma conversa no app do PC primeiro — ela aparece aqui sozinha.
          </div>
        ) : (
          <>
            {central && (
              <button type="button" className="hist-row central-row" onClick={() => openTab('central')}>
                <span className="central-orb" />
                <span className="central-row-text">
                  <span className="hist-title">{central.title || 'Central'}</span>
                  <span className="central-row-sub">fale com o agent</span>
                </span>
                <span className="central-dots">
                  {centralSnapshot(conversations).rail.slice(0, 6).map((card) => (
                    <span key={card.convId} className="central-dot" style={{ ['--c' as string]: tint(card.color) }} />
                  ))}
                </span>
              </button>
            )}
            {groups.map((g) => (
              <CollapsibleGroup
                key={g.cwd}
                title={basename(g.cwd)}
                count={g.convs.length}
                open={!!open[g.cwd]}
                onToggle={() => toggleProject(g.cwd)}
                busy={g.convs.some((c) => c.busy)}
                waiting={g.convs.some((c) => !!c.permission)}
                icon="folder"
                actions={
                  <button type="button" className="hist-plus" title="Nova conversa neste projeto" aria-label="Nova conversa neste projeto" onClick={() => create(g.cwd)}>
                    +
                  </button>
                }
              >
                {g.convs.map((c) => (
                  <div key={c.id}>
                    <div className={`hist-row${c.id === convId ? ' active' : ''}`} role="button" onClick={() => openConversation(c.id)}>
                      <span className="hist-title">{c.title || 'Conversa'}</span>
                      {c.permission && <span className="hist-badge" title="Esperando sua resposta">?</span>}
                      {c.busy && <span className="hist-busy"><Icon name="clock" size={13} /></span>}
                      <button
                        type="button"
                        className="hist-more"
                        aria-label="Opções da conversa"
                        onClick={(e) => {
                          e.stopPropagation()
                          setMenu((m) => (m === c.id ? null : c.id))
                          setRenaming(null)
                        }}
                      >
                        <Icon name="more" size={18} />
                      </button>
                    </div>
                    {menu === c.id && (
                      <div className="hist-menu">
                        {renaming?.id === c.id ? (
                          <form
                            className="hist-rename"
                            onSubmit={(e) => {
                              e.preventDefault()
                              rename()
                            }}
                          >
                            <input autoFocus value={renaming.title} onChange={(e) => setRenaming({ id: c.id, title: e.currentTarget.value })} />
                            <button type="submit">Salvar</button>
                          </form>
                        ) : (
                          <>
                            <button type="button" onClick={() => setRenaming({ id: c.id, title: c.title || '' })}>Renomear</button>
                            <button type="button" className="danger" onClick={() => remove(c)}>Excluir</button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </CollapsibleGroup>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
