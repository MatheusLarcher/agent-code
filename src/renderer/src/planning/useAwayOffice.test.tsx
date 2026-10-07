import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { awayAnnounce } from '../office3d/board/awayAnnounce'
import type { AwaySummary } from './awaySummary'
import { useAwayOffice, type AwayVoiceApi } from './useAwayOffice'

/** O App publica a versão curta para o PO e lê em voz alta quando ele diz — só com a voz local instalada. */

const summary: AwaySummary = {
  projectKey: 'c:/proj',
  projectCwd: 'C:/proj',
  since: 1000,
  awayMs: 45 * 60_000,
  counts: { concluida: 2, espera: 0, falhou: 1 },
  entries: [{ kind: 'concluida', cardId: 'c1', conversationId: 'conv-1', title: 'A', detail: null, at: 2000 }]
}

function voice(installed: boolean): AwayVoiceApi {
  return { voiceComponentStatus: vi.fn(async () => ({ installed, installing: false })) } as unknown as AwayVoiceApi
}

afterEach(() => awayAnnounce.reset())

describe('useAwayOffice', () => {
  it('publica a versão curta e, quando o PO diz, lê em voz alta (voz instalada)', async () => {
    const speak = vi.fn()
    renderHook(() => useAwayOffice([summary], speak, voice(true)))
    expect(awayAnnounce.pending()).toEqual([{ id: 'c:/proj@1000', cwd: 'C:/proj', text: 'Desde que você saiu: 2 concluídas e 1 falhou.' }])
    awayAnnounce.markSaid(awayAnnounce.pending()[0])
    await waitFor(() => expect(speak).toHaveBeenCalledWith('away:c:/proj@1000', 'Desde que você saiu: 2 concluídas e 1 falhou.'))
  })

  it('voz não instalada: só o balão — nada de baixar o modelo sem ninguém pedir', async () => {
    const speak = vi.fn()
    const api = voice(false)
    renderHook(() => useAwayOffice([summary], speak, api))
    awayAnnounce.markSaid(awayAnnounce.pending()[0])
    await waitFor(() => expect(api.voiceComponentStatus).toHaveBeenCalledWith({ kind: 'tts' }))
    await Promise.resolve()
    expect(speak).not.toHaveBeenCalled()
  })

  it('o "ok" tira o resumo da fila do PO', () => {
    const view = renderHook(({ list }) => useAwayOffice(list, vi.fn(), voice(true)), { initialProps: { list: [summary] } })
    expect(awayAnnounce.pending()).toHaveLength(1)
    view.rerender({ list: [] })
    expect(awayAnnounce.pending()).toHaveLength(0)
  })
})
