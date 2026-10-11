import { useMemo } from 'react'
import { modelDisplayName } from '@shared/modelLabel'
import type { UIMessage } from '../types'
import { useContextTurns } from '../office3d/codeScreen/useContextTurns'
import { contextBlocks, contextTotals, maskedText, kb } from '../office3d/codeScreen/contextView'
import { memoryTurnSegments } from './chatMemoryModel'
import './chatContext.css'

export function ChatContextDetails(props: { convId: string | null; messages: readonly UIMessage[] }): JSX.Element {
  return <ContextDetails key={props.convId ?? 'none'} {...props} />
}

function ContextDetails({ convId, messages }: { convId: string | null; messages: readonly UIMessage[] }): JSX.Element {
  const ctx = useContextTurns(convId, true)
  const blocks = useMemo(() => contextBlocks({ detail: ctx.detail, newer: ctx.newer }), [ctx.detail, ctx.newer])
  const usage = ctx.detail?.usage
  const totals = contextTotals(blocks, usage)
  const segments = useMemo(() => memoryTurnSegments(messages), [messages])
  const segment = segments.find((r) => ctx.selected && r.turnIds.includes(ctx.selected))?.messages
  const compaction = (segment ?? []).filter((m) => m.kind === 'status' && /compact/i.test(m.text))
  return <section className="chat-context-details" aria-label="Contexto detalhado">
    <header>
      <strong>Contexto recebido</strong>
      <span>Mesmo registro do escritório · somente este PC</span>
    </header>
    {ctx.loading && <p role="status">Lendo contexto…</p>}
    {ctx.error != null && <p role="alert">Não foi possível ler o contexto. <button type="button" onClick={ctx.reload}>Tentar novamente</button></p>}
    {ctx.unavailable && <p>Histórico de contexto indisponível neste dispositivo.</p>}
    {!ctx.loading && !ctx.error && !ctx.unavailable && !ctx.list.length && <p>Nenhum contexto gravado nesta conversa. Ele aparece a partir do próximo pedido.</p>}
    {!!ctx.list.length && <label>Turno <select aria-label="Turno do contexto" value={ctx.selected ?? ''} onChange={(e) => ctx.select(e.target.value)}>
      {ctx.list.map((t) => <option key={t.turnId} value={t.turnId}>{new Date(t.startedAt).toLocaleString('pt-BR')} · {t.request || 'Sem texto'}</option>)}
    </select></label>}
    {ctx.detail && <>
      <dl className="chat-context-meta">
        <dt>Estado</dt><dd>{ctx.detail.complete ? 'Registro completo' : 'Registro em andamento'}</dd>
        <dt>Modelo / origem</dt><dd>{modelDisplayName(ctx.detail.model) || 'Modelo não informado'} · {ctx.detail.provider} · {ctx.detail.pc}</dd>
        <dt>Tokens / janela</dt><dd>{usage ? `${usage.totalTokens.toLocaleString('pt-BR')} / ${usage.maxTokens.toLocaleString('pt-BR')} tokens` : `~${totals.tokens.toLocaleString('pt-BR')} tokens · Janela não informada`}</dd>
        <dt>Medição</dt><dd>{usage ? `${usage.detail === 'full' ? 'Detalhamento' : 'Resumo'} do SDK · ${new Date(usage.at).toLocaleString('pt-BR')}` : 'Estimativa dos blocos enviados (~4 bytes/token); o restante não foi medido.'}</dd>
        <dt>App enviou</dt><dd>{kb(totals.appBytes)} · {ctx.detail.blockCount} blocos</dd>
        <dt>Compactação</dt><dd>{compaction.length ? compaction.map((m) => m.kind === 'status' ? <p key={m.id}>{m.text}</p> : null) : 'Compactação não registrada neste turno; não significa que nunca ocorreu.'}</dd>
      </dl>
      {!!usage?.categories.length && <details><summary>Categorias medidas pelo SDK</summary><ul>{usage.categories.map((c, i) => <li key={i}>{c.name} · {c.kind} · {c.tokens.toLocaleString('pt-BR')} tokens</li>)}</ul></details>}
      <div className="chat-context-sources">
        {blocks.map((b) => <details key={b.id} open={b.title === 'Seu pedido'}>
          <summary>{b.title} <span>{b.measured ? '' : '~'}{b.tokens.toLocaleString('pt-BR')} tokens</span></summary>
          <p>{b.desc}</p>
          {b.note && <p>{b.note}</p>}
          {b.when != null && <p>Enviado às {new Date(b.when).toLocaleTimeString('pt-BR')}</p>}
          {b.list && <ul>{b.list.map(([name, tokens], i) => <li key={i}>{name} · {tokens.toLocaleString('pt-BR')} tokens</li>)}</ul>}
          {b.text != null && <pre>{maskedText(b.text)}</pre>}
        </details>)}
      </div>
      <p className="chat-context-foot">O app registra o que enviou; o motor informa o restante quando há medição. Catálogo não prova leitura de memórias. Segredos permanecem mascarados.</p>
    </>}
  </section>
}
