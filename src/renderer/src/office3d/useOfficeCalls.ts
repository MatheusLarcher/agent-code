/**
 * Os chamados do agente fora do 3D (req-aviso-chamado): o selo da aba
 * Escritório (visível também da aba Conversa) e o que o main precisa saber.
 *
 *   - os abertos saem do feed do escritório (officeCalls.ts: mesmo com o filtro
 *     em outro projeto) e das marcas (abriu na TV, o arquivo sumiu);
 *   - a cada mudança, manda ao main (officeCallsState): os abertos, os que
 *     acabaram com o motivo (aberto / respondido / cancelado), se o usuário
 *     está olhando a sala de reunião (aba Escritório, janela em foco, sala à
 *     vista: aí não notifica) e o título de cada conversa (o nome no aviso);
 *   - a cada CHECK_MS confere se o HTML de cada chamado ainda existe: sumiu,
 *     o chamado é cancelado.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { OfficeCallEnd, OfficeCallResolved, OfficeCallsState } from '@shared/officeCall'
import type { MockupUrlResult } from '@shared/officeMockup'
import type { OfficeFeed } from '../office/adapter/feed'
import { isInOffice } from '../office/adapter/model'
import { callMarks, openCalls, type OfficeCall } from './officeCalls'
import { meetingInView } from './officeWatch'

/** De quanto em quanto tempo o arquivo de cada chamado é conferido (e o "olhando" relido). */
export const CHECK_MS = 15_000
const WATCH_MS = 2_000

interface CallsApi {
  officeCallsState?: (s: OfficeCallsState) => Promise<void>
  officeMockupUrl?: (req: { cwd: string; path: string }) => Promise<MockupUrlResult>
}
const api = (): CallsApi => (globalThis as { window?: { api?: CallsApi } }).window?.api ?? {}

/** Por que um chamado saiu da lista aberta. */
export function endReason(call: OfficeCall, open: readonly OfficeCall[], feed: OfficeFeed | null, now: number): OfficeCallEnd {
  const mark = callMarks.reason(call.id)
  if (mark) return mark
  // O mesmo agente chamou de novo: o antigo é cancelado (vale o último).
  if (open.some((c) => c.convId === call.convId)) return 'cancelado'
  const conv = feed?.conversations.find((c) => c.id === call.convId)
  // A conversa continua no escritório: saiu porque o usuário respondeu.
  return conv && isInOffice(conv, feed!, now) ? 'respondido' : 'cancelado'
}

export function useOfficeCalls(feed: OfficeFeed | null, officeActive: boolean): readonly OfficeCall[] {
  const [marks, setMarks] = useState(0)
  useEffect(() => callMarks.subscribe(() => setMarks((n) => n + 1)), [])
  const calls = useMemo(() => (feed ? openCalls(feed, Date.now(), (id) => callMarks.ended(id)) : []), [feed, marks])
  const prev = useRef<readonly OfficeCall[]>([])
  const sent = useRef('')
  const [watchTick, setWatchTick] = useState(0)

  // "Olhando a sala" muda sem feed (a câmera anda): relê a cada WATCH_MS com a aba aberta.
  useEffect(() => {
    if (!officeActive) return
    const t = setInterval(() => setWatchTick((n) => n + 1), WATCH_MS)
    return () => clearInterval(t)
  }, [officeActive])

  useEffect(() => {
    const now = Date.now()
    const ids = new Set(calls.map((c) => c.id))
    const ended: OfficeCallResolved[] = prev.current.filter((c) => !ids.has(c.id)).map((c) => ({ id: c.id, motivo: endReason(c, calls, feed, now) }))
    prev.current = calls
    const watching = officeActive && typeof document !== 'undefined' && document.hasFocus() && meetingInView()
    const titles: Record<string, string> = {}
    for (const c of feed?.conversations ?? []) if (c.title && isInOffice(c, feed!, now)) titles[c.id] = c.title
    const state: OfficeCallsState = { open: [...ids], ended, watching, titles }
    const sig = JSON.stringify({ ...state, ended: [] })
    if (!ended.length && sig === sent.current) return
    sent.current = sig
    void api().officeCallsState?.(state).catch(() => undefined)
  }, [calls, feed, officeActive, watchTick])

  // O HTML de cada chamado ainda existe? Sumiu: cancelado.
  useEffect(() => {
    if (!calls.length) return
    const check = (): void => {
      const url = api().officeMockupUrl
      if (!url) return
      for (const c of calls) {
        void url({ cwd: c.cwd, path: c.path })
          .then((r) => {
            if (!r.ok && /não existe/.test(r.error)) callMarks.end(c.id, 'cancelado')
          })
          .catch(() => undefined)
      }
    }
    check()
    const t = setInterval(check, CHECK_MS)
    return () => clearInterval(t)
  }, [calls])

  return calls
}
