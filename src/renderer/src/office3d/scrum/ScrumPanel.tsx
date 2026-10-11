/**
 * O "Diário do Scrum Master": o painel que abre à direita quando você clica no
 * SM do escritório (no molde da estante de Memórias, só tema escuro). Três abas
 * — Agora, Histórico e Conversa com o SM —, os tiles de hoje e a chave "Pode
 * parar envios". Os dados chegam prontos (useScrumPanel).
 */
import { useCallback, useEffect, useState } from 'react'
import type { ScrumDecisao, ScrumEnvioView } from '@shared/scrumPanel'
import { ScrumChat } from './ScrumChat'
import { ScrumHistory } from './ScrumHistory'
import { ScrumNow } from './ScrumNow'
import type { ProjectColorOf } from './ScrumParts'
import { resumeText } from './scrumPanelText'
import type { ScrumPanelData } from './useScrumPanel'
import './scrumPanel.css'

export type ScrumTab = 'agora' | 'hist' | 'chat'

export interface ScrumPanelProps {
  data: ScrumPanelData
  colorOf: ProjectColorOf
  onClose: () => void
  /** O 📍 do cartão: voa até a mesa do agente. */
  onLocate: (convId: string) => void
  onOpenConversation: (convId: string) => void
  /** Manda um texto à conversa (o "Retomar com o aviso"); sem ele, sem o botão. */
  onSend?: (convId: string, text: string) => void
  /** Testes: o "agora" do agrupamento por dia. */
  now?: number
  initialTab?: ScrumTab
}

export function ScrumPanel({ data, colorOf, onClose, onLocate, onOpenConversation, onSend, now, initialTab = 'agora' }: ScrumPanelProps): JSX.Element {
  const [tab, setTab] = useState<ScrumTab>(initialTab)
  const [sobre, setSobre] = useState<string | null>(null)
  const [toggleErr, setToggleErr] = useState<string | null>(null)
  const snap = data.snapshot

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const askAbout = useCallback((d: ScrumDecisao) => {
    setSobre(d.id)
    setTab('chat')
  }, [])
  const onResume = onSend ? (e: ScrumEnvioView) => onSend(e.convId, resumeText(e)) : undefined
  const togglePodeParar = async (): Promise<void> => {
    if (!snap) return
    setToggleErr(await data.setPodeParar(!snap.podeParar))
  }

  const tabBtn = (id: ScrumTab, label: string, extra?: JSX.Element | null): JSX.Element => (
    <button type="button" role="tab" aria-selected={tab === id} className={`smp-tab${tab === id ? ' on' : ''}`} onClick={() => setTab(id)}>
      {label}
      {extra}
    </button>
  )

  return (
    <aside className="smp" role="dialog" aria-label="Diário do Scrum Master" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div className="smp-head">
        <div>
          <div className="smp-kicker">Gestão do escritório</div>
          <h2>Diário do Scrum Master</h2>
          <p className="smp-sub">Cobranças de hoje · todos os projetos</p>
        </div>
        <button type="button" className="smp-close" aria-label="Fechar" onClick={onClose}>
          ✕
        </button>
      </div>

      {snap && !snap.enabled ? <div className="smp-off">O Scrum Master está desligado (Configurações → Geral). O diário abaixo é o que ele já fez.</div> : null}
      {data.error ? (
        <div className="smp-err" role="alert">
          Não deu para ler o painel: {data.error}{' '}
          <button type="button" className="smp-link" onClick={data.reload}>
            tentar de novo
          </button>
        </div>
      ) : null}

      <div className="smp-tiles">
        <div className="smp-tile" data-testid="smp-tile-acompanhados">
          <div className="n">{snap?.tiles.acompanhados ?? '–'}</div>
          <div className="l">envios acompanhados</div>
        </div>
        <div className="smp-tile warn" data-testid="smp-tile-cobrancas">
          <div className="n">{snap?.tiles.cobrancasHoje ?? '–'}</div>
          <div className="l">cobranças hoje</div>
        </div>
        <div className="smp-tile bad" data-testid="smp-tile-parados">
          <div className="n">{snap?.tiles.parados ?? '–'}</div>
          <div className="l">{snap?.tiles.parados === 1 ? 'envio parado por ele' : 'envios parados por ele'}</div>
        </div>
      </div>

      <nav className="smp-tabs" role="tablist">
        {tabBtn('agora', 'Agora')}
        {tabBtn('hist', 'Histórico', snap && snap.contestados > 0 ? <span className="smp-badge bad">{snap.contestados} contestado{snap.contestados === 1 ? '' : 's'}</span> : null)}
        {tabBtn('chat', 'Conversa com o SM')}
      </nav>

      {tab === 'agora' ? (
        snap ? (
          <ScrumNow envios={snap.envios} colorOf={colorOf} actions={{ onLocate, onOpenConversation, onResume, dequeue: data.dequeue, decide: data.decide }} />
        ) : !data.error ? (
          <div className="smp-quiet">Lendo o painel…</div>
        ) : null
      ) : null}
      {tab === 'hist' ? (
        <ScrumHistory
          history={data.history}
          error={data.historyError}
          req={data.histReq}
          setReq={data.setHistReq}
          colorOf={colorOf}
          now={now ?? Date.now()}
          onAsk={askAbout}
          onOpenConversation={onOpenConversation}
        />
      ) : null}
      {tab === 'chat' ? <ScrumChat data={data} sobre={sobre} setSobre={setSobre} /> : null}

      <div className="smp-foot">
        <span>
          Diário em <code>scrum-decisions.log</code>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={!!snap?.podeParar}
          disabled={!snap}
          className={`smp-toggle${snap?.podeParar ? ' on' : ''}`}
          title={snap?.logFile ?? undefined}
          onClick={() => void togglePodeParar()}
        >
          <i aria-hidden="true" /> Pode parar envios
        </button>
      </div>
      {toggleErr ? (
        <div className="smp-err" role="alert">
          {toggleErr}
        </div>
      ) : null}
    </aside>
  )
}
