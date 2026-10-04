/**
 * O foco DENTRO da TV no Office3DWorkspace (dec-clique-tv): o que estava na tela
 * no clique (congelado enquanto o foco dura), o chamado que acaba ao abrir o
 * mockup, o plano em foco virando a conversa ativa (o chat do Manager dentro
 * da TV é o dele) e as abas de plano, o envio do Aprovar / Pedir ajuste e o
 * clique na notificação de um chamado (filtro no projeto, câmera na TV). A TV
 * vazia (o placar) não abre foco: abre o "📋 Planejar" (`onEmptyTv`); o plano
 * criado entra na TV assim que chega ao escritório (`focusPlan`).
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { Office3DEngine } from './engine'
import { tvLookPose } from './engineTv'
import { PROJECTOR_KEY } from './engineTypes'
import { OFFICE_ID } from './layout'
import { callMarks } from './officeCalls'
import type { TvFocusInfo } from './projectors'

interface Options {
  engineRef: MutableRefObject<Office3DEngine | null>
  active: boolean
  /** A conversa ativa. */
  convId: string | null
  openConversation: (convId: string) => void
  onSendToConversation?: (convId: string, text: string) => void
  callSignal?: { n: number; projectId: string | null }
  /** Clique na TV vazia (o placar): o formulário do planejamento. */
  onEmptyTv?: () => void
}

export interface TvFocusState {
  tvInfo: TvFocusInfo | null
  /** No onFocus do motor: trava a TV e lê o que ela mostra; true se o foco é a TV. */
  onFocus: (key: string | null) => boolean
  pickPlan: (convId: string) => void
  sendFromTv: ((convId: string, text: string) => void) | undefined
  reset: () => void
  /** O plano recém-criado: quando ele aparece no escritório, a TV abre nele. */
  focusPlan: (convId: string) => void
}

export function useTvFocus({ engineRef, active, convId, openConversation, onSendToConversation, callSignal, onEmptyTv }: Options): TvFocusState {
  const empty = useRef(onEmptyTv)
  empty.current = onEmptyTv
  const [tvInfo, setTvInfo] = useState<TvFocusInfo | null>(null)
  const open = useRef(openConversation)
  open.current = openConversation

  const onFocus = useCallback(
    (key: string | null): boolean => {
      const projectors = engineRef.current?.scene.projectors
      const tv = !!key?.startsWith(PROJECTOR_KEY)
      projectors?.lock(tv)
      const info = tv ? (projectors?.focusInfo() ?? null) : null
      if (info?.kind === 'score' && empty.current) {
        // A TV vazia: o formulário do planejamento, sem foco (a câmera fica de frente para a TV).
        const open = empty.current
        queueMicrotask(() => {
          engineRef.current?.leaveFocus(false)
          open()
        })
        return true
      }
      setTvInfo(info)
      // Abrir o mockup de quem chama encerra o chamado (ele foi visto).
      if (info?.kind === 'mockup' && info.callId) callMarks.end(info.callId, 'aberto')
      return tv
    },
    [engineRef]
  )

  // O plano em foco vira a conversa ativa: o chat do Manager dentro da TV é o dele.
  const planConv = tvInfo?.kind === 'plan' ? tvInfo.convId : null
  useEffect(() => {
    if (planConv && active && planConv !== convId) open.current(planConv)
  }, [planConv, active, convId])

  const pickPlan = useCallback(
    (id: string): void => {
      const p = engineRef.current?.scene.projectors
      if (p) p.content.plans.prefer = id
      setTvInfo((cur) => (cur?.kind === 'plan' ? { ...cur, convId: id } : cur))
    },
    [engineRef]
  )

  // Aprovar / Pedir ajuste: o texto vai para a conversa do agente e o foco fecha (ele volta à mesa).
  const send = useCallback(
    (id: string, text: string): void => {
      onSendToConversation?.(id, text)
      engineRef.current?.leaveFocus(true, true)
    },
    [engineRef, onSendToConversation]
  )

  // Clique na notificação de um chamado (o App já abriu a aba): o filtro no projeto dele e a câmera na TV.
  const seenCall = useRef(callSignal?.n ?? 0)
  useEffect(() => {
    const engine = engineRef.current
    if (!callSignal || callSignal.n === seenCall.current || !active || !engine) return
    seenCall.current = callSignal.n
    engine.setProjectFilter(callSignal.projectId)
    const to = tvLookPose(engine.scene, { fovDeg: engine.camera.fov, aspect: engine.camera.aspect })
    if (to) engine.flyToPose(to)
  }, [callSignal, active, engineRef])

  const reset = useCallback(() => setTvInfo(null), [])

  // O plano criado pelo "📋 Planejar": espera ele chegar ao escritório (o feed) e abre a TV nele.
  const focusPlan = useCallback(
    (id: string): void => {
      let tries = 0
      const attempt = (): void => {
        const engine = engineRef.current
        const plans = engine?.scene.projectors.content.plans
        if (engine && plans?.all(() => true).some((p) => p.convId === id)) {
          plans.prefer = id
          engine.scene.projectors.tick(Date.now())
          engine.focus(`${PROJECTOR_KEY}${OFFICE_ID}`)
        } else if (++tries < 25) setTimeout(attempt, 200)
      }
      attempt()
    },
    [engineRef]
  )
  return { tvInfo, onFocus, pickPlan, sendFromTv: onSendToConversation ? send : undefined, reset, focusPlan }
}
