/**
 * A aba Quadro: o quadro do projeto escolhido (padrão: o da conversa mais
 * recente) com as colunas em segmentos (A fazer · Fazendo · Concluído) e a lista
 * da coluna ativa. O toque no cartão abre a folha (detalhe, mover, arquivar); o
 * "Scrum Master" no topo abre o diário do SM em tela cheia. O voltar do Android
 * fecha primeiro o que estiver por cima.
 */
import { useEffect, useMemo, useState } from 'react'
import { boardItemStatus, boardItemTitle, type BoardItem } from '@shared/ipc'
import { COLUMNS, fmtAgo } from '@renderer/components/BoardCardDetail'
import { client, nav, openConversation } from '../app/runtime'
import { CENTRAL_CONV_ID } from '../core/client'
import { basename } from '../core/format'
import { createStore, useStore } from '../core/store'
import type { ConvSummary } from '../core/types'
import { ReconnectBar } from '../chat/ChatBars'
import { BACK, useBackHandler } from '../shell/backButton'
import { StatusPill } from '../shell/StatusMenu'
import { Icon } from '../ui/icons'
import { BoardSheet } from './BoardSheet'
import { PhoneScrum } from './PhoneScrum'
import { useBoard } from './useBoard'
import '../styles/planning.css'
import '../styles/board.css'

type ColumnKey = (typeof COLUMNS)[number]['status']

/** A escolha da aba (sobrevive à troca de aba; não vai para o aparelho). */
export const boardUi = createStore<{ cwd: string | null; column: ColumnKey; dismissed: boolean }>({ cwd: null, column: 'pending', dismissed: false })

/** Os projetos do PC mais os das conversas; o padrão é o da conversa mais recente. */
export function boardProjects(projects: string[], conversations: ConvSummary[]): { list: string[]; recent: string | null } {
  const convs = conversations.filter((c) => c.id !== CENTRAL_CONV_ID && !!c.cwd)
  const recent = convs.reduce<ConvSummary | null>((a, c) => (!a || c.updatedAt > a.updatedAt ? c : a), null)?.cwd ?? null
  const list = [...new Set([...projects, ...convs.map((c) => c.cwd)].filter(Boolean))]
  return { list, recent: recent ?? list[0] ?? null }
}

/** Até onde o quadro do celular olha para trás: cartão parado há mais tempo some. */
export const BOARD_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

const cardTime = (it: BoardItem): number => {
  const t = Date.parse(it.updatedAt || it.createdAt)
  return Number.isFinite(t) ? t : 0
}

/** Os cartões mexidos nos últimos 14 dias, do mais novo ao mais antigo. */
export function recentBoardItems(items: BoardItem[], now: number): BoardItem[] {
  return items.filter((it) => now - cardTime(it) <= BOARD_MAX_AGE_MS).sort((a, b) => cardTime(b) - cardTime(a))
}

function Topbar({ onScrum }: { onScrum: () => void }): JSX.Element {
  return (
    <>
      <header className="topbar">
        <div className="topbar-title"><span className="t">Quadro</span></div>
        <StatusPill />
        <button type="button" className="btn ghost bd-sm-btn" onClick={onScrum}>
          <Icon name="spark" size={16} /> Scrum Master
        </button>
        <button type="button" className="icon-btn" aria-label="Configurações" onClick={() => nav.set({ settingsOpen: true })}>
          <Icon name="gear" size={20} />
        </button>
      </header>
      <ReconnectBar />
    </>
  )
}

function CardRow({ item, convTitle, now, onOpen }: { item: BoardItem; convTitle: string | undefined; now: number; onOpen: () => void }): JSX.Element {
  return (
    <button type="button" className={`bd-card ${boardItemStatus(item)}${item.dismissedAt ? ' dismissed' : ''}`} onClick={onOpen}>
      <span className="bd-card-title">{boardItemTitle(item)}</span>
      <span className="bd-card-meta">
        {convTitle ? <span className="bd-card-conv">{convTitle}</span> : null}
        <span>{fmtAgo(item.updatedAt, now)}</span>
        {item.dismissedAt ? <span className="pl-badge">arquivado</span> : null}
        {item.poUserAction && boardItemStatus(item) === 'pending' ? <span className="pl-badge amb">espera você</span> : null}
      </span>
    </button>
  )
}

export function BoardTab(): JSX.Element {
  const projects = useStore(client.store, (s) => s.projects)
  const conversations = useStore(client.store, (s) => s.conversations)
  const { cwd: picked, column, dismissed } = useStore(boardUi, (s) => s)
  const { list, recent } = useMemo(() => boardProjects(projects ?? [], conversations), [projects, conversations])
  const cwd = picked && list.includes(picked) ? picked : recent
  const { status, board, error, moving, reload, move, dismiss } = useBoard(cwd, dismissed)
  const [openId, setOpenId] = useState<string | null>(null)
  const [scrumOpen, setScrumOpen] = useState(false)
  const now = Date.now()
  const items = recentBoardItems(board?.items ?? [], now)
  const open = openId ? items.find((it) => it.id === openId) ?? null : null
  const titles = useMemo(() => new Map(conversations.map((c) => [c.id, c.title])), [conversations])

  // O cartão aberto que sumiu (arquivado sem "mostrar arquivados"): a folha fecha.
  useEffect(() => {
    if (openId && board && !open) setOpenId(null)
  }, [openId, board, open])
  useBackHandler(BACK.modal, () => setOpenId(null), !!open)
  useBackHandler(BACK.modal, () => setScrumOpen(false), scrumOpen)

  const counts = COLUMNS.map((c) => items.filter((it) => boardItemStatus(it) === c.status).length)
  const shown = items.filter((it) => boardItemStatus(it) === column)

  let body: JSX.Element
  if (!cwd) {
    body = (
      <div className="empty-state">
        <strong>Nenhum projeto</strong>
        Abra uma conversa num projeto no PC para ver o quadro dele aqui.
      </div>
    )
  } else if (status === 'loading' && !board) {
    body = <div className="empty-state"><span className="spinner" /></div>
  } else if (status === 'error') {
    body = (
      <div className="empty-state" role="alert">
        <strong>Não deu para ler o quadro</strong>
        {error}
        <button type="button" className="btn ghost" onClick={reload}>Tentar de novo</button>
      </div>
    )
  } else if (board && !board.available) {
    body = (
      <div className="empty-state">
        <strong>Quadro indisponível</strong>
        O quadro não está disponível neste projeto (o PC ainda não o ligou ou o banco do quadro está fora do ar).
        <button type="button" className="btn ghost" onClick={reload}>Tentar de novo</button>
      </div>
    )
  } else {
    body = (
      <>
        <div className="pl-switch bd-cols" role="tablist" aria-label="Colunas">
          {COLUMNS.map((c, i) => (
            <button key={c.status} type="button" role="tab" aria-selected={column === c.status} className={column === c.status ? 'active' : ''} onClick={() => boardUi.set({ column: c.status })}>
              {c.label} <span className="bd-count">{counts[i]}</span>
            </button>
          ))}
        </div>
        <div className="bd-list">
          {shown.length === 0 ? (
            <div className="hist-empty">Nenhum cartão em “{COLUMNS.find((c) => c.status === column)?.label}”.</div>
          ) : (
            shown.map((it) => <CardRow key={it.id} item={it} convTitle={titles.get(it.conversationId)} now={now} onOpen={() => setOpenId(it.id)} />)
          )}
        </div>
      </>
    )
  }

  return (
    <div className="tab-view bd-tab">
      <Topbar onScrum={() => setScrumOpen(true)} />
      {list.length > 0 ? (
        <div className="bd-filters">
          <select className="bd-project" aria-label="Projeto" value={cwd ?? ''} onChange={(e) => boardUi.set({ cwd: e.target.value })}>
            {list.map((p) => (
              <option key={p} value={p}>{basename(p) || p}</option>
            ))}
          </select>
          <label className="bd-toggle">
            <input type="checkbox" checked={dismissed} onChange={(e) => boardUi.set({ dismissed: e.target.checked })} /> Arquivados
          </label>
        </div>
      ) : null}
      {body}
      {open ? (
        <BoardSheet
          item={open}
          items={items}
          moving={moving === open.id}
          onClose={() => setOpenId(null)}
          onMove={(item, to) => void move(item, to)}
          onDismiss={(item) => void dismiss(item)}
          onOpenConversation={(convId) => {
            setOpenId(null)
            openConversation(convId)
          }}
          onOpenItem={(item) => setOpenId(item.id)}
        />
      ) : null}
      {scrumOpen ? <PhoneScrum onClose={() => setScrumOpen(false)} /> : null}
    </div>
  )
}
