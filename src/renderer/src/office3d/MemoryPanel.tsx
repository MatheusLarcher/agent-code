/**
 * O painel de Memórias (req-painel-memorias), aberto pelo clique na estante: à
 * direita do escritório, no visual "GESTÃO DO ESCRITÓRIO" do mockup. SÓ
 * LEITURA — gravar, editar e aposentar continuam só pelo memory_propose.
 *
 *   Em cima "Usadas pelos agentes": a linha do tempo do uso (a mais recente
 *   primeiro), com quem está na estante agora fixado no topo (ponto pulsando);
 *   o agente leva a câmera até ele.
 *   Embaixo "Todas as memórias": agrupadas pela pasta, com o gancho, o tipo
 *   (o alcance), a data e a barrinha dos 7 dias; o clique abre o texto e onde
 *   foi usada. Valor do cofre nunca aparece (o corpo só tem a marca).
 *   Filtros (valem para as duas partes): período, projeto, pasta, agente, como
 *   foi usada, tipo, busca, ordem e os chips "Esquecidas" e "Em conflito".
 */
import './memoryPanel.css'
import { useMemo, useState } from 'react'
import { byFolder, filterUsage, memoryRows, NO_FILTERS, type HowFilter, type PanelFilters, type Period, type SortBy } from './memoryUsage'
import { MemoryDetail, MemoryLine, UsageLine } from './MemoryPanelParts'
import type { MemoryPanelData } from './useMemoryPanel'

export interface MemoryPanelProps {
  data: MemoryPanelData
  /** Quem está na estante agora (fixados no topo). */
  atShelf: ReadonlyArray<{ convId: string; name: string }>
  onClose: () => void
  onFlyToAgent: (convId: string) => void
  onOpenConversation: (convId: string) => void
  now?: number
}

const PERIODS: ReadonlyArray<[Period, string]> = [['agora', 'agora'], ['hoje', 'hoje'], ['7d', '7 dias'], ['tudo', 'tudo']]
const HOWS: ReadonlyArray<[HowFilter, string]> = [['escolhida', 'escolhida pelo app'], ['lida', 'lida'], ['gravada', 'gravada']]
const name = (cwd: string): string => cwd.split(/[\\/]+/).filter(Boolean).pop() ?? cwd

export function MemoryPanel({ data, atShelf, onClose, onFlyToAgent, onOpenConversation, now = Date.now() }: MemoryPanelProps): JSX.Element {
  const [f, setF] = useState<PanelFilters>(NO_FILTERS)
  const [open, setOpen] = useState<string | null>(null)
  const set = (patch: Partial<PanelFilters>): void => setF((cur) => ({ ...cur, ...patch }))
  const titles = useMemo(() => new Map(data.items.map((i) => [i.relPath, i.title])), [data.items])
  const uses = useMemo(() => filterUsage(data.events, data.items, f, now), [data.events, data.items, f, now])
  const rows = useMemo(() => memoryRows(data.items, data.events, f, now, data.conflicts, data.bodies), [data.items, data.events, f, now, data.conflicts, data.bodies])
  const projects = useMemo(() => [...new Set(data.events.map((e) => e.project).filter(Boolean))].sort(), [data.events])
  const agents = useMemo(() => [...new Map(data.events.map((e) => [e.convId, e.agent])).entries()], [data.events])
  const folders = useMemo(() => [...new Set(data.items.map((i) => i.folder))].sort(), [data.items])
  const week = data.events.filter((e) => now - e.at < 7 * 86_400_000).length
  const detail = open ? rows.find((r) => r.relPath === open) ?? memoryRows(data.items, data.events, NO_FILTERS, now, data.conflicts).find((r) => r.relPath === open) : undefined

  const chip = (on: boolean, label: string, click: () => void, key?: string): JSX.Element => (
    <button key={key ?? label} type="button" className={`mp-chip${on ? ' on' : ''}`} aria-pressed={on} onClick={click}>
      {label}
    </button>
  )

  return (
    <aside className="mp" role="dialog" aria-label="Memórias" data-testid="memory-panel">
      <header className="mp-head">
        <div>
          <div className="mp-kicker">GESTÃO DO ESCRITÓRIO</div>
          <h2>Memórias</h2>
          <p className="mp-sub">
            {data.items.length} memórias · {week} uso{week === 1 ? '' : 's'} nos últimos 7 dias · só leitura
          </p>
        </div>
        <button type="button" className="mp-close" onClick={onClose} aria-label="Fechar as Memórias" title="Fechar (Esc)">
          ✕
        </button>
      </header>

      {detail ? (
        <MemoryDetail
          r={detail}
          body={data.bodies.get(detail.relPath) ?? null}
          uses={data.events.filter((e) => e.relPath === detail.relPath).sort((a, b) => b.at - a.at)}
          now={now}
          onBack={() => setOpen(null)}
          onOpenConversation={onOpenConversation}
        />
      ) : (
        <>
          <div className="mp-filters" data-testid="mp-filters">
            <div className="mp-row">{PERIODS.map(([p, l]) => chip(f.period === p, l, () => set({ period: p }), p))}</div>
            <div className="mp-row">
              {HOWS.map(([h, l]) => chip(f.how === h, l, () => set({ how: f.how === h ? null : h }), h))}
              {chip(f.chip === 'esquecidas', 'Esquecidas', () => set({ chip: f.chip === 'esquecidas' ? null : 'esquecidas' }))}
              {chip(f.chip === 'conflito', `Em conflito${data.conflicts.size ? ` (${data.conflicts.size})` : ''}`, () => set({ chip: f.chip === 'conflito' ? null : 'conflito' }), 'conflito')}
            </div>
            <div className="mp-row">
              <select aria-label="Projeto" value={f.project ?? ''} onChange={(e) => set({ project: e.target.value || null })}>
                <option value="">Todos os projetos</option>
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {name(p)}
                  </option>
                ))}
              </select>
              <select aria-label="Pasta" value={f.folder ?? '\u0000'} onChange={(e) => set({ folder: e.target.value === '\u0000' ? null : e.target.value })}>
                <option value={'\u0000'}>Todas as pastas</option>
                {folders.map((p) => (
                  <option key={p} value={p}>
                    {p ? `${p}/` : '(raiz)'}
                  </option>
                ))}
              </select>
              <select aria-label="Agente" value={f.agent ?? ''} onChange={(e) => set({ agent: e.target.value || null })}>
                <option value="">Todos os agentes</option>
                {agents.map(([id, n]) => (
                  <option key={id} value={id}>
                    {n}
                  </option>
                ))}
              </select>
              <select aria-label="Tipo" value={f.scope ?? ''} onChange={(e) => set({ scope: (e.target.value || null) as PanelFilters['scope'] })}>
                <option value="">Todos os tipos</option>
                <option value="user">do usuário</option>
                <option value="project">do projeto</option>
                <option value="domain">de domínio</option>
              </select>
            </div>
            <div className="mp-row">
              <input type="search" aria-label="Buscar nas memórias" placeholder="Buscar no título, gancho e texto…" value={f.text} onChange={(e) => set({ text: e.target.value })} />
              <select aria-label="Ordenar" value={f.sort} onChange={(e) => set({ sort: e.target.value as SortBy })}>
                <option value="recentes">usadas recentemente</option>
                <option value="mais-usadas">mais usadas</option>
                <option value="nunca">nunca usadas</option>
              </select>
            </div>
          </div>

          <h4 className="mp-h">Usadas pelos agentes</h4>
          <ul className="mp-list" data-testid="mp-uses">
            {atShelf.map((a) => (
              <li key={`shelf-${a.convId}`} className="mp-use pinned" data-testid="mp-at-shelf">
                <button type="button" className="mp-agent" onClick={() => onFlyToAgent(a.convId)}>
                  <span className="mp-dot pulse" />
                  {a.name}
                </button>
                <span className="mp-use-what">na estante agora</span>
              </li>
            ))}
            {uses.slice(0, 60).map((e, i) => (
              <UsageLine key={i} e={e} title={e.relPath ? (titles.get(e.relPath) ?? e.relPath) : 'a lista de memórias'} now={now} onAgent={onFlyToAgent} />
            ))}
            {!uses.length && !atShelf.length ? <li className="mp-empty">{data.loading ? 'Carregando…' : 'Nenhum uso com esses filtros.'}</li> : null}
          </ul>

          <h4 className="mp-h">Todas as memórias</h4>
          {byFolder(rows).map((g) => (
            <section key={g.folder} className="mp-folder">
              <div className="mp-folder-name">{g.folder ? `${g.folder}/` : 'raiz'}</div>
              <ul className="mp-list">
                {g.rows.map((r) => (
                  <MemoryLine
                    key={r.relPath}
                    r={r}
                    now={now}
                    onOpen={(rel) => {
                      setOpen(rel)
                      void data.read(rel)
                    }}
                  />
                ))}
              </ul>
            </section>
          ))}
          {!rows.length ? <p className="mp-empty">{data.loading ? 'Carregando…' : 'Nenhuma memória com esses filtros.'}</p> : null}
        </>
      )}
    </aside>
  )
}
