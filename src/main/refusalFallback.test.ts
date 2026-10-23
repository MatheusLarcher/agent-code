import { describe, expect, it } from 'vitest'
import {
  REFUSAL_BUBBLE_MEMORY,
  RefusalBubbleIndex,
  refusalFallbackEvents,
  refusalFallbackFrom,
  type RefusalContext
} from './refusalFallback'

/** No formato do `SDKModelRefusalFallbackMessage` (sdk.d.ts). */
const sdkFallback = (over: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'model_refusal_fallback',
  trigger: 'refusal',
  direction: 'retry',
  scope: 'session',
  original_model: 'claude-opus-5-5',
  fallback_model: 'claude-sonnet-5-5',
  request_id: 'req_1',
  retracted_message_uuids: ['u-texto', 'u-tool-result'],
  refused_user_message_uuid: 'u-user',
  content: 'texto do CLI',
  uuid: 'u-banner',
  session_id: 's',
  ...over
})

let seq = 0
const ctx = (bubbles: Record<string, string[]> = {}, over: Partial<RefusalContext> = {}): RefusalContext => ({
  bubblesOf: (uuid) => bubbles[uuid] ?? [],
  effort: 'high',
  fastMode: false,
  newId: () => `id-${++seq}`,
  ...over
})

describe('refusalFallbackFrom', () => {
  it('lê a troca da sessão; sem `scope` (CLI antigo) também é da sessão', () => {
    expect(refusalFallbackFrom(sdkFallback())).toEqual({
      scope: 'session',
      originalModel: 'claude-opus-5-5',
      fallbackModel: 'claude-sonnet-5-5',
      retracted: ['u-texto', 'u-tool-result']
    })
    const { scope: _omit, ...old } = sdkFallback()
    expect(refusalFallbackFrom(old)?.scope).toBe('session')
    expect(refusalFallbackFrom(sdkFallback({ scope: 'local' }))?.scope).toBe('local')
  })

  it('sem os dois modelos ou de outro subtipo não vale; uuids inválidos ficam de fora', () => {
    expect(refusalFallbackFrom(sdkFallback({ fallback_model: '' }))).toBeNull()
    expect(refusalFallbackFrom(sdkFallback({ original_model: 7 }))).toBeNull()
    expect(refusalFallbackFrom({ ...sdkFallback(), subtype: 'model_refusal_no_fallback' })).toBeNull()
    expect(refusalFallbackFrom(null)).toBeNull()
    expect(refusalFallbackFrom(sdkFallback({ retracted_message_uuids: ['ok', '', 3, null] }))?.retracted).toEqual(['ok'])
    expect(refusalFallbackFrom(sdkFallback({ retracted_message_uuids: undefined }))?.retracted).toEqual([])
  })
})

describe('refusalFallbackEvents', () => {
  it('sessão: a bolha conhecida é reescrita no mesmo id e a troca leva esforço e Rápido atuais', () => {
    const r = refusalFallbackFrom(sdkFallback())!
    const events = refusalFallbackEvents(r, ctx({ 'u-texto': ['msg_1'] }, { effort: 'max', fastMode: true }))
    expect(events).toEqual([
      { kind: 'assistant-text', id: 'msg_1', text: '_Resposta recusada pelo Opus 5.5 e refeita no Sonnet 5.5._', final: true },
      {
        kind: 'provider-switch',
        id: expect.any(String),
        fromModel: 'claude-opus-5-5',
        model: 'claude-sonnet-5-5',
        effort: 'max',
        fastMode: true,
        text: 'O Opus 5.5 recusou; a conversa seguiu no Sonnet 5.5.'
      }
    ])
  })

  it('local: só a linha do subagente, sem troca de modelo', () => {
    const r = refusalFallbackFrom(sdkFallback({ scope: 'local', retracted_message_uuids: [] }))!
    expect(refusalFallbackEvents(r, ctx())).toEqual([
      { kind: 'status', id: expect.any(String), text: 'Um subagente teve a resposta recusada pelo Opus 5.5; refeita no Sonnet 5.5.' }
    ])
  })

  it('modelo fora das listas aparece pelo id; sem esforço, o campo não vai', () => {
    const r = refusalFallbackFrom(sdkFallback({ original_model: 'modelo-x', retracted_message_uuids: [] }))!
    const [swap] = refusalFallbackEvents(r, ctx({}, { effort: undefined }))
    expect(swap).toMatchObject({ kind: 'provider-switch', text: 'O modelo-x recusou; a conversa seguiu no Sonnet 5.5.' })
    expect(swap).not.toHaveProperty('effort')
  })
})

describe('RefusalBubbleIndex', () => {
  it('guarda as últimas 50 respostas e entrega cada uma uma vez só', () => {
    const index = new RefusalBubbleIndex()
    for (let i = 0; i <= REFUSAL_BUBBLE_MEMORY; i++) index.remember(`u${i}`, [`b${i}`])
    expect(index.take('u0')).toEqual([])
    expect(index.take('u1')).toEqual(['b1'])
    expect(index.take('u1')).toEqual([])
    expect(index.take(`u${REFUSAL_BUBBLE_MEMORY}`)).toEqual([`b${REFUSAL_BUBBLE_MEMORY}`])
  })

  it('resposta sem bolha de texto ou sem uuid não ocupa lugar', () => {
    const index = new RefusalBubbleIndex(1)
    index.remember('u-a', ['a'])
    index.remember('u-tool', [])
    index.remember(undefined, ['x'])
    expect(index.take('u-a')).toEqual(['a'])
  })
})
