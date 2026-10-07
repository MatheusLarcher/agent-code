/**
 * "Enviar para implementação": o botão do cabeçalho da Tela de Planejamento e
 * o diálogo em três passos.
 *
 * Os prompts de _handoff/ fora de _handoff/enviados.json estão "a enviar"
 * (pendingHandoffs). Com algum, o diálogo abre DIRETO no passo 3, com eles
 * carregados, e "Enviar" é o botão principal: nenhum clique único pede ao
 * Agent Manager para gerar de novo o que já existe.
 *
 * 1. Conferir — bloqueios (ambiguidade aberta; só passa marcando "enviar mesmo
 *    assim"), avisos, os prompts a enviar e os já enviados (com "Abrir conversa").
 * 2. Gerar — pede ao Agent Manager, pela conversa de planejamento, que grave o(s)
 *    prompt(s) com plan_handoff_write, e espera arquivos NOVOS em _handoff/
 *    (relista a cada planning:changed). Ou grava o rascunho automático.
 * 3. Revisar prompt(s) — editável; o editado vira arquivo novo em _handoff/
 *    antes do envio (o original fica "substituído por" ele em enviados.json),
 *    com as MESMAS etapas declaradas da original. Cada prompt mostra o total
 *    estimado das etapas dele pelo roteiro atual (handoffEstimate).
 *    `onSend` cria a conversa; os prompts ENTREGUES são registrados como
 *    enviados a ela. Criada, o diálogo fecha mesmo se o envio falhar.
 *
 * Esc/clique fora fecham sem perder nada (HandoffSession por plano). Falha de
 * IPC vira toast; nada aqui lança.
 */
import './handoff.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  OpenedPlanningDto,
  PlanningHandoffDto,
  PlanningHandoffSentDto,
  PlanningHandoffSentMark,
  PlanningResult
} from '@shared/ipc'
import { IconSpinner } from '../components/Icons'
import { useUI } from '../ui/UiProvider'
import {
  clearHandoffSession,
  deliveredMarks,
  errText,
  failureText,
  handoffPartialMessage,
  loadHandoffSession,
  managerHandoffRequest,
  newHandoffsSince,
  pendingHandoffs,
  safe,
  saveHandoffSession,
  type HandoffSendOutcome
} from './handoffFlow'
import { roteiroEtapaIds } from './handoffEstimate'
import { buildDraftHandoff, handoffReadiness } from './handoffReadiness'
import { StaleNotice, useStaleHandoffs } from './HandoffStale'
import {
  draftFrom,
  draftOf,
  HandoffHeader,
  PromptsStep,
  ReviewStep,
  WaitingStep,
  type Draft,
  type HandoffStep,
  type HandoffWork
} from './HandoffSteps'
import { useOpenedPlan } from './planningPlanContext'
import { isSamePlan } from './usePlanning'

export interface HandoffActions {
  projectCwd: string
  slug: string
  /** A conversa de planejamento está num turno (o Agent Manager trabalhando). */
  managerBusy: boolean
  /** Manda um texto ao Agent Manager pelo caminho normal de envio. */
  onAskManager: (text: string) => void
  /** Cria a conversa de implementação e envia os prompts na ordem (ver
   *  HandoffSendOutcome). `names`: o arquivo de _handoff/ de cada prompt. */
  onSend: (prompts: string[], titulo: string, names: string[]) => Promise<HandoffSendOutcome>
  /** A conversa ainda existe? Sem isso, todas contam como existentes. */
  conversationExists?: (id: string) => boolean
  /** Ativa a conversa no chat principal. */
  onOpenConversation?: (id: string) => void
}

export interface HandoffDialogProps extends HandoffActions {
  plan: OpenedPlanningDto
  onClose: () => void
}

type Step = HandoffStep

interface Listing {
  handoffs: PlanningHandoffDto[]
  sent: PlanningHandoffSentDto[]
  /** Os antigos não enviados (gravados antes da última mudança do plano). */
  stale: string[]
}

const everyConversation = (): boolean => true

export function HandoffDialog(props: HandoffDialogProps): JSX.Element {
  const { projectCwd, slug, plan, managerBusy, onAskManager, onSend, onClose } = props
  const conversationExists = props.conversationExists ?? everyConversation
  const { notify } = useUI()
  // Reaberto, o diálogo volta onde estava (pedido em espera, prompts editados).
  const [session] = useState(() => loadHandoffSession<Draft>(projectCwd, slug))
  const [step, setStep] = useState<Step>(session?.step ?? 'review')
  // Sem sessão, o passo inicial depende de haver pendentes: decidido na 1ª listagem.
  const [ready, setReady] = useState(session !== null)
  const [override, setOverride] = useState(false)
  const [found, setFound] = useState<PlanningHandoffDto[]>([])
  const [drafts, setDrafts] = useState<Draft[]>(session?.drafts ?? [])
  const [working, setWorking] = useState<HandoffWork>(null)
  // O pedido em espera; null = não está esperando (cancelado ou já revisando).
  const waitingRef = useRef<{ requestedAt: number; before: Set<string> } | null>(session?.waiting ?? null)
  // _handoff/ e enviados.json como estão no disco (a fonte da verdade).
  const [listing, setListing] = useState<Listing | null>(null)

  const { blockers, warnings } = useMemo(() => handoffReadiness(plan), [plan])
  const titulo = plan.roteiro.titulo.trim() || slug
  const blocked = blockers.length > 0 && !override
  const pending = useMemo(() => (listing ? pendingHandoffs(listing.handoffs, listing.sent) : []), [listing])
  const outside = pending.filter((h) => !drafts.some((d) => d.name === h.name))

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Fechar não descarta nada: o estado fica guardado por plano.
      if (e.key === 'Escape' && working !== 'send') onClose()
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

  // Guarda onde o diálogo está: fechá-lo não perde o pedido nem as edições.
  useEffect(() => {
    if (ready) saveHandoffSession(projectCwd, slug, { step, waiting: waitingRef.current, drafts })
  }, [projectCwd, slug, step, drafts, ready])

  // _handoff/ acompanha o disco (abrir, planning:changed, fim de turno); só vale
  // a resposta da busca mais recente — podem chegar fora de ordem.
  const seqRef = useRef(0)
  const warnedRef = useRef<string | null>(null)
  const reloadSaved = useCallback((): void => {
    const seq = ++seqRef.current
    void safe(() => window.api.planningListHandoffs({ projectCwd, slug })).then((res) => {
      if (seq !== seqRef.current) return
      if (!res.ok) {
        // Sem a lista não se sabe o que está a enviar: avisa, em vez de parecer vazio.
        notify('erro', `Não consegui listar os prompts de _handoff/: ${failureText(res)}`)
        setReady(true)
        return
      }
      if (res.sentError && warnedRef.current !== res.sentError) {
        warnedRef.current = res.sentError
        notify('aviso', `Ignorei _handoff/${res.sentError}: todos os prompts contam como a enviar.`)
      }
      setListing({ handoffs: res.handoffs, sent: res.sent ?? [], stale: res.stale ?? [] })
    })
  }, [projectCwd, slug, notify])

  useEffect(() => reloadSaved(), [reloadSaved, managerBusy])

  useEffect(
    () =>
      window.api.onPlanningChanged?.((msg) => {
        if (isSamePlan(msg, projectCwd, slug)) reloadSaved()
      }),
    [projectCwd, slug, reloadSaved]
  )

  // Os antigos (HandoffStale.tsx): não entram no envio sem o usuário incluí-los de propósito.
  const old = useStaleHandoffs({ projectCwd, slug, stale: listing?.stale, pending, outside, setDrafts, reload: reloadSaved })

  // Abertura direta: sem sessão guardada e com prompts a enviar, vai para a revisão
  // — só com os que não são antigos.
  useEffect(() => {
    if (ready || !listing) return
    const stale = new Set(listing.stale)
    const todo = pendingHandoffs(listing.handoffs, listing.sent).filter((h) => !stale.has(h.name))
    if (todo.length > 0) {
      setDrafts(todo.map(draftFrom))
      setStep('prompts')
    }
    setReady(true)
  }, [ready, listing])

  // Do "Conferir": retoma os prompts em revisão ou carrega os pendentes (sem os antigos).
  const reviewPending = (): void => {
    waitingRef.current = null
    if (drafts.length === 0) setDrafts(old.fresh(pending).map(draftFrom))
    setStep('prompts')
  }

  const mark = async (entries: PlanningHandoffSentMark[]): Promise<PlanningResult<{ sent: PlanningHandoffSentDto[] }>> => {
    const res = await safe(() => window.api.planningMarkHandoffsSent({ projectCwd, slug, entries }))
    if (res.ok) setListing((l) => (l ? { ...l, sent: res.sent } : l))
    return res
  }

  const markManual = async (name: string): Promise<void> => {
    setWorking('mark')
    const res = await mark([{ nome: name, marcadoManualmente: true }])
    setWorking(null)
    if (!res.ok) {
      notify('erro', `Não consegui marcar ${name} como já enviado: ${failureText(res)}`)
      return
    }
    removeDraft(name)
  }

  // "Tirar deste envio" (e o fim do "marcar"): só a revisão perde o prompt. Pela
  // lista ATUAL — o que foi digitado enquanto a marcação gravava não se perde.
  const removeDraft = (name: string): void => setDrafts((all) => all.filter((d) => d.name !== name))

  // Revisão sem nenhum prompt (todos tirados ou marcados) volta ao "Conferir" —
  // menos com antigos à disposição, para incluir de propósito.
  useEffect(() => {
    if (ready && step === 'prompts' && drafts.length === 0 && !old.staleOutside) setStep('review')
  }, [ready, step, drafts.length, old.staleOutside])

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
    saveHandoffSession(projectCwd, slug, { step: 'waiting', waiting: waitingRef.current, drafts }) // fechou no list(): reabre em "Gerar"
    setFound([])
    setStep('waiting')
    onAskManager(managerHandoffRequest(plan.dir, override ? blockers.length : 0, plan.media?.length ?? 0))
  }

  // O rascunho automático cobre o roteiro inteiro: declara todas as etapas. Com
  // prompts antigos, passa pela mesma conferência do plan_handoff_write.
  const writeAutoDraft = async (): Promise<void> => {
    await old.beforeDraft()
    const conteudo = buildDraftHandoff(plan)
    const etapas = roteiroEtapaIds(plan.roteiro.etapas)
    setWorking('draft')
    const res = await safe(() =>
      window.api.planningWriteHandoff({ projectCwd, slug, conteudo, ...(etapas.length ? { etapas } : {}) })
    )
    setWorking(null)
    if (!res.ok) {
      notify('erro', `Não consegui gravar o rascunho automático: ${failureText(res)}`)
      return
    }
    waitingRef.current = null
    setDrafts([draftOf(res.name, conteudo, etapas)])
    setStep('prompts')
    reloadSaved()
  }

  const reviewFound = (): void => {
    waitingRef.current = null
    setDrafts(found.map(draftFrom))
    setStep('prompts')
  }

  const cancelWaiting = (): void => {
    waitingRef.current = null
    setFound([])
    setStep('review')
  }

  const send = async (): Promise<void> => {
    if (blocked || drafts.length === 0 || drafts.some((d) => !d.text.trim())) return
    setWorking('send')
    // O _handoff/ guarda exatamente o que foi enviado: o editado vira arquivo
    // novo antes — uma vez. O que já foi gravado numa tentativa anterior (e não
    // mudou desde então) não é regravado.
    const written = new Map<number, { name: string; text: string }>()
    // `saved` = o último texto gravado; se o usuário digitou depois, difere e
    // a próxima tentativa grava de novo — só o que mudou.
    const commit = async (): Promise<void> => {
      setDrafts((all) =>
        all.map((x, i) => {
          const w = written.get(i)
          return w ? { ...x, name: w.name, saved: w.text } : x
        })
      )
      // O arquivo antigo deixa de estar "a enviar": o novo o substitui.
      const replaced = [...written].map(([i, w]) => ({ nome: drafts[i].name, substituidoPor: w.name }))
      if (replaced.length === 0) return
      const res = await mark(replaced)
      if (!res.ok) {
        notify(
          'aviso',
          `O prompt editado foi gravado, mas não consegui registrar em enviados.json que ele substitui o original (${failureText(res)}). ` +
            'O original pode voltar como "a enviar": use "Marcar como já enviado" nele.'
        )
      }
    }
    for (const [i, d] of drafts.entries()) {
      if (d.text === d.saved) continue
      // O editado herda as etapas da original (o registro no banco as lê do arquivo novo).
      const etapas = d.etapas?.length ? { etapas: d.etapas } : {}
      const res = await safe(() => window.api.planningWriteHandoff({ projectCwd, slug, conteudo: d.text, ...etapas }))
      if (!res.ok) {
        await commit()
        notify('erro', `Não consegui gravar o prompt editado (${d.name}): ${failureText(res)}. Nada foi enviado.`)
        setWorking(null)
        return
      }
      written.set(i, { name: res.name, text: d.text })
    }
    await commit()
    const prompts = drafts.map((d) => d.text)
    const names = drafts.map((d, i) => written.get(i)?.name ?? d.name)
    let outcome: HandoffSendOutcome
    try {
      outcome = await onSend(prompts, titulo, names)
    } catch (err) {
      notify('erro', `Não consegui enviar para a implementação: ${errText(err)}`)
      setWorking(null)
      return
    }
    if (outcome.status !== 'not-created') {
      clearHandoffSession(projectCwd, slug)
      // Só o que a conversa recebeu: no envio parcial, o resto continua a enviar.
      const marks = deliveredMarks(names, outcome)
      const res = marks.length > 0 ? await mark(marks) : null
      if (res && !res.ok) {
        notify(
          'erro',
          `Enviado, mas não consegui registrar o envio em _handoff/enviados.json: ${failureText(res)}. ` +
            'Marque esses prompts como já enviados para não mandá-los de novo.'
        )
      }
    }
    if (outcome.status === 'sent') {
      notify(
        'sucesso',
        outcome.queued
          ? `Plano enviado na conversa "Implementação: ${titulo}": ${outcome.queued === 1 ? 'o prompt sai' : `os ${outcome.queued} prompts saem`} pela fila do projeto, um por vez. A conversa mostra se ele espera a vez de outro plano ou a pasta limpa.`
          : prompts.length === 1
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

  const openConversation = (id: string): void => {
    onClose()
    props.onOpenConversation?.(id)
  }

  const hasPending = pending.length > 0 || drafts.length > 0
  const reviewCount = drafts.length > 0 ? drafts.length : pending.length

  return createPortal(
    <div
      className="modal-overlay pl-handoff-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && working !== 'send' && onClose()}
    >
      <div
        className={`modal-card pl-handoff-modal${step === 'prompts' && ready ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pl-handoff-title"
      >
        <HandoffHeader titulo={titulo} step={step} />

        {!ready && (
          <div className="pl-handoff-wait" role="status">
            <IconSpinner className="spinner" size={15} />
            <div>
              <strong>Lendo os prompts de _handoff/…</strong>
            </div>
          </div>
        )}

        {ready && step !== 'waiting' && (
          <StaleNotice count={old.count} disabled={working !== null} onDiscard={() => void old.discard()} />
        )}

        {ready && step === 'review' && (
          <ReviewStep
            managerBusy={managerBusy}
            blockers={blockers}
            warnings={warnings}
            override={override}
            onOverride={setOverride}
            pending={pending}
            stale={old.set}
            sent={listing?.sent ?? []}
            conversationExists={conversationExists}
            onOpenConversation={openConversation}
            working={working}
            hasPending={hasPending}
            reviewCount={reviewCount}
            onMarkSent={(n) => void markManual(n)}
            onClose={onClose}
            onAutoDraft={() => void writeAutoDraft()}
            onAskManager={() => void askManager()}
            onReviewPending={reviewPending}
          />
        )}

        {ready && step === 'waiting' && (
          <WaitingStep
            found={found}
            managerBusy={managerBusy}
            working={working}
            onCancel={cancelWaiting}
            onAutoDraft={() => void writeAutoDraft()}
            onReview={reviewFound}
          />
        )}

        {ready && step === 'prompts' && (
          <PromptsStep
            drafts={drafts}
            roteiro={plan.roteiro.etapas}
            outside={outside}
            stale={old.set}
            blockers={blockers}
            override={override}
            onOverride={setOverride}
            working={working}
            onText={(i, text) => setDrafts((all) => all.map((x, j) => (j === i ? { ...x, text } : x)))}
            onRemove={removeDraft}
            onMarkSent={(n) => void markManual(n)}
            onInclude={(h) => setDrafts((all) => [...all, draftFrom(h)])}
            onCheckPlan={() => setStep('review')}
            onAskManager={() => void askManager()}
            onSend={() => void send()}
          />
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
