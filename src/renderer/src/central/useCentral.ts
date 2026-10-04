/**
 * A Central de ponta a ponta no renderer — o `CentralController` do contrato §E,
 * que a tela (Etapa 5) e o celular (Etapa 6) consomem:
 *
 * - envio: o pedido entra "routing" (centralSend.ts) e vai ao decisor; entrega
 *   pela mesma `dispatch` do composer (centralDelivery.ts);
 * - volta: o espelho, com throttle, escreve na Central os comentários, a resposta
 *   e a linha-resumo de cada turno ancorado (centralMirrorSync.ts);
 * - perguntas/permissões das conversas com turno em aberto, respondidas como no
 *   celular (`respondToPermission` do App);
 * - Emenda A1: todo turno que começa neste PC é adotado (centralAdoption.ts).
 *
 * Nunca: sobe sessão para a Central, entrega nela, copia cartões de ferramenta
 * ou guarda bytes de imagem no payload dela.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type {
  FileAttachment,
  FileRefAttachment,
  ImageAttachment,
  PermissionRequest,
  PermissionResponse
} from '@shared/ipc'
import { CENTRAL_ID, type CentralAnchor, type CentralEntry, type CentralRule } from '@shared/central'
import type { Conversation, UIMessage } from '../types'
import { useCentralSend, type CentralPayload, type CentralSendOrigin } from './centralSend'
import { deliverReply, findReplyQuote } from './centralReplyTo'

/** O envio da Central com o id (não a citação) da entrada respondida. */
export type CentralSendWithReply = (
  text: string,
  images: ImageAttachment[],
  thumbs: string[],
  files: FileAttachment[],
  fileRefs: FileRefAttachment[],
  origin?: CentralSendOrigin,
  replyTo?: string
) => Promise<boolean>
import { appendCentralEntry, centralAttachmentNames } from './centralRegistry'
import { hasActiveAnchor } from './centralEntries'
import { labelFor as buildLabel, type CentralLabel } from './centralRecents'
import { applyMirror, planMirror } from './centralMirrorSync'
import { turnToolUses } from './centralMirror'
import { answeredQuestionEntry, pendingConvIds } from './centralQuestions'
import {
  chooseOption,
  rescueEntry,
  routeEntry,
  type CentralDispatch,
  type CentralFlowDeps,
  type CentralQueueItem
} from './centralDelivery'
import { discardEntries, moveEntry } from './centralMove'
import { adoptTurn, type CentralAdopt } from './centralAdoption'

export type { CentralLabel } from './centralRecents'
export type { CentralAdopt, CentralTurnStart } from './centralAdoption'
export type { CentralDispatch, CentralQueueItem } from './centralDelivery'

/** Uma conversa trabalhando agora, no trilho do topo da Central. */
export interface CentralRailCard extends CentralLabel {
  convId: string
}

/** Pergunta/permissão pendente de um destino com turno em aberto. */
export interface CentralPendingQuestion {
  convId: string
  label: CentralLabel
  request: PermissionRequest
}

export interface CentralController {
  entries: CentralEntry[]
  /** Destinos trabalhando agora. */
  rail: CentralRailCard[]
  /** Perguntas/permissões vivas dos destinos ancorados. */
  pending: CentralPendingQuestion[]
  /** `replyTo`: id da entrada respondida (vai direto à conversa dela). */
  send(
    text: string,
    images: ImageAttachment[],
    thumbs: string[],
    files: FileAttachment[],
    fileRefs: FileRefAttachment[],
    replyTo?: string
  ): Promise<void>
  /** "Para onde vai?". */
  choose(entryId: string, optionIndex: number): Promise<void>
  /** "Não era aqui". */
  notHere(entryId: string): Promise<void>
  answer(convId: string, res: PermissionResponse): Promise<void>
  /** Abre o destino no turno (rolado até a âncora) e lembra que veio da Central. */
  openDestination(convId: string, msgId?: string): void
  /** Os cartões de ferramenta do turno, só leitura, lidos do destino (nunca copiados). */
  turnTools(anchor: CentralAnchor): UIMessage[]
  /** Projeto · conversa · cor · ícone. */
  labelFor(convId: string): CentralLabel
}

/** Throttle do espelho (início + fim da janela) sobre as mudanças de conversas/ocupado. */
export const MIRROR_THROTTLE_MS = 300

export interface UseCentralDeps {
  hydrated: boolean
  conversations: Conversation[]
  convsRef: MutableRefObject<Conversation[]>
  busyIds: ReadonlySet<string>
  busyRef: { readonly current: ReadonlySet<string> }
  queueRef: { readonly current: readonly CentralQueueItem[] }
  inflightRef: { readonly current: Readonly<Record<string, { msgId: string } | undefined>> }
  permissions: Readonly<Record<string, PermissionRequest>>
  /** `installationId` deste PC (dono das entradas que ele cria). */
  device: string | undefined
  sandboxRoot: string
  projectIcons: Readonly<Record<string, string | null>>
  typesafeReady: boolean
  needTypesafe: () => void
  /** A Central na tela (centralBoot.ts). */
  ensure: () => Promise<Conversation | null>
  patchConv: (id: string, fn: (c: Conversation) => Conversation) => void
  /** Põe na tela uma conversa lida do banco. */
  addLoaded: (conv: Conversation) => void
  loadByIds: (ids: string[]) => Promise<Conversation[]>
  /** "Nova conversa" normal na pasta, ao fundo. */
  createConversation: (cwd: string) => Conversation
  dispatch: CentralDispatch
  /** Tira o item da fila sem avisar a Central (quem tira é ela). */
  deleteQueued: (queueId: string) => void
  stopKeepingQueue: (convId: string) => void
  /** Tira do destino a bolha cujo envio falhou (e o "Tentar de novo" dela). */
  discardFailed: (convId: string, msgId: string) => void
  respondToPermission: (convId: string, res: PermissionResponse) => Promise<void>
  selectConversationAt: (id: string, msgId: string | null) => void
  notify: (kind: 'aviso' | 'erro', msg: string) => void
}

export interface UseCentralResult extends CentralController {
  /** O envio com a origem (o celular manda 'phone') e o id da entrada respondida. */
  sendToCentral: CentralSendWithReply
  /** A1: o App chama em cada bolha de usuário que nasce. */
  adopt: CentralAdopt
  /** Itens da fila (ou da conversa apagada) que saíram sem rodar: o App avisa por aqui. */
  dropped: (convId: string, msgIds: readonly string[]) => void
  /** A conversa tem turno vivo de um pedido da Central (as perguntas dela aparecem lá). */
  hasActiveAnchor: (convId: string) => boolean
  /** A conversa aberta pela Central (o "← Central" da Etapa 5). */
  openedFromCentral: string | null
}

const NO_ENTRIES: CentralEntry[] = []

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function useCentral(deps: UseCentralDeps): UseCentralResult {
  const depsRef = useRef(deps)
  depsRef.current = deps
  const moved = useRef(new Map<string, { rule?: CentralRule; confidence?: number }>())
  const generations = useRef(new Map<string, number>())
  // Pedidos com "escolher"/"não era aqui" em andamento: um clique duplo não entrega duas vezes.
  const working = useRef(new Set<string>())
  const relinkTried = useRef(new Set<string>())
  const [openedFromCentral, setOpenedFromCentral] = useState<string | null>(null)

  const route = (entryId: string, payload: CentralPayload): void => {
    // Resposta a uma mensagem: direto à conversa dela, sem o decisor.
    if (payload.replyTo) {
      void deliverReply(flow(), entryId, payload.replyTo).catch((err: unknown) => rescueEntry(flow(), entryId, err))
      return
    }
    const attachments = centralAttachmentNames(payload.images, payload.files, payload.fileRefs)
    void routeEntry(flow(), { entryId, text: payload.text, attachments }).catch((err: unknown) =>
      rescueEntry(flow(), entryId, err)
    )
  }
  const { send: rawSend, payloads } = useCentralSend({
    typesafeReady: deps.typesafeReady,
    needTypesafe: deps.needTypesafe,
    ensure: deps.ensure,
    patchConv: deps.patchConv,
    notifyError: (msg) => deps.notify('erro', msg),
    device: deps.device,
    route
  })

  const flow = useCallback((): CentralFlowDeps => {
    const d = depsRef.current
    return {
      device: d.device,
      convsRef: d.convsRef,
      busyRef: d.busyRef,
      queueRef: d.queueRef,
      inflightRef: d.inflightRef,
      payloads: payloads.current,
      moved: moved.current,
      generations: generations.current,
      sandboxRoot: d.sandboxRoot,
      patchConv: d.patchConv,
      addLoaded: d.addLoaded,
      loadByIds: d.loadByIds,
      createConversation: d.createConversation,
      dispatch: d.dispatch,
      deleteQueued: d.deleteQueued,
      stopKeepingQueue: d.stopKeepingQueue,
      discardFailed: d.discardFailed,
      notify: d.notify
    }
  }, [payloads])

  /** O turno da âncora está vivo agora neste PC: em voo, na fila ou esperando a recuperação automática. */
  const isLive = useCallback((a: CentralAnchor): boolean => {
    const d = depsRef.current
    if (d.inflightRef.current[a.convId]?.msgId === a.msgId) return true
    if (d.queueRef.current.some((q) => q.convId === a.convId && q.msgId === a.msgId)) return true
    return d.convsRef.current.find((c) => c.id === a.convId)?.recovery?.messageId === a.msgId
  }, [])

  /** Conversas lidas do banco por id entram na tela (fora dela, o próximo salvamento as apagaria). */
  const addFromStorage = useCallback((list: Conversation[], ids: readonly string[]): Conversation[] => {
    const d = depsRef.current
    const added: Conversation[] = []
    for (const conv of list) {
      if (!ids.includes(conv.id)) continue
      if (!d.convsRef.current.some((c) => c.id === conv.id)) {
        d.addLoaded(conv)
        d.convsRef.current = [conv, ...d.convsRef.current]
      }
      added.push(conv)
    }
    return added
  }, [])

  // ---- volta: o espelho ----
  const runMirror = useCallback((): void => {
    const d = depsRef.current
    const central = d.convsRef.current.find((c) => c.id === CENTRAL_ID)
    if (!central?.central) return
    const plan = planMirror({
      entries: central.central.entries,
      convs: new Map(d.convsRef.current.map((c) => [c.id, c])),
      busy: d.busyRef.current,
      self: d.device,
      now: Date.now()
    })
    // Depois de reiniciar: destino de turno em aberto fora da tela é lido por id, uma vez.
    const relink = plan.missing.filter((id) => !relinkTried.current.has(id))
    if (relink.length) {
      relink.forEach((id) => relinkTried.current.add(id))
      void d.loadByIds(relink).then((list) => addFromStorage(list, relink), () => undefined)
    }
    if (!plan.upserts.length && !plan.removals.length) return
    d.patchConv(CENTRAL_ID, (c) => ({ ...c, central: applyMirror(c.central, plan), updatedAt: Date.now() }))
  }, [addFromStorage])

  const mirrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mirrorPending = useRef(false)
  const scheduleMirror = useCallback((): void => {
    if (mirrorTimer.current) {
      mirrorPending.current = true
      return
    }
    runMirror()
    const tick = (): void => {
      if (!mirrorPending.current) {
        mirrorTimer.current = null
        return
      }
      mirrorPending.current = false
      runMirror()
      mirrorTimer.current = setTimeout(tick, MIRROR_THROTTLE_MS)
    }
    mirrorTimer.current = setTimeout(tick, MIRROR_THROTTLE_MS)
  }, [runMirror])
  useEffect(() => {
    if (deps.hydrated) scheduleMirror()
  }, [deps.hydrated, deps.conversations, deps.busyIds, scheduleMirror])
  useEffect(
    () => () => {
      if (mirrorTimer.current) clearTimeout(mirrorTimer.current)
      mirrorTimer.current = null
    },
    []
  )

  // ---- o que a tela lê ----
  const entries = deps.conversations.find((c) => c.id === CENTRAL_ID)?.central?.entries ?? NO_ENTRIES
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const convsMap = useMemo(() => new Map(deps.conversations.map((c) => [c.id, c])), [deps.conversations])
  const { projectIcons, sandboxRoot, busyIds, permissions } = deps
  const labelFor = useCallback(
    (convId: string): CentralLabel => buildLabel(convId, convsMap, entries, projectIcons, sandboxRoot),
    [convsMap, entries, projectIcons, sandboxRoot]
  )
  const rail = useMemo<CentralRailCard[]>(() => {
    const cards: CentralRailCard[] = []
    const seen = new Set<string>()
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (e.kind !== 'request' || !e.anchor || e.anchor.convId === CENTRAL_ID || seen.has(e.anchor.convId)) continue
      seen.add(e.anchor.convId)
      if (busyIds.has(e.anchor.convId)) cards.push({ convId: e.anchor.convId, ...labelFor(e.anchor.convId) })
    }
    return cards
  }, [entries, busyIds, labelFor])
  const pending = useMemo<CentralPendingQuestion[]>(
    () =>
      pendingConvIds(entries, permissions, isLive).map((convId) => ({ convId, label: labelFor(convId), request: permissions[convId] })),
    [entries, permissions, labelFor, isLive]
  )

  // ---- ações ----
  // `replyTo` = id da entrada respondida; não respondível (sem destino, de outro PC,
  // inexistente) → envio normal, pelo decisor.
  const sendToCentral = useCallback<CentralSendWithReply>(
    (text, images, thumbs, files, fileRefs, origin, replyTo) => {
      const quote = findReplyQuote(entriesRef.current, replyTo, depsRef.current.device) ?? undefined
      return rawSend(text, images, thumbs, files, fileRefs, origin, quote)
    },
    [rawSend]
  )
  const send = useCallback<CentralController['send']>(
    async (text, images, thumbs, files, fileRefs, replyTo) => {
      await sendToCentral(text, images, thumbs, files, fileRefs, 'composer', replyTo)
    },
    [sendToCentral]
  )
  const once = useCallback(
    async (entryId: string, job: () => Promise<void>): Promise<void> => {
      if (working.current.has(entryId)) return
      working.current.add(entryId)
      try {
        await job()
      } catch (err) {
        rescueEntry(flow(), entryId, err)
      } finally {
        working.current.delete(entryId)
      }
    },
    [flow]
  )
  const choose = useCallback(
    (entryId: string, optionIndex: number) => once(entryId, () => chooseOption(flow(), entryId, optionIndex)),
    [once, flow]
  )
  const notHere = useCallback((entryId: string) => once(entryId, () => moveEntry(flow(), entryId)), [once, flow])

  const answer = useCallback(async (convId: string, res: PermissionResponse): Promise<void> => {
    const d = depsRef.current
    const req = d.permissions[convId]
    try {
      await d.respondToPermission(convId, res)
    } catch (err) {
      d.notify('erro', `Não foi possível responder: ${errorText(err)}`)
      return
    }
    if (!req || req.id !== res.id) return
    const entry = answeredQuestionEntry(convId, req, res, d.device)
    d.patchConv(CENTRAL_ID, (c) => ({ ...c, central: appendCentralEntry(c.central, entry), updatedAt: entry.ts }))
  }, [])

  const openDestination = useCallback(
    (convId: string, msgId?: string): void => {
      const d = depsRef.current
      const open = (): void => {
        d.selectConversationAt(convId, msgId ?? null)
        setOpenedFromCentral(convId)
      }
      if (d.convsRef.current.some((c) => c.id === convId)) return open()
      void d.loadByIds([convId]).then(
        (list) => (addFromStorage(list, [convId]).length ? open() : d.notify('aviso', 'A conversa não existe mais.')),
        (err: unknown) => d.notify('erro', `Não foi possível abrir a conversa: ${errorText(err)}`)
      )
    },
    [addFromStorage]
  )

  const turnTools = useCallback(
    (anchor: CentralAnchor): UIMessage[] => {
      const dest = convsMap.get(anchor.convId)
      return dest ? turnToolUses(dest.messages, anchor.msgId) : []
    },
    [convsMap]
  )

  const adopt = useCallback<CentralAdopt>((turn) => {
    const d = depsRef.current
    adoptTurn({ device: d.device, sandboxRoot: d.sandboxRoot, ensure: d.ensure, patchConv: d.patchConv }, turn)
  }, [])
  const dropped = useCallback(
    (convId: string, msgIds: readonly string[]): void => {
      if (!msgIds.length) return
      void discardEntries(flow(), convId, msgIds).catch((err: unknown) =>
        depsRef.current.notify('erro', `A Central não conseguiu tratar a mensagem descartada: ${errorText(err)}`)
      )
    },
    [flow]
  )
  const activeAnchor = useCallback((convId: string) => hasActiveAnchor(entriesRef.current, convId, isLive), [isLive])

  return useMemo(
    () => ({
      entries,
      rail,
      pending,
      send,
      choose,
      notHere,
      answer,
      openDestination,
      turnTools,
      labelFor,
      sendToCentral,
      adopt,
      dropped,
      hasActiveAnchor: activeAnchor,
      openedFromCentral
    }),
    [entries, rail, pending, send, choose, notHere, answer, openDestination, turnTools, labelFor, sendToCentral, adopt, dropped, activeAnchor, openedFromCentral]
  )
}
