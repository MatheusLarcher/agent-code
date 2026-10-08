/**
 * As linhas do chat — FONTE ÚNICA do visual de cada mensagem: o balão do
 * usuário (anexos, cancelada, erro), a resposta ou narração do assistente em
 * Markdown (Baixar, Ouvir, hora), o pensamento, o cartão de ferramenta
 * (ToolCard, com o link do arquivo do plano) e as notas do sistema.
 *
 * O MessageList monta a conversa com `ChatRow`; o Escritório 3D monta o turno
 * com as MESMAS linhas: a tela do monitor passa `tts` e `quote` ("Ouvir", "Ler
 * daqui" e "Comentar", como aqui) e a prévia do hover segue só leitura. Sem
 * `onRetry`, `tts`, `quote` e `onUseAccount`, somem "Tentar de novo", "Ouvir",
 * "Comentar" e "Continuar nessa conta" — o resto (anexos, Baixar, Preview do
 * ToolCard, hora) sai igual.
 */
import { Fragment, memo, useEffect, useState } from 'react'
import { parseDownloads } from '@shared/ipc'
import { modelDisplayName } from '@shared/modelLabel'
import { useFreshOnce } from '../chatAnim'
import { fileMeta, fmtSize } from '../files'
import { InlineMediaText } from '../inlineMedia/InlineMediaText'
import { createdPlanFile, PlanFileLink } from '../planning/PlanFileLink'
import type { UIMessage } from '../types'
import { useUI } from '../ui/UiProvider'
import { AccountSwitchNote } from './AccountSwitchNote'
import { IconSpeaker, IconStopSmall } from './Icons'
import { CardRefText, type CardRefResolver } from './Markdown'
import { LazyMarkdown } from './lazyMarkdown'
import { QuotableMessage, type QuoteListApi } from './quoteComment/quoteBlocks'
import { ToolCard } from './ToolCard'
import './chatLook.css'

/** Read-aloud controls passed down from App (TTS state lives there so audio
 *  survives message re-renders and conversation switches). */
export interface TtsControls {
  /** Id of the message currently being read (or loading), else null. */
  speakingId: string | null
  /** Start/stop reading a message's answer aloud. */
  onToggleSpeak: (id: string, text: string) => void
}

/** O que a linha precisa de quem monta a lista. Sem os ganchos, a linha é só leitura. */
export interface ChatRowContext {
  /** [[Nome]] de um card do plano → pílula colorida (só o chat do Agent Manager). */
  resolveRef: CardRefResolver | null
  /** Pastas do plano aberto: arquivo criado nelas ganha o link "Abrir". */
  planDir?: string | readonly string[]
  /** A última resposta com hora: só ela mostra a data. */
  lastTsId: string | null
  busy?: boolean
  /** Reenvia a mensagem cujo turno falhou ("Tentar de novo"). */
  onRetry?: (msgId: string) => void
  /** "Ouvir" na resposta final (e o "Ler daqui" dos blocos). */
  tts?: TtsControls | null
  /** "Comentar" nos blocos da resposta. */
  quote?: QuoteListApi
  /** "Continuar nessa conta" na sugestão de troca de conta. */
  onUseAccount?: (accountId: string, continueTask: boolean) => void
  /** Dentro de um grupo de passos aberto (ChatStep): o cartão pronto mostra "✓ N" colado ao texto. */
  inStep?: boolean
  /** A linha ao vivo (ChatLive) está no fim da lista: o passo em andamento não repete spinner nem "agora: …". */
  liveLine?: boolean
}

/** Last path segment, for the chip label. */
function fileLabel(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

/** A "Baixar" button rendered under an assistant message that flagged a file. */
function DownloadChip({ path }: { path: string }): JSX.Element {
  const { notify } = useUI()
  const download = async (): Promise<void> => {
    const r = await window.api.downloadFile(path)
    notify(r.ok ? 'sucesso' : 'erro', r.message)
  }
  return (
    <button className="msg-download" onClick={download} title={path}>
      ⬇️ Baixar {fileLabel(path)}
    </button>
  )
}

/** "há X" relative label for a time earlier TODAY (else ''). */
function relativeToday(ts: number, now: number): string {
  const d = new Date(ts)
  const n = new Date(now)
  const sameDay =
    d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  if (!sameDay) return ''
  const secs = Math.max(0, Math.floor((now - ts) / 1000))
  if (secs < 45) return 'agora mesmo'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `há ${mins} min`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem ? `há ${hrs} h ${rem} min` : `há ${hrs} h`
}

/** Date+time stamp shown under the last assistant answer. If the task ran today,
 *  it also shows how long ago (refreshing every 30s). */
function MessageTime({ ts }: { ts: number }): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const rel = relativeToday(ts, now)
  useEffect(() => {
    if (!rel) return // only a "today" stamp needs to keep ticking
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [rel])

  const d = new Date(ts)
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const sameDay = !!relativeToday(ts, Date.now())
  const absolute = sameDay
    ? `Hoje às ${time}`
    : `${d.toLocaleDateString('pt-BR')} às ${time}`
  return (
    <div className="msg-time" title={d.toLocaleString('pt-BR')}>
      {absolute}
      {rel && <span className="msg-time-rel"> · {rel}</span>}
    </div>
  )
}

type UserMsg = Extract<UIMessage, { kind: 'user' }>
type AssistantMsg = Extract<UIMessage, { kind: 'assistant-text' }>

function UserRow({ m, ctx }: { m: UserMsg; ctx: ChatRowContext }): JSX.Element {
  const { resolveRef, onRetry, busy = false } = ctx
  return (
    <div className="msg user" data-mid={m.id}>
      <div className={`bubble ${m.error ? 'has-error' : ''}`}>
        {!m.media && m.images && m.images.length > 0 && (
          <div className="msg-images">
            {m.images.map((src, k) => (
              <img key={k} className="msg-image" src={src} alt="anexo" />
            ))}
          </div>
        )}
        {!m.media && m.files && m.files.length > 0 && (
          <div className="msg-files">
            {m.files.map((f, k) => {
              const meta = fileMeta(f.name)
              return (
                <span className="file-card" key={k} title={f.name}>
                  <span className={`file-badge kind-${meta.kind}`}>{meta.ext}</span>
                  <span className="file-card-info">
                    <span className="file-card-name">{f.name}</span>
                    {f.size > 0 && <span className="file-card-size">{fmtSize(f.size)}</span>}
                  </span>
                </span>
              )
            })}
          </div>
        )}
        {m.media ? (
          // Anexos postos no meio do texto: cada {{midia:N}} vira o item no lugar.
          <InlineMediaText
            text={m.text}
            media={m.media}
            images={m.images}
            files={m.files}
            renderText={(t) => (resolveRef ? <CardRefText text={t} resolveRef={resolveRef} /> : t)}
          />
        ) : resolveRef ? (
          <CardRefText text={m.text} resolveRef={resolveRef} />
        ) : (
          m.text
        )}
      </div>
      {m.canceled && <div className="msg-canceled">⊘ Mensagem cancelada</div>}
      {m.injected && <div className="msg-injected">↳ ajuste enviado durante a tarefa</div>}
      {m.error && (
        <div className="msg-error">
          <span className="msg-error-text" title={m.error}>
            ⚠ Não foi enviada — {m.error}
          </span>
          {onRetry && (
            <button
              className="msg-retry"
              onClick={() => onRetry(m.id)}
              disabled={busy}
              title={busy ? 'Aguarde a tarefa atual terminar' : 'Reenviar esta mensagem'}
            >
              ↻ Tentar de novo
            </button>
          )}
        </div>
      )}
      {m.ts && <MessageTime ts={m.ts} />}
    </div>
  )
}

function AssistantRow({ m, ctx }: { m: AssistantMsg; ctx: ChatRowContext }): JSX.Element {
  const { resolveRef, lastTsId, tts, quote } = ctx
  const { clean, paths } = parseDownloads(m.text)
  const speaking = !!tts && tts.speakingId === m.id
  const listen = !!tts && !!m.answer && !!clean
  // Texto que chegou ao vivo: palavra a palavra (BlurText). O histórico entra pronto.
  const blur = useFreshOnce(m.id, 'text')
  return (
    <div className={`msg assistant ${m.answer ? '' : 'narration'} ${m.aborted ? 'aborted' : ''}`}>
      <div className="bubble">
        {clean && (
          <QuotableMessage api={quote} messageId={m.id} read={m.answer ? tts : null} source={clean}>
            <LazyMarkdown messageId={m.id} text={clean} resolveRef={resolveRef} blur={blur} />
          </QuotableMessage>
        )}
        {paths.map((p, k) => (
          <DownloadChip key={k} path={p} />
        ))}
        {(listen || (m.id === lastTsId && m.ts)) && (
          <div className="msg-foot">
            {listen && tts && (
              <button
                className={`msg-speak ${speaking ? 'active' : ''}`}
                onClick={() => tts.onToggleSpeak(m.id, clean)}
                title={speaking ? 'Parar leitura' : 'Ler em voz alta'}
              >
                {speaking ? <IconStopSmall size={14} /> : <IconSpeaker size={15} />}
                {speaking ? 'Parar' : 'Ouvir'}
              </button>
            )}
            {m.id === lastTsId && m.ts && <MessageTime ts={m.ts} />}
          </div>
        )}
        {m.aborted && (
          <div className="msg-aborted">Resposta interrompida pelo Stop — pode estar incompleta.</div>
        )}
      </div>
    </div>
  )
}

/** Id da resposta mais recente que tem hora de fim — só ela mostra a data (e, se for de hoje, o "há X"). */
export function lastAnswerTsId(messages: readonly UIMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind === 'assistant-text' && m.ts) return m.id
  }
  return null
}

/** Chave estável da linha (a mesma em qualquer lista). */
export function rowKey(m: UIMessage, idx: number): string {
  switch (m.kind) {
    case 'user':
      return `user:${m.id}`
    case 'assistant-text':
      return `assistant:${m.id}`
    case 'thinking':
      return `thinking:${m.id}`
    case 'tool-use':
      return `tool:${m.id}`
    case 'system':
      return `system:${m.sessionId}:${idx}`
    case 'provider-switch':
    case 'account-switch':
    case 'status':
    case 'error':
      return `${m.kind}:${m.id}`
    default:
      return `${m.kind}:${idx}`
  }
}

/** Uma mensagem do chat, como o chat mostra; null para o que o chat não desenha (result, eventos internos).
 *  Em memo: só re-renderiza quando a própria mensagem (`m`) ou o contexto (`ctx`) muda — o
 *  pedaço novo da resposta em andamento não redesenha o resto da conversa. Quem monta a
 *  lista mantém `ctx` estável (useMemo) e a mensagem inalterada com a mesma referência. */
export const ChatRow = memo(function ChatRow({ m, ctx }: { m: UIMessage; ctx: ChatRowContext }): JSX.Element | null {
  switch (m.kind) {
    case 'user':
      return <UserRow m={m} ctx={ctx} />
    case 'assistant-text':
      return <AssistantRow m={m} ctx={ctx} />
    case 'thinking':
      return (
        <div className="msg thinking">
          <div className="bubble">{m.text}</div>
        </div>
      )
    case 'tool-use': {
      // Planejamento: arquivo que o agente criou no plano ganha link logo abaixo.
      const created = createdPlanFile(m.name, m.input, m.result, ctx.planDir)
      if (!created) return <ToolCard m={m} check={ctx.inStep} />
      return (
        <Fragment>
          <ToolCard m={m} check={ctx.inStep} />
          <PlanFileLink path={created} />
        </Fragment>
      )
    }
    case 'system':
      // Sessão pronta: chips centralizados (modelo com o ponto verde, pasta em mono).
      return (
        <div className="msg system-note chat-chips" title={`Session ready · ${m.model} · ${m.cwd}`}>
          <span className="chat-chip">
            <span className="chat-chip-dot" aria-hidden="true" />
            <b>{modelDisplayName(m.model) || m.model}</b>
          </span>
          {m.cwd && <span className="chat-chip path">{m.cwd}</span>}
        </div>
      )
    case 'provider-switch':
    case 'status':
      return (
        <div className="msg system-note chat-chips">
          <span className="chat-chip" role="status">
            {m.text}
          </span>
        </div>
      )
    case 'account-switch':
      return <AccountSwitchNote event={m} onUseAccount={ctx.onUseAccount} />
    case 'result':
      // Not rendered: the answer is already in the chat and the cost is
      // shown in the token meter header.
      return null
    case 'error':
      return <div className="msg result-note err">{m.text}</div>
    default:
      return null
  }
})
