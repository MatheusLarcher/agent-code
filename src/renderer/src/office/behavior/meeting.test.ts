import { describe, expect, it } from 'vitest'
import type { ComposerPresence } from '../../composerPresence'
import { createMeeting, DRAFT_MIN_MS, RETURN_MS, type MeetingInput } from './meeting'

const T = 1_000_000
const idle: ComposerPresence = { draftActiveSince: null, lastInputAt: null, micOn: false, sentAt: null, clearedAt: null }
const input = (p: Partial<ComposerPresence> = {}, over: Partial<MeetingInput> = {}): MeetingInput => ({
  presence: { ...idle, ...p },
  busy: false,
  toolInUse: false,
  pending: false,
  planning: false,
  ...over
})

describe('máquina de reunião', () => {
  it('sem sinal fica na mesa', () => {
    expect(createMeeting().evaluate('a', input(), T)).toEqual({ place: 'mesa', reason: null, recheckAt: null })
  })

  it('gatilho 1: rascunho só depois de ~1 s, com input recente', () => {
    const m = createMeeting()
    const early = m.evaluate('a', input({ draftActiveSince: T, lastInputAt: T }), T + 200)
    expect(early.place).toBe('mesa')
    expect(early.recheckAt).toBe(T + DRAFT_MIN_MS)
    const v = m.evaluate('a', input({ draftActiveSince: T, lastInputAt: T + 900 }), T + DRAFT_MIN_MS)
    expect(v).toMatchObject({ place: 'reuniao', reason: 'rascunho', recheckAt: T + 900 + RETURN_MS })
  })

  it('gatilho 1: microfone ligado leva na hora', () => {
    expect(createMeeting().evaluate('a', input({ micOn: true, lastInputAt: T }), T).reason).toBe('microfone')
  })

  it('rascunho ligado mas sem input há 8 s (trocou de conversa) volta à mesa', () => {
    const m = createMeeting()
    m.evaluate('a', input({ draftActiveSince: T, lastInputAt: T + 1500 }), T + 2000)
    expect(m.evaluate('a', input({ draftActiveSince: T, lastInputAt: T + 1500 }), T + 1500 + RETURN_MS).place).toBe('mesa')
  })

  it('gatilho 2: envio leva e segura enquanto o turno roda sem ferramenta', () => {
    const m = createMeeting()
    expect(m.evaluate('a', input({ sentAt: T }, { busy: true }), T).reason).toBe('envio')
    expect(m.evaluate('a', input({ sentAt: T }, { busy: true }), T + 60_000).place).toBe('reuniao')
  })

  it('volta quando o turno passa a usar ferramenta, e o mesmo envio não o chama de novo', () => {
    const m = createMeeting()
    m.evaluate('a', input({ sentAt: T }, { busy: true }), T)
    expect(m.evaluate('a', input({ sentAt: T }, { busy: true, toolInUse: true }), T + 500).place).toBe('mesa')
    expect(m.evaluate('a', input({ sentAt: T }, { busy: true }), T + 900).place).toBe('mesa')
  })

  it('apagou o rascunho sem enviar: fica ~8 s e volta', () => {
    const m = createMeeting()
    m.evaluate('a', input({ draftActiveSince: T, lastInputAt: T + 1200 }), T + 1200)
    const cleared = input({ draftActiveSince: null, lastInputAt: T + 2000, clearedAt: T + 2000 })
    expect(m.evaluate('a', cleared, T + 2000)).toMatchObject({ place: 'reuniao', reason: 'apagado', recheckAt: T + 2000 + RETURN_MS })
    expect(m.evaluate('a', cleared, T + 2000 + RETURN_MS - 1).place).toBe('reuniao')
    expect(m.evaluate('a', cleared, T + 2000 + RETURN_MS).place).toBe('mesa')
  })

  it('apagar sem ter ido à reunião não leva lá', () => {
    expect(createMeeting().evaluate('a', input({ clearedAt: T }), T + 10).place).toBe('mesa')
  })

  it('gatilho 3: pedido pendente segura lá, mesmo com ferramenta, até resolver', () => {
    const m = createMeeting()
    expect(m.evaluate('a', input({}, { pending: true, busy: true, toolInUse: true }), T).reason).toBe('pedido')
    expect(m.evaluate('a', input({}, { pending: true, busy: true }), T + 600_000).place).toBe('reuniao')
    expect(m.evaluate('a', input({}, { busy: true, toolInUse: true }), T + 600_001).place).toBe('mesa')
  })

  it('gatilho 4: planejamento ativo mantém o Gerente na reunião', () => {
    const m = createMeeting()
    expect(m.evaluate('p', input({}, { planning: true }), T).reason).toBe('planejamento')
    expect(m.evaluate('p', input({}, { planning: false }), T + 1).place).toBe('mesa')
  })

  it('cada conversa tem sua memória', () => {
    const m = createMeeting()
    m.evaluate('a', input({ sentAt: T }, { busy: true }), T)
    expect(m.evaluate('b', input({}, { busy: true }), T + 1).place).toBe('mesa')
  })
})
