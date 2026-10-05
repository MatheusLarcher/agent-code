/**
 * A aba Central: o trilho das conversas trabalhando agora (o toque abre a
 * conversa), o feed do retrato que o PC publica e o campo "Fale com o agent…".
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { client } from '../app/runtime'
import { CENTRAL_CONV_ID } from '../core/client'
import { useStore } from '../core/store'
import { Composer } from '../composer/Composer'
import { ReconnectBar } from '../chat/ChatBars'
import { StatusPill } from '../shell/StatusMenu'
import { centralSnapshot, pruneCentral, refreshCentralSoon } from './centralActions'
import { centralUi } from './centralStore'
import { CentralAnswered, CentralReply, CentralRequest, CentralSending, colorVar, DestIcon, openDestination } from './CentralEntries'
import { CentralQuestion } from './CentralQuestion'

const NEAR_BOTTOM = 80

export function CentralView(): JSX.Element {
  const conversations = useStore(client.store, (s) => s.conversations)
  const loaded = useStore(client.store, (s) => s.loaded)
  const sent = useStore(centralUi, (s) => s.sent)
  const conv = conversations.find((c) => c.id === CENTRAL_CONV_ID)
  const snap = useMemo(() => centralSnapshot(conversations), [conversations])
  const boxRef = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)

  useEffect(() => pruneCentral(snap), [snap])
  // Entrou na Central: lê o retrato logo, sem esperar o ciclo de 4 s.
  useEffect(() => refreshCentralSoon(), [])

  useLayoutEffect(() => {
    const box = boxRef.current
    if (box && nearBottom.current) box.scrollTop = box.scrollHeight
  }, [snap, sent])

  const onScroll = (): void => {
    const box = boxRef.current
    if (box) nearBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM
  }

  if (loaded && !conv) {
    return (
      <div className="tab-view">
        <header className="topbar">
          <div className="topbar-title"><span className="central-orb small" /><span className="t">Central</span></div>
          <StatusPill />
        </header>
        <ReconnectBar />
        <div className="empty-state">
          <strong>A Central não está disponível neste PC</strong>
          Atualize o app do PC para falar com a Central pelo celular. As conversas continuam na aba Conversas.
        </div>
      </div>
    )
  }

  const empty = !snap.entries.length && !sent.length && !snap.questions.length
  return (
    <div className="tab-view central-view-tab">
      <header className="topbar">
        <div className="topbar-title">
          <span className="central-orb small" />
          <span className="t">{conv?.title || 'Central'}</span>
        </div>
        <StatusPill />
      </header>
      <ReconnectBar />
      {snap.rail.length > 0 && (
        <nav className="central-rail" aria-label="Conversas trabalhando agora">
          {snap.rail.map((card) => (
            <button
              key={card.convId}
              type="button"
              className="c-run"
              style={colorVar(card.color)}
              title={(card.project ? card.project + ' · ' : '') + (card.title || '')}
              onClick={() => openDestination({ convId: card.convId })}
            >
              <DestIcon icon={card.icon} glyph={card.sandbox ? 'sandbox' : 'project'} size={16} />
              <span className="c-run-title">{card.title || card.project || 'conversa'}</span>
              <span className="c-run-dot" />
            </button>
          ))}
        </nav>
      )}
      <div className="messages-wrap">
        <div ref={boxRef} className="messages central-view" onScroll={onScroll}>
          {empty ? (
            <div className="c-empty">Diga o que precisa: a Central leva para a conversa certa.</div>
          ) : (
            <>
              {snap.entries.map((e) =>
                !e ? null : e.kind === 'request' ? (
                  <CentralRequest key={e.id} e={e} />
                ) : e.kind === 'reply' ? (
                  <CentralReply key={e.id} r={e} />
                ) : e.kind === 'question' ? (
                  <CentralAnswered key={e.id} q={e} />
                ) : null
              )}
              {sent.map((s, i) => <CentralSending key={`s${s.at}-${i}`} s={s} />)}
              {snap.questions.map((q) => (q?.request ? <CentralQuestion key={q.convId + ':' + q.request.id} q={q} /> : null))}
            </>
          )}
        </div>
      </div>
      <Composer />
    </div>
  )
}
