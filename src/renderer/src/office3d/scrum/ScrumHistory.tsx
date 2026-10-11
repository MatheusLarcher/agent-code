/**
 * A aba "Histórico" do painel do Scrum Master: tudo o que ele fez, agrupado por
 * dia, com os cortes em destaque e a marca do que você contestou. Filtros, o
 * período e a busca vão ao main (scrumHistory); o resto é só apresentação.
 */
import { useState } from 'react'
import type { ScrumDecisao, ScrumHistFiltro, ScrumHistoryItem, ScrumHistoryRequest, ScrumHistPeriodo } from '@shared/scrumPanel'
import { ProjectTag, Verdict, type ProjectColorOf } from './ScrumParts'
import { daySummary, groupByDay, hhmm, histKind, histMeta } from './scrumPanelText'

const FILTROS: ReadonlyArray<{ id: ScrumHistFiltro; label: string }> = [
  { id: 'tudo', label: 'Tudo' },
  { id: 'cortes', label: 'Só cortes' },
  { id: 'contestados', label: 'Contestados' },
  { id: 'cobrancas', label: 'Cobranças' },
  { id: 'avisos', label: 'Avisos a você' }
]

const PERIODOS: ReadonlyArray<{ id: ScrumHistPeriodo; label: string }> = [
  { id: '7d', label: '7 dias' },
  { id: '30d', label: '30 dias' },
  { id: 'tudo', label: 'Tudo' }
]

export interface ScrumHistoryProps {
  history: { items: ScrumHistoryItem[]; total: number } | null
  error: string | null
  req: ScrumHistoryRequest
  setReq: (patch: Partial<ScrumHistoryRequest>) => void
  colorOf: ProjectColorOf
  now: number
  /** "Questionar" e "Ver a conversa contestada": a Conversa com o SM, presa nesta decisão. */
  onAsk: (d: ScrumDecisao) => void
  /** "Ver o envio": a conversa do agente. */
  onOpenConversation: (convId: string) => void
}

function HistItem({ item, color, onAsk, onOpenConversation }: { item: ScrumHistoryItem; color: string } & Pick<ScrumHistoryProps, 'onAsk' | 'onOpenConversation'>): JSX.Element {
  const d = item.decisao
  const k = histKind(d.tipo)
  const meta = histMeta(d)
  const why = d.tipo === 'deixou-seguir' ? null : d.motivo
  return (
    <li className={`smp-ev ${k.cls}${item.contestacao ? ' contestado' : ''}`} data-testid="smp-ev" data-tipo={d.tipo}>
      <span className="smp-ev-ico" aria-hidden="true">
        {k.ico}
      </span>
      <div className="smp-ev-body">
        <div className="smp-ev-top">
          <b>{k.verbo}</b>
          {k.ligacao ? ` ${k.ligacao} ` : ' '}
          <b>{d.conversationTitle ?? 'Conversa'}</b>
          <ProjectTag cwd={d.projectCwd} color={color} />
        </div>
        <div className="smp-ev-meta">
          {meta.antes}
          {d.veredito ? (
            <>
              {' · '}
              <Verdict v={d.veredito} tipo={d.tipoDesvio} />
            </>
          ) : null}
          {meta.depois ? ` · ${meta.depois}` : ''}
          {d.tipo === 'deixou-seguir' && d.motivo ? ` · ${d.motivo}` : ''}
        </div>
        {why ? <div className="smp-ev-why">“{why}”</div> : null}
        {item.resposta ? <div className="smp-ev-why smp-ev-reply">Agente: {item.resposta}</div> : null}
        {item.contestacao ? (
          <div className="smp-ev-flag" data-testid="smp-ev-flag">
            Você contestou: <i>“{item.contestacao.frase}”</i> · {hhmm(item.contestacao.at)}
          </div>
        ) : null}
        <div className="smp-actions">
          {item.contestacao ? (
            <button type="button" className="smp-btn" onClick={() => onAsk(d)}>
              Ver a conversa contestada
            </button>
          ) : (
            <button type="button" className="smp-btn" onClick={() => onAsk(d)}>
              Questionar
            </button>
          )}
          {k.corte ? (
            <button type="button" className="smp-btn" onClick={() => onOpenConversation(d.convId)}>
              Ver o envio
            </button>
          ) : null}
        </div>
      </div>
    </li>
  )
}

export function ScrumHistory({ history, error, req, setReq, colorOf, now, onAsk, onOpenConversation }: ScrumHistoryProps): JSX.Element {
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const days = history ? groupByDay(history.items, now) : []
  // Com filtro ou busca, todo dia aberto; sem eles, só o primeiro (os outros mostram o resumo).
  const allOpen = req.filtro !== 'tudo' || !!req.busca?.trim()
  return (
    <div className="smp-pane" data-testid="smp-pane-hist">
      <div className="smp-chips" role="group" aria-label="Filtro">
        {FILTROS.map((f) => (
          <button key={f.id} type="button" className={`smp-chip${req.filtro === f.id ? ' on' : ''}`} aria-pressed={req.filtro === f.id} onClick={() => setReq({ filtro: f.id })}>
            {f.label}
          </button>
        ))}
      </div>
      <div className="smp-chips" role="group" aria-label="Período">
        {PERIODOS.map((p) => (
          <button key={p.id} type="button" className={`smp-chip${req.periodo === p.id ? ' on' : ''}`} aria-pressed={req.periodo === p.id} onClick={() => setReq({ periodo: p.id })}>
            {p.label}
          </button>
        ))}
        <input
          className="smp-search"
          type="search"
          placeholder="Buscar por projeto ou conversa"
          aria-label="Buscar por projeto ou conversa"
          value={req.busca ?? ''}
          onChange={(e) => setReq({ busca: e.target.value })}
        />
      </div>
      {error ? (
        <div className="smp-err" role="alert">
          Não deu para ler o diário: {error}
        </div>
      ) : null}
      {!history && !error ? <div className="smp-quiet">Lendo o diário…</div> : null}
      {history && days.length === 0 ? (
        <div className="smp-quiet">{req.filtro === 'tudo' && !req.busca?.trim() ? 'O Scrum Master ainda não fez nada neste período.' : 'Nada com este filtro neste período.'}</div>
      ) : null}
      {days.map((day, i) => {
        const open = allOpen || i === 0 || opened.has(day.label)
        return (
          <div key={day.label} className="smp-day" data-testid="smp-day">
            <div className="smp-h">{day.label}</div>
            {open ? (
              <ul className="smp-hist">
                {day.items.map((item) => (
                  <HistItem key={item.decisao.id} item={item} color={colorOf(item.decisao.projectCwd)} onAsk={onAsk} onOpenConversation={onOpenConversation} />
                ))}
              </ul>
            ) : (
              <div className="smp-quiet">
                {daySummary(day.items)} —{' '}
                <button type="button" className="smp-link" onClick={() => setOpened((s) => new Set(s).add(day.label))}>
                  mostrar
                </button>
              </div>
            )}
          </div>
        )
      })}
      {history && history.total > history.items.length ? (
        <div className="smp-quiet">
          Mostrando {history.items.length} de {history.total}. Use a busca ou um período menor para achar o resto.
        </div>
      ) : null}
    </div>
  )
}
