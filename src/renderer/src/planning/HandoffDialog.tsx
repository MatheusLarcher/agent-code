/**
 * "Enviar para implementação": o botão do cabeçalho da Tela de Planejamento e
 * o diálogo em três passos.
 *
 * 1. Conferir — bloqueios (ambiguidade aberta; só passa marcando "enviar mesmo
 *    assim") e avisos do plano aberto (handoffReadiness).
 * 2. Gerar — pede ao Agent Manager, pela conversa de planejamento (caminho
 *    normal de envio), que grave o(s) prompt(s) com plan_handoff_write, e
 *    espera arquivos NOVOS em _handoff/ criados depois do pedido (relista a
 *    cada planning:changed). Ou grava o rascunho automático (buildDraftHandoff).
 * 3. Revisar prompt(s) — cada um editável; o editado é gravado como arquivo
 *    novo em _handoff/ ANTES do envio (o _handoff guarda o que foi enviado),
 *    uma vez só: tentar de novo não regrava o que já está gravado.
 *    Enviar entrega os prompts ao App (`onSend`), que cria a conversa. Criada
 *    a conversa, o diálogo fecha mesmo se o envio falhar — enviar de novo por
 *    aqui criaria outra; o toast manda usar "Tentar de novo" na conversa nova.
 *
 * Falha de IPC vira toast 'erro'; nada aqui lança.
 */
import './handoff.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { OpenedPlanningDto, PlanningFailure, PlanningHandoffDto, PlanningResult } from '@shared/ipc'
import { IconSpinner, IconWarning } from '../components/Icons'
import { useUI } from '../ui/UiProvider'
import { handoffPartialMessage, managerHandoffRequest, newHandoffsSince, type HandoffSendOutcome } from './handoffFlow'
import { buildDraftHandoff, handoffReadiness } from './handoffReadiness'
import { useOpenedPlan } from './planningPlanContext'
import { isSamePlan } from './usePlanning'

export interface HandoffActions {
  projectCwd: string
  slug: string
  /** A conversa de planejamento está num turno (o Agent Manager trabalhando). */
  managerBusy: boolean
  /** Manda um texto ao Agent Manager pelo caminho normal de envio. */
  onAskManager: (text: string) => void
  /** Cria a conversa de implementação e envia os prompts na ordem (ver HandoffSendOutcome). */
  onSend: (prompts: string[], titulo: string) => Promise<HandoffSendOutcome>
}

export interface HandoffDialogProps extends HandoffActions {
  plan: OpenedPlanningDto
  onClose: () => void
}

type Step = 'review' | 'waiting' | 'prompts'

interface Draft {
  /** O arquivo em _handoff/ com o texto `saved`. */
  name: string
  /** O texto como veio (do Manager ou do rascunho automático): base do "editado". */
  original: string
  /** O último texto gravado em _handoff/: só o que difere dele é gravado de novo. */
  saved: string
  text: string
}

const draftOf = (name: string, content: string): Draft => ({ name, original: content, saved: content, text: content })

const STEPS: { id: Step; label: string }[] = [
  { id: 'review', label: 'Conferir' },
  { id: 'waiting', label: 'Gerar' },
  { id: 'prompts', label: 'Revisar prompt(s)' }
]

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function failureText(f: PlanningFailure): string {
  return 'message' in f ? f.message : 'conflito de versão'
}

/** IPC que rejeita vira falha 'io', não exceção. */
async function safe<T extends object>(call: () => Promise<PlanningResult<T>>): Promise<PlanningResult<T>> {
  try {
    const res = await call()
    if (res && typeof res === 'object' && 'ok' in res) return res
    return { ok: false, code: 'io', message: 'resposta inválida do processo principal' }
  } catch (err) {
    return { ok: false, code: 'io', message: errText(err) }
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim())?.replace(/^#+\s*/, '').trim() ?? ''
}

export function HandoffDialog(props: HandoffDialogProps): JSX.Element {
  const { projectCwd, slug, plan, managerBusy, onAskManager, onSend, onClose } = props
  const { notify } = useUI()
  const [step, setStep] = useState<Step>('review')
  const [override, setOverride] = useState(false)
  const [found, setFound] = useState<PlanningHandoffDto[]>([])
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [working, setWorking] = useState<null | 'ask' | 'draft' | 'send'>(null)
  // O pedido em espera; null = não está esperando (cancelado ou já revisando).
  const waitingRef = useRef<{ requestedAt: number; before: Set<string> } | null>(null)

  const { blockers, warnings } = useMemo(() => handoffReadiness(plan), [plan])
  const titulo = plan.roteiro.titulo.trim() || slug
  const blocked = blockers.length > 0 && !override

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Com prompts em edição, Esc não descarta o que foi digitado.
      if (e.key === 'Escape' && step !== 'prompts' && working !== 'send') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, step, working])

  const list = useCallback(async (): Promise<PlanningHandoffDto[] | null> => {
    const res = await safe(() => window.api.planningListHandoffs({ projectCwd, slug }))
    if (res.ok) return res.handoffs
    notify('erro', `Não consegui listar os prompts de _handoff/: ${failureText(res)}`)
    return null
  }, [projectCwd, slug, notify])

  const refresh = useCallback(async (): Promise<void> => {
    const waiting = waitingRef.current
    if (!waiting) return
    const all = await list()
    if (all && waitingRef.current === waiting) setFound(newHandoffsSince(all, waiting.before, waiting.requestedAt))
  }, [list])

  // Esperando: cada planning:changed deste plano (plan_handoff_write avisa) e
  // cada fim de turno do Manager relistam _handoff/.
  useEffect(() => {
    if (step !== 'waiting') return
    return window.api.onPlanningChanged((msg) => {
      if (isSamePlan(msg, projectCwd, slug)) void refresh()
    })
  }, [step, projectCwd, slug, refresh])

  useEffect(() => {
    if (step === 'waiting') void refresh()
  }, [step, managerBusy, refresh])

  const askManager = async (): Promise<void> => {
    setWorking('ask')
    const before = await list()
    setWorking(null)
    if (!before) return
    waitingRef.current = { requestedAt: Date.now(), before: new Set(before.map((h) => h.name)) }
    setFound([])
    setStep('waiting')
    onAskManager(managerHandoffRequest(slug, override ? blockers.length : 0))
  }

  const writeAutoDraft = async (): Promise<void> => {
    const conteudo = buildDraftHandoff(plan)
    setWorking('draft')
    const res = await safe(() => window.api.planningWriteHandoff({ projectCwd, slug, conteudo }))
    setWorking(null)
    if (!res.ok) {
      notify('erro', `Não consegui gravar o rascunho automático: ${failureText(res)}`)
      return
    }
    waitingRef.current = null
    setDrafts([draftOf(res.name, conteudo)])
    setStep('prompts')
  }

  const reviewFound = (): void => {
    waitingRef.current = null
    setDrafts(found.map((h) => draftOf(h.name, h.content)))
    setStep('prompts')
  }

  const cancelWaiting = (): void => {
    waitingRef.current = null
    setFound([])
    setStep('review')
  }

  const send = async (): Promise<void> => {
    if (drafts.length === 0 || drafts.some((d) => !d.text.trim())) return
    setWorking('send')
    // O _handoff/ guarda exatamente o que foi enviado: o editado vira arquivo
    // novo antes — uma vez. O que já foi gravado numa tentativa anterior (e não
    // mudou desde então) não é regravado.
    const written = new Map<number, { name: string; text: string }>()
    // `saved` = o último texto gravado; se o usuário digitou depois, difere e
    // a próxima tentativa grava de novo — só o que mudou.
    const commit = (): void =>
      setDrafts((all) =>
        all.map((x, i) => {
          const w = written.get(i)
          return w ? { ...x, name: w.name, saved: w.text } : x
        })
      )
    for (const [i, d] of drafts.entries()) {
      if (d.text === d.saved) continue
      const res = await safe(() => window.api.planningWriteHandoff({ projectCwd, slug, conteudo: d.text }))
      if (!res.ok) {
        commit()
        notify('erro', `Não consegui gravar o prompt editado (${d.name}): ${failureText(res)}. Nada foi enviado.`)
        setWorking(null)
        return
      }
      written.set(i, { name: res.name, text: d.text })
    }
    commit()
    const prompts = drafts.map((d) => d.text)
    let outcome: HandoffSendOutcome
    try {
      outcome = await onSend(prompts, titulo)
    } catch (err) {
      notify('erro', `Não consegui enviar para a implementação: ${errText(err)}`)
      setWorking(null)
      return
    }
    if (outcome.status === 'sent') {
      notify(
        'sucesso',
        prompts.length === 1
          ? `Plano enviado para implementação na conversa "Implementação: ${titulo}".`
          : `Plano enviado para implementação: 1º prompt enviado e ${prompts.length - 1} na fila da conversa nova.`
      )
      onClose()
    } else if (outcome.status === 'created-failed') {
      // A conversa existe: ficar aberto com "Enviar" habilitado criaria outra.
      notify('erro', handoffPartialMessage(titulo, outcome))
      onClose()
    } else {
      notify('erro', 'Nada foi enviado para a implementação: nenhum prompt com texto.')
      setWorking(null)
    }
  }

  const stepIndex = STEPS.findIndex((s) => s.id === step)

  return createPortal(
    <div className="modal-overlay pl-handoff-overlay">
      <div
        className={`modal-card pl-handoff-modal${step === 'prompts' ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pl-handoff-title"
      >
        <header className="pl-handoff-head">
          <span className="pl-handoff-eyebrow">Planejamento · {titulo}</span>
          <h3 className="modal-title" id="pl-handoff-title">
            Enviar para implementação
          </h3>
          <ol className="pl-handoff-steps" aria-label="Passos">
            {STEPS.map((s, i) => (
              <li key={s.id} className={i === stepIndex ? 'on' : i < stepIndex ? 'done' : ''} aria-current={i === stepIndex ? 'step' : undefined}>
                <span className="pl-handoff-step-n">{i + 1}</span>
                {s.label}
              </li>
            ))}
          </ol>
        </header>

        {step === 'review' && (
          <>
            <p className="modal-message">
              O plano vira o prompt de uma conversa <b>nova</b> de implementação neste projeto. Confira antes de gerar.
            </p>
            {blockers.length > 0 && (
              <section className="pl-handoff-issues block" aria-label="Bloqueios">
                <h4>
                  <IconWarning size={13} /> Bloqueia o envio
                </h4>
                <ul>
                  {blockers.map((i) => (
                    <li key={`${i.kind}:${i.ref}`}>{i.text}</li>
                  ))}
                </ul>
                <label className="pl-handoff-override">
                  <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
                  Enviar mesmo assim — as ambiguidades vão como pendentes de confirmação
                </label>
              </section>
            )}
            {warnings.length > 0 && (
              <section className="pl-handoff-issues warn" aria-label="Avisos">
                <h4>Avisos</h4>
                <ul>
                  {warnings.map((i) => (
                    <li key={`${i.kind}:${i.ref ?? ''}`}>{i.text}</li>
                  ))}
                </ul>
              </section>
            )}
            {blockers.length === 0 && warnings.length === 0 && (
              <div className="pl-handoff-ok" role="status">
                Tudo certo: nenhuma ambiguidade aberta, e todas as etapas estão concluídas e com cards.
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={onClose}>
                Cancelar
              </button>
              <span className="pl-handoff-spacer" />
              <button type="button" className="btn" disabled={blocked || working !== null} onClick={() => void writeAutoDraft()}>
                {working === 'draft' ? 'Gravando…' : 'Usar rascunho automático'}
              </button>
              <button type="button" className="btn primary" disabled={blocked || working !== null} onClick={() => void askManager()}>
                Pedir ao Agent Manager
              </button>
            </div>
          </>
        )}

        {step === 'waiting' && (
          <>
            <div className="pl-handoff-wait" role="status">
              {managerBusy && <IconSpinner className="spinner" size={15} />}
              <div>
                <strong>
                  {found.length === 0
                    ? 'Esperando o Agent Manager gravar o(s) prompt(s)…'
                    : found.length === 1
                      ? '1 prompt novo em _handoff/'
                      : `${found.length} prompts novos em _handoff/`}
                </strong>
                <span>
                  O pedido foi para a conversa de planejamento.{' '}
                  {managerBusy ? 'O Agent Manager está trabalhando.' : 'O Agent Manager não está num turno agora.'}
                </span>
              </div>
            </div>
            {found.length > 0 && (
              <ul className="pl-handoff-files">
                {found.map((h) => (
                  <li key={h.name}>
                    <code>_handoff/{h.name}</code>
                    <span>{firstLine(h.content)}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={cancelWaiting}>
                Cancelar
              </button>
              <span className="pl-handoff-spacer" />
              <button type="button" className="btn" disabled={working !== null} onClick={() => void writeAutoDraft()}>
                {working === 'draft' ? 'Gravando…' : 'Usar rascunho automático'}
              </button>
              <button type="button" className="btn primary" disabled={found.length === 0} onClick={reviewFound}>
                {found.length > 1 ? `Revisar ${found.length} prompts` : 'Revisar prompt'}
              </button>
            </div>
          </>
        )}

        {step === 'prompts' && (
          <>
            <p className="modal-message">
              É isto que a conversa de implementação vai receber{drafts.length > 1 ? ', um prompt por mensagem, na ordem' : ''}.
              Prompt editado é gravado como um arquivo novo em <code>_handoff/</code> antes do envio.
            </p>
            <div className="pl-handoff-prompts">
              {drafts.map((d, i) => (
                <section className="pl-handoff-prompt" key={d.name}>
                  <div className="pl-handoff-prompt-head">
                    <span className="pl-handoff-prompt-n">
                      Prompt {i + 1} de {drafts.length}
                    </span>
                    <code>{d.name}</code>
                    {d.text !== d.original && <span className="pl-handoff-badge">editado</span>}
                    {i > 0 && <span className="pl-handoff-queue">entra na fila</span>}
                  </div>
                  <textarea
                    aria-label={`Prompt ${i + 1}`}
                    value={d.text}
                    spellCheck={false}
                    rows={drafts.length > 1 ? 9 : 16}
                    onChange={(e) => {
                      const text = e.target.value
                      setDrafts((all) => all.map((x, j) => (j === i ? { ...x, text } : x)))
                    }}
                  />
                  {!d.text.trim() && <span className="pl-handoff-empty">Prompt vazio não é enviado — escreva algo ou volte.</span>}
                </section>
              ))}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn ghost" disabled={working === 'send'} onClick={() => setStep('review')}>
                Voltar
              </button>
              <span className="pl-handoff-spacer" />
              <button
                type="button"
                className="btn primary"
                disabled={working !== null || drafts.length === 0 || drafts.some((d) => !d.text.trim())}
                onClick={() => void send()}
              >
                {working === 'send' ? 'Enviando…' : 'Enviar para implementação'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}

/** O botão do cabeçalho: lê o plano aberto da Tela (useOpenedPlan) e abre o diálogo. */
export function HandoffButton(props: HandoffActions): JSX.Element {
  const plan = useOpenedPlan()
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <>
      <button
        type="button"
        className="btn primary small pl-handoff-btn"
        disabled={!plan}
        title="Conferir o plano e mandá-lo para uma conversa nova de implementação"
        onClick={() => setOpen(true)}
      >
        Enviar para implementação
      </button>
      {open && plan && <HandoffDialog {...props} plan={plan} onClose={close} />}
    </>
  )
}
