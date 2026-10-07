import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentCodeApi } from '@shared/api'
import { AWAY_MIN_MS, buildAwaySummary, type AwaySummary } from './awaySummary'
import { awayProjectKey, loadSummaries, loadVisits, saveSummaries, saveVisit } from './awayVisits'

/**
 * Quem está À VISTA: o projeto da conversa aberta (com o quadro ao lado) ou a
 * sala do escritório onde a câmera está — sempre com a janela em foco. Enquanto
 * está, a última visita anda (a cada minuto e na saída). Ao voltar depois de
 * 30 min ou mais, lê o quadro e os envios do projeto e monta o resumo; ele fica
 * aberto (e gravado) até o "ok".
 */

export type AwayApi = Pick<AgentCodeApi, 'boardList' | 'handoffList'>

export interface AwaySummaries {
  /** O resumo aberto do projeto à vista, ou null. */
  current: AwaySummary | null
  /** Todos os abertos (o PO de cada projeto os diz no escritório). */
  all: AwaySummary[]
  /** O resumo aberto de um projeto qualquer (o escritório pergunta pela sala). */
  forCwd(cwd: string | null | undefined): AwaySummary | null
  dismiss(projectKey: string): void
}

/** De quanto em quanto a última visita anda enquanto o projeto está à vista. */
export const AWAY_TICK_MS = 60_000

function readFocused(): boolean {
  return typeof document !== 'undefined' && document.hasFocus() && !document.hidden
}

export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(readFocused)
  useEffect(() => {
    const update = (): void => setFocused(readFocused())
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])
  return focused
}

export function useAwaySummaries(
  presentCwd: string | null,
  api: AwayApi | null = (window as unknown as { api?: AwayApi }).api ?? null,
  clock: () => number = Date.now
): AwaySummaries {
  const [summaries, setSummaries] = useState<Record<string, AwaySummary>>(loadSummaries)
  const focused = useWindowFocused()
  const cwd = presentCwd && focused ? presentCwd : null
  const apiRef = useRef(api)
  apiRef.current = api
  const clockRef = useRef(clock)
  clockRef.current = clock
  const reading = useRef(new Set<string>())

  // Chegou (ou o tique do minuto): menos de 30 min desde a última visita só
  // anda a visita; 30 min ou mais lê o banco e monta o resumo. Sem banco
  // legível, a visita fica onde estava e o próximo tique tenta de novo.
  const check = useCallback((projectCwd: string, key: string): void => {
    const now = clockRef.current()
    const prev = loadVisits()[key]
    if (prev === undefined || now - prev < AWAY_MIN_MS) {
      saveVisit(key, now)
      return
    }
    const a = apiRef.current
    if (!a || typeof a.boardList !== 'function' || typeof a.handoffList !== 'function' || reading.current.has(key)) return
    reading.current.add(key)
    void Promise.all([
      Promise.resolve(a.boardList({ projectCwd })).catch(() => null),
      Promise.resolve(a.handoffList({ projectCwd })).catch(() => null)
    ])
      .then(([board, list]) => {
        const items = board?.available ? board.items : null
        const envios = list?.ok ? list.envios : null
        if (!items && !envios) return
        saveVisit(key, Math.max(now, loadVisits()[key] ?? 0))
        const summary = buildAwaySummary({ projectKey: key, projectCwd, items: items ?? [], envios: envios ?? [], since: prev, now })
        if (!summary) return
        setSummaries((m) => {
          const next = { ...m, [key]: summary }
          saveSummaries(next)
          return next
        })
      })
      .finally(() => reading.current.delete(key))
  }, [])

  useEffect(() => {
    if (!cwd) return
    const key = awayProjectKey(cwd)
    check(cwd, key)
    const t = setInterval(() => check(cwd, key), AWAY_TICK_MS)
    return () => {
      clearInterval(t)
      // Saiu: a visita vai até agora — menos se ela ficou parada 30 min ou mais
      // (o PC dormiu com a janela em foco): aí quem decide é a volta.
      const prev = loadVisits()[key]
      const now = clockRef.current()
      if (prev === undefined || now - prev < AWAY_MIN_MS) saveVisit(key, now)
    }
  }, [cwd, check])

  const dismiss = useCallback((key: string): void => {
    setSummaries((m) => {
      if (!m[key]) return m
      const next = { ...m }
      delete next[key]
      saveSummaries(next)
      return next
    })
  }, [])

  return useMemo<AwaySummaries>(() => {
    const forCwd = (dir: string | null | undefined): AwaySummary | null => (dir ? summaries[awayProjectKey(dir)] ?? null : null)
    return { current: forCwd(presentCwd), all: Object.values(summaries), forCwd, dismiss }
  }, [summaries, presentCwd, dismiss])
}
