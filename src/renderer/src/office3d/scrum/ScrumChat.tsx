/**
 * A aba "Conversa com o SM": você pergunta por que ele fez algo, ele responde
 * com base no próprio diário. Guardada inteira (scrum-chat.jsonl); a página
 * mais antiga vem por "Carregar anteriores". "Marcar como corte errado"
 * contesta a decisão presa no "Sobre:".
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ScrumChatMessage, ScrumDecisao } from '@shared/scrumPanel'
import { hhmm, projectName, sobreChip, sobreText } from './scrumPanelText'
import type { ScrumPanelData } from './useScrumPanel'

export interface ScrumChatProps {
  data: Pick<ScrumPanelData, 'chat' | 'chatMore' | 'chatError' | 'loadOlderChat' | 'asking' | 'ask' | 'decisions'>
  /** A decisão de que se fala (o "Questionar" do Histórico prende aqui). */
  sobre: string | null
  setSobre: (id: string | null) => void
}

function SobreLine({ id, decisions, cwd }: { id: string; decisions: ReadonlyMap<string, ScrumDecisao>; cwd: string | null }): JSX.Element {
  const d = decisions.get(id)
  if (!d) return <div className="smp-ctx">Sobre: uma decisão em {projectName(cwd)}</div>
  const [head, ...rest] = sobreText(d).split(' · ')
  return (
    <div className="smp-ctx" data-testid="smp-ctx">
      Sobre: <b>{head}</b>
      {rest.length ? ` · ${rest.join(' · ')}` : ''}
    </div>
  )
}

function Message({ m }: { m: ScrumChatMessage }): JSX.Element {
  const me = m.role === 'usuario'
  return (
    <div className={`smp-msg ${me ? 'me-msg' : 'sm-msg'}`} data-testid="smp-chat-msg" data-role={m.role}>
      <span className="smp-who">{me ? 'VC' : 'SM'}</span>
      <div className="smp-bubble">
        <div className="smp-meta">
          {hhmm(m.at)} · {me ? 'você' : 'Scrum Master'}
        </div>
        {m.text}
      </div>
    </div>
  )
}

export function ScrumChat({ data, sobre, setSobre }: ScrumChatProps): JSX.Element {
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  const count = data.chat.length
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [count, data.asking])

  const send = async (contestar: boolean): Promise<void> => {
    const t = text.trim()
    if (data.asking || (!t && !contestar)) return
    const e = await data.ask(t, sobre, contestar)
    setErr(e)
    if (!e) setText('')
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send(false)
    }
  }
  const sobreDecision = sobre ? data.decisions.get(sobre) : undefined

  let lastSobre: string | null = null
  return (
    <div className="smp-pane smp-chat" data-testid="smp-pane-chat">
      <div className="smp-chat-note">
        Esta conversa fica guardada inteira, sem limite, para melhorar o Scrum Master depois. Ele responde com base no próprio histórico; não corta nem retoma envios por aqui.
      </div>
      {data.chatMore ? (
        <button type="button" className="smp-btn smp-older" onClick={data.loadOlderChat}>
          Carregar anteriores
        </button>
      ) : null}
      {data.chatError ? (
        <div className="smp-err" role="alert">
          Não deu para ler a conversa: {data.chatError}
        </div>
      ) : null}
      <div className="smp-talk smp-chat-log">
        {count === 0 && !data.chatError ? <div className="smp-quiet">Nenhuma pergunta ainda. Use “Questionar” no Histórico para perguntar sobre uma decisão.</div> : null}
        {data.chat.map((m) => {
          const showSobre = m.sobre !== null && m.sobre !== lastSobre
          lastSobre = m.sobre ?? lastSobre
          return (
            <div key={m.id} className="smp-chat-item">
              {showSobre && m.sobre ? <SobreLine id={m.sobre} decisions={data.decisions} cwd={m.projectCwd} /> : null}
              <Message m={m} />
            </div>
          )
        })}
        {data.asking ? <div className="smp-quiet">O Scrum Master está pensando…</div> : null}
        <div ref={endRef} />
      </div>
      <div className="smp-composer">
        {sobre ? (
          <button type="button" className="smp-ctx-chip" title="Soltar a decisão" onClick={() => setSobre(null)}>
            Sobre: {sobreChip(sobreDecision, null)} ✕
          </button>
        ) : null}
        <textarea
          rows={2}
          value={text}
          placeholder="Pergunte ao Scrum Master por que ele fez algo…"
          aria-label="Pergunta ao Scrum Master"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="smp-composer-row">
          <button
            type="button"
            className="smp-btn"
            disabled={!sobre || data.asking}
            title={sobre ? 'Marca a decisão como errada; o texto vai junto' : 'Use “Questionar” no Histórico para escolher a decisão'}
            onClick={() => void send(true)}
          >
            Marcar como corte errado
          </button>
          <button type="button" className="smp-btn primary" disabled={!text.trim() || data.asking} onClick={() => void send(false)}>
            Enviar
          </button>
        </div>
        {err ? (
          <div className="smp-err" role="alert">
            {err}
          </div>
        ) : null}
      </div>
    </div>
  )
}
