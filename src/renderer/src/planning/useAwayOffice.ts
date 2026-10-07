import { useEffect, useRef } from 'react'
import type { AgentCodeApi } from '@shared/api'
import { awayAnnounce } from '../office3d/board/awayAnnounce'
import { awaySpeech, type AwaySummary } from './awaySummary'

/**
 * O resumo no ESCRITÓRIO: publica a versão curta de cada resumo aberto para o
 * PO do projeto dizer no balão (office3d/board/awayAnnounce.ts) e, quando ele
 * diz, lê em voz alta — só com a voz local já instalada. O app não tem um
 * liga/desliga da voz: instalada é ligada; sem ela, ler baixaria o modelo
 * (centenas de MB) sem ninguém pedir.
 */

export type AwayVoiceApi = Pick<AgentCodeApi, 'voiceComponentStatus'>

/** Um por resumo: o mesmo resumo não é dito duas vezes. */
export function awayAnnouncementId(summary: AwaySummary): string {
  return `${summary.projectKey}@${summary.since}`
}

export function useAwayOffice(
  summaries: readonly AwaySummary[],
  speak: (id: string, text: string) => void,
  api: AwayVoiceApi | null = (window as unknown as { api?: AwayVoiceApi }).api ?? null
): void {
  useEffect(() => {
    awayAnnounce.publish(summaries.map((s) => ({ id: awayAnnouncementId(s), cwd: s.projectCwd, text: awaySpeech(s) })))
  }, [summaries])

  const speakRef = useRef(speak)
  speakRef.current = speak
  const apiRef = useRef(api)
  apiRef.current = api
  useEffect(
    () =>
      awayAnnounce.onSaid((a) => {
        const status = apiRef.current?.voiceComponentStatus
        if (typeof status !== 'function') return
        void Promise.resolve(status({ kind: 'tts' }))
          .then((s) => {
            if (s?.installed && !s.installing) speakRef.current(`away:${a.id}`, a.text)
          })
          .catch(() => undefined)
      }),
    []
  )
}
