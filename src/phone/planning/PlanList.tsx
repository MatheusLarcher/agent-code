/**
 * A lista da aba Planos: os planos de cada projeto que o PC conhece, no mesmo
 * cabeçalho recolhível da aba Conversas (tudo começa recolhido). Cada plano mostra
 * título, etapas feitas/total e as ambiguidades abertas; o "?" do cabeçalho
 * recolhido avisa que há ambiguidade esperando resposta. "+ Novo planejamento" no
 * topo (e o "+" de cada projeto, com ele já escolhido).
 */
import { useEffect, useMemo } from 'react'
import { client, nav } from '../app/runtime'
import { basename } from '../core/format'
import { useStore } from '../core/store'
import type { RemotePlanSummary } from '../core/types'
import { ReconnectBar } from '../chat/ChatBars'
import { StatusPill } from '../shell/StatusMenu'
import { CollapsibleGroup } from '../ui/Collapsible'
import { Icon } from '../ui/icons'
import { knownProjects, loadLists, openPlan, planUi, startCreate, toggleProject } from './planState'

function PlanRow({ cwd, p }: { cwd: string; p: RemotePlanSummary }): JSX.Element {
  const { total, concluidas } = p.etapas
  const pct = total > 0 ? Math.round((concluidas / total) * 100) : 0
  return (
    <button type="button" className="pl-row" onClick={() => openPlan({ cwd, slug: p.slug })}>
      <span className="pl-row-title">{p.titulo || p.slug}</span>
      {p.erro ? (
        <span className="pl-row-meta pl-row-err">Não abriu: {p.erro}</span>
      ) : (
        <span className="pl-row-meta">
          <span className="pl-progress" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
          <span>{total ? `${concluidas}/${total} etapas` : 'sem etapas'}</span>
          <span>· {p.cards} {p.cards === 1 ? 'card' : 'cards'}</span>
          {p.ambiguidadesAbertas > 0 && (
            <span className="pl-badge amb">{p.ambiguidadesAbertas} {p.ambiguidadesAbertas === 1 ? 'ambiguidade aberta' : 'ambiguidades abertas'}</span>
          )}
        </span>
      )}
    </button>
  )
}

export function PlanList(): JSX.Element {
  const projects = useStore(client.store, (s) => s.projects)
  const conversations = useStore(client.store, (s) => s.conversations)
  const loaded = useStore(client.store, (s) => s.loaded)
  const lists = useStore(planUi, (s) => s.lists)
  const expanded = useStore(planUi, (s) => s.expanded)
  const cwds = useMemo(() => knownProjects(projects, conversations), [projects, conversations])
  const key = cwds.join('\n')

  // Ao abrir a lista: lê todos os projetos (contagens e o "?" valem recolhidos).
  useEffect(() => {
    if (key) void loadLists(key.split('\n'))
  }, [key])

  const groups = cwds.filter((cwd) => {
    const l = lists[cwd]
    if (l?.hidden) return false
    return !l || l.loading || !!l.error || (l.plans?.length ?? 0) > 0
  })
  const settled = cwds.length > 0 && cwds.every((cwd) => lists[cwd] && !lists[cwd].loading)
  const empty = loaded && (cwds.length === 0 || (settled && groups.length === 0))

  return (
    <div className="tab-view list-view pl-list-view">
      <header className="topbar">
        <div className="topbar-title"><span className="t">Planos</span></div>
        <StatusPill />
        <button type="button" className="icon-btn" aria-label="Configurações" onClick={() => nav.set({ settingsOpen: true })}>
          <Icon name="gear" size={20} />
        </button>
      </header>
      <ReconnectBar />
      <div className="history-list">
        <button type="button" className="pl-new" onClick={() => startCreate(cwds[0] ?? '')} disabled={!cwds.length}>
          <Icon name="plus" size={18} /> Novo planejamento
        </button>
        {empty ? (
          <div className="empty-state">
            <strong>Nenhum planejamento ainda</strong>
            Crie um com “Novo planejamento”: o Agent Manager conversa com você e monta as etapas e os cards.
          </div>
        ) : (
          groups.map((cwd) => {
            const l = lists[cwd]
            const plans = l?.plans ?? []
            const busy = conversations.some((c) => c.mode === 'planning' && c.cwd === cwd && c.busy)
            return (
              <CollapsibleGroup
                key={cwd}
                title={basename(cwd)}
                count={plans.length}
                open={!!expanded[cwd]}
                onToggle={() => toggleProject(cwd)}
                busy={busy}
                waiting={plans.some((p) => p.ambiguidadesAbertas > 0)}
                icon="folder"
                actions={
                  <button type="button" className="hist-plus" title="Novo planejamento neste projeto" aria-label="Novo planejamento neste projeto" onClick={() => startCreate(cwd)}>
                    +
                  </button>
                }
              >
                {l?.loading && !l.plans ? (
                  <div className="hist-empty"><span className="spinner" /> Carregando…</div>
                ) : l?.error ? (
                  <div className="hist-empty pl-row-err">{l.error}</div>
                ) : (
                  plans.map((p) => <PlanRow key={p.slug} cwd={cwd} p={p} />)
                )}
              </CollapsibleGroup>
            )
          })
        )}
      </div>
    </div>
  )
}
