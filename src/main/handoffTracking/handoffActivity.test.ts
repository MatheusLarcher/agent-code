// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { BOOT_GRACE_MS, conversationLastWriteMs, inBootGrace, lastActivityMs, stallReason } from './handoffActivity'
import { BOOT_GRACE_MS as SWEEP_BOOT_GRACE_MS } from './handoffTrackerSweep'
import { turnStartedAfterDispatch } from './handoffRules'
import { envio, iso, T0 } from './handoffTestKit'

/**
 * O sinal de vida numa fonte só (handoffActivity.ts): a varredura e a fila do
 * projeto leem a mesma atividade e a mesma carência do boot — e desfazer um
 * despacho só cabe sem turno começado depois da marca.
 */

describe('a fonte da atividade é uma só: a vista no processo ou a escrita mais recente, a maior', () => {
  const running = envio({ id: 'a', status: 'em_execucao', updatedAt: iso(T0 + 9 * 60_000) })

  it('lastActivityMs', () => {
    expect(lastActivityMs(null, [])).toBe(0)
    expect(lastActivityMs(undefined, [running])).toBe(T0 + 9 * 60_000)
    expect(lastActivityMs(T0 + 10 * 60_000, [running])).toBe(T0 + 10 * 60_000)
    expect(lastActivityMs(T0, [running])).toBe(T0 + 9 * 60_000)
    expect(lastActivityMs(T0, [running, envio({ id: 'b', updatedAt: iso(T0 + 11 * 60_000) })])).toBe(conversationLastWriteMs([running]) + 2 * 60_000)
  })

  it('stallReason julga pela mesma fonte (a escrita do envio conta como atividade)', () => {
    const base = { turnRunning: false, pending: false, lastActivityMs: T0, now: T0 + 10 * 60_000 }
    expect(stallReason(running, base)).toBeNull()
    expect(stallReason(running, { ...base, now: T0 + 19 * 60_000 })).toMatch(/^nenhum turno rodando há 10 min/)
  })

  it('a carência do boot: a mesma constante para a varredura e a fila do projeto', () => {
    expect(BOOT_GRACE_MS).toBe(2 * 60_000)
    expect(SWEEP_BOOT_GRACE_MS).toBe(BOOT_GRACE_MS)
    expect(inBootGrace(T0, T0 + BOOT_GRACE_MS - 1)).toBe(true)
    expect(inBootGrace(T0, T0 + BOOT_GRACE_MS)).toBe(false)
  })
})

describe('desfazer o despacho — turnStartedAfterDispatch', () => {
  const sent = envio({ status: 'enviado', enviadoEm: iso(T0), iniciadoEm: null })
  const idle = { turnRunning: false, turnStartedAt: null, dispatchedAt: null }

  it('turno aberto em memória: o prompt está rodando', () => {
    expect(turnStartedAfterDispatch(sent, { ...idle, turnRunning: true })).toBe(true)
  })

  it('prompt novo sem turno depois do despacho: cabe desfazer (o turno anterior, antes da marca, não conta)', () => {
    expect(turnStartedAfterDispatch(sent, idle)).toBe(false)
    expect(turnStartedAfterDispatch(sent, { ...idle, turnStartedAt: T0 - 1 })).toBe(false)
    expect(turnStartedAfterDispatch(sent, { ...idle, turnStartedAt: T0 - 1, dispatchedAt: T0 })).toBe(false)
  })

  it('turn-start visto aqui depois da marca (mesmo com o turno já acabado): não cabe', () => {
    // Sem a marca em memória, o despacho do prompt novo é o `enviadoEm`.
    expect(turnStartedAfterDispatch(sent, { ...idle, turnStartedAt: T0 })).toBe(true)
    expect(turnStartedAfterDispatch(sent, { ...idle, turnStartedAt: T0 + 5_000, dispatchedAt: T0 })).toBe(true)
  })

  it('`iniciadoEm` no banco depois do despacho (gravado por este ou outro processo): não cabe', () => {
    expect(turnStartedAfterDispatch({ ...sent, iniciadoEm: iso(T0 + 1_000) }, { ...idle, dispatchedAt: T0 })).toBe(true)
    expect(turnStartedAfterDispatch({ ...sent, iniciadoEm: iso(T0 - 60_000) }, { ...idle, dispatchedAt: T0 })).toBe(false)
  })

  it('retomado (já tinha `iniciadoEm` da 1ª rodada) sem a marca em memória: só o turno em memória decide', () => {
    const resumed = { ...sent, iniciadoEm: iso(T0 + 1_000) }
    expect(turnStartedAfterDispatch(resumed, idle)).toBe(false)
    expect(turnStartedAfterDispatch(resumed, { ...idle, turnStartedAt: T0 + 2_000 })).toBe(false)
    expect(turnStartedAfterDispatch(resumed, { ...idle, turnStartedAt: T0 + 2_000, dispatchedAt: T0 + 1_500 })).toBe(true)
  })
})
