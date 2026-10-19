/**
 * "Enviar para implementação" no celular, com a mesma conferência do PC
 * (renderer/planning/HandoffDialog): ambiguidade aberta bloqueia até marcar
 * "enviar mesmo assim"; sem prompt a enviar, "Gerar prompts" pede ao Agent
 * Manager o mesmo pedido do PC e a folha espera os arquivos novos (cada
 * planning-changed relê o plano); com pendentes, a lista (título + estimativa,
 * toque abre o texto só leitura) e "Enviar", que no PC roda o MESMO envio. Os
 * antigos (de antes da última mudança do plano) não entram: "Descartar os
 * antigos" pergunta antes, num modal próprio. Editar o texto fica no PC.
 */
import { useEffect, useState } from 'react'
import { handoffEstimate, handoffEstimateLabel } from '@renderer/planning/handoffEstimate'
import { client, openConversation, toast } from '../app/runtime'
import { discardOldHandoffs, generateHandoff, sendHandoff, toPlanningError } from '../core/planning'
import { useStore } from '../core/store'
import { BACK, useBackHandler } from '../shell/backButton'
import { Icon } from '../ui/icons'
import { handoffTitle, isOpenAmbiguity } from './planModel'
import { closeHandoff, loadPlan, managerConv, noteHandoffSent, planUi } from './planState'

type Work = 'send' | 'generate' | 'discard' | null

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many.replace('#', String(n)))

function DiscardConfirm({ count, busy, onCancel, onConfirm }: { count: number; busy: boolean; onCancel: () => void; onConfirm: () => void }): JSX.Element {
  return (
    <div className="modal-overlay pl-confirm-overlay" onClick={onCancel}>
      <div className="modal-card pl-confirm" role="alertdialog" aria-label="Descartar os prompts antigos?" onClick={(e) => e.stopPropagation()}>
        <strong className="pl-sheet-title">Descartar os prompts antigos?</strong>
        <p className="pl-hint">
          {plural(count, 'O prompt antigo vai', 'Os # prompts antigos vão')} para _handoff/_descartados/: sai do envio, mas o arquivo continua no
          disco do PC. Prompt já enviado não sai.
        </p>
        <div className="pl-confirm-actions">
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Manter</button>
          <button type="button" className="btn danger" onClick={onConfirm} disabled={busy}>
            {busy ? <span className="spinner" /> : <Icon name="trash" size={16} />} Descartar os antigos
          </button>
        </div>
      </div>
    </div>
  )
}

export function HandoffSheet(): JSX.Element | null {
  const open = useStore(planUi, (s) => s.open)
  const plan = useStore(planUi, (s) => s.plan)
  const justSent = useStore(planUi, (s) => s.justSent)
  const manager = useStore(client.store, (s) => managerConv(s.conversations, open))
  const conversations = useStore(client.store, (s) => s.conversations)
  const [override, setOverride] = useState(false)
  // Pedido ao Manager em espera: os nomes que já existiam antes dele.
  const [waiting, setWaiting] = useState<string[] | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [working, setWorking] = useState<Work>(null)
  const [oldPc, setOldPc] = useState(false)

  // O de cima fecha primeiro: a pergunta, o texto aberto e, por fim, a folha.
  const back = (): void => {
    if (confirming) {
      if (working !== 'discard') setConfirming(false)
    } else if (viewing) setViewing(null)
    else if (working !== 'send') closeHandoff()
  }
  useBackHandler(BACK.modal, back)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') back()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const handoffs = plan?.handoffs
  const hidden = new Set(justSent)
  const pendentes = (handoffs?.pendentes ?? []).filter((h) => !hidden.has(h.name))
  const fresh = pendentes.filter((h) => !h.antigo)
  const old = pendentes.filter((h) => h.antigo)
  const arrived = waiting ? fresh.filter((h) => !waiting.includes(h.name)).length : 0

  // Chegou prompt novo do Manager: a espera acaba e a lista aparece.
  useEffect(() => {
    if (waiting && arrived > 0) setWaiting(null)
  }, [waiting, arrived])

  if (!open || !plan) return null
  const blockers = plan.cards.filter(isOpenAmbiguity)
  const blocked = blockers.length > 0 && !override

  const run = async (kind: Exclude<Work, null>, fn: () => Promise<void>): Promise<void> => {
    setWorking(kind)
    try {
      await fn()
    } catch (e) {
      const err = toPlanningError(e)
      if (err.kind === 'old-pc') setOldPc(true)
      else toast(err.message, 'erro')
    } finally {
      setWorking(null)
    }
  }

  const send = (): Promise<void> =>
    run('send', async () => {
      const names = fresh.map((h) => h.name)
      await sendHandoff(client, open.cwd, open.slug, names, override)
      toast('Enviado: o PC cria a conversa de implementação e solta os prompts pela fila do projeto.', 'sucesso')
      noteHandoffSent(names)
    })

  const generate = (): Promise<void> =>
    run('generate', async () => {
      const before = pendentes.map((h) => h.name)
      await generateHandoff(client, open.cwd, open.slug, override)
      setWaiting(before)
    })

  const discard = (): Promise<void> =>
    run('discard', async () => {
      const moved = await discardOldHandoffs(client, open.cwd, open.slug)
      setConfirming(false)
      toast(moved.length ? `${plural(moved.length, '1 prompt antigo foi', '# prompts antigos foram')} para _handoff/_descartados/.` : 'Nenhum prompt antigo para descartar.', 'sucesso')
      void loadPlan(true)
    })

  const shown = viewing ? pendentes.find((h) => h.name === viewing) : undefined
  const body = (): JSX.Element => {
    if (oldPc || !handoffs) {
      return (
        <div className="empty-state pl-oldpc">
          <strong>Atualize o app do PC</strong>
          O PC conectado ainda não envia planos para a implementação pelo celular. Atualize o app do PC ou envie por lá.
        </div>
      )
    }
    if (shown) {
      return (
        <>
          <button type="button" className="pl-more" onClick={() => setViewing(null)}>
            <Icon name="back" size={16} /> Voltar à lista
          </button>
          <pre className="pl-handoff-text">{shown.content}</pre>
        </>
      )
    }
    return (
      <>
        {handoffs.erro && <p className="pl-row-err">Não consegui ler os prompts no PC: {handoffs.erro}</p>}
        {blockers.length > 0 && (
          <section className="pl-handoff-block" aria-label="Ambiguidades abertas">
            <strong>{plural(blockers.length, '1 ambiguidade aberta', '# ambiguidades abertas')}</strong>
            <ul>{blockers.map((c) => <li key={c.id}>{c.titulo}</li>)}</ul>
            <label className="pl-check">
              <input type="checkbox" checked={override} onChange={(e) => setOverride(e.currentTarget.checked)} />
              <span>Enviar mesmo assim (o Manager diz qual leitura seguir em cada prompt)</span>
            </label>
          </section>
        )}
        {old.length > 0 && (
          <section className="pl-handoff-old" aria-label="Prompts antigos">
            <span>{plural(old.length, '1 prompt antigo', '# prompts antigos')}, de antes da última mudança do plano: não entram no envio.</span>
            <button type="button" className="btn ghost" disabled={working !== null} onClick={() => setConfirming(true)}>
              Descartar os antigos
            </button>
          </section>
        )}
        {waiting ? (
          <div className="pl-handoff-wait" role="status">
            <span className="spinner" /> Pedi os prompts ao Agent Manager. Eles aparecem aqui assim que ele gravar.
          </div>
        ) : fresh.length > 0 ? (
          <div className="pl-handoff-list">
            <span className="pl-sheet-label">{plural(fresh.length, '1 prompt a enviar', '# prompts a enviar')}</span>
            {fresh.map((h) => (
              <button key={h.name} type="button" className="pl-row" onClick={() => setViewing(h.name)}>
                <span className="pl-row-title">{handoffTitle(h.content, h.name)}</span>
                <span className="pl-row-meta">{handoffEstimateLabel(handoffEstimate(h.etapas, plan.roteiro.etapas))}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="pl-hint">Nenhum prompt a enviar. “Gerar prompts” pede ao Agent Manager que escreva o handoff deste plano.</p>
        )}
        {handoffs.enviados.length > 0 && (
          <div className="pl-handoff-list">
            <span className="pl-sheet-label">Já enviados</span>
            {handoffs.enviados.map((e) => {
              const exists = conversations.some((c) => c.id === e.conversaId)
              return (
                <div key={e.nome} className="pl-handoff-sent">
                  <span>{e.conversaTitulo || e.nome}</span>
                  {exists && (
                    <button type="button" className="pl-more" onClick={() => { closeHandoff(); openConversation(e.conversaId) }}>
                      <Icon name="open" size={15} /> Abrir
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </>
    )
  }

  const canAct = !!handoffs && !oldPc && !shown
  return (
    <>
    <div className="modal-overlay" onClick={() => working !== 'send' && closeHandoff()}>
      <div className="modal-card pl-sheet pl-handoff-sheet" role="dialog" aria-label="Enviar para implementação" onClick={(e) => e.stopPropagation()}>
        <div className="pl-sheet-head">
          <strong className="pl-sheet-title">Enviar para implementação</strong>
          <button type="button" className="icon-btn pl-sheet-x" aria-label="Fechar" onClick={closeHandoff} disabled={working === 'send'}>
            <Icon name="x" size={20} />
          </button>
        </div>
        <div className="pl-sheet-body">{body()}</div>
        {canAct && (
          <div className="pl-sheet-actions">
            {fresh.length > 0 && !waiting ? (
              <button type="button" className="btn primary big" disabled={blocked || working !== null} onClick={() => void send()}>
                {working === 'send' ? <span className="spinner" /> : <Icon name="rocket" size={18} />} Enviar {fresh.length > 1 ? `(${fresh.length})` : ''}
              </button>
            ) : (
              <button type="button" className="btn primary big" disabled={blocked || working !== null || !!waiting || !manager} onClick={() => void generate()}>
                {working === 'generate' || waiting ? <span className="spinner" /> : <Icon name="spark" size={18} />} Gerar prompts
              </button>
            )}
          </div>
        )}
      </div>
    </div>
    {confirming && (
      <DiscardConfirm count={old.length} busy={working === 'discard'} onCancel={() => working !== 'discard' && setConfirming(false)} onConfirm={() => void discard()} />
    )}
    </>
  )
}
