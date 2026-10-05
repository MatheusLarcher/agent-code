import { describe, expect, it } from 'vitest'
import type { Conversation } from './types'
import {
  BOOT_RESUME_DELAY_MS,
  normalizeTurnInFlight,
  RESTART_ERROR_TEXT,
  restartNoticeTexts,
  resumeAfterRestart,
  turnMark,
  UNSENT_AFTER_RESTART,
  withoutTurnInFlight,
  withTurnInFlight,
  withTurnSent
} from './turnInFlight'

const conv = (extra: Partial<Conversation> = {}): Conversation => ({
  id: 'c1',
  title: 'Conversa',
  cwd: '/proj',
  model: 'claude-opus-5-5',
  sdkSessionId: 'sess-1',
  messages: [{ kind: 'user', id: 'u1', text: 'faça X' }],
  tokens: { context: 0, output: 0, cost: 0 },
  createdAt: 1,
  updatedAt: 2,
  ...extra
})
const opts = { now: 1_000, self: 'pc-a', newId: () => 'rec-1', maxAttempts: 5 }

describe('turnInFlight — a marca', () => {
  it('nasce ao criar o turno, ganha `sent` no envio e sai no terminal (só a do turno certo)', () => {
    const marked = withTurnInFlight(conv(), turnMark('u1', { device: 'pc-a', now: 5 }))
    expect(marked.turnInFlight).toEqual({ msgId: 'u1', at: 5, device: 'pc-a' })
    expect(withTurnSent(marked, 'outro')).toBe(marked)
    const sent = withTurnSent(marked, 'u1')
    expect(sent.turnInFlight?.sent).toBe(true)
    expect(withTurnSent(sent, 'u1')).toBe(sent)
    expect(withoutTurnInFlight(sent, 'outro')).toBe(sent)
    expect(withoutTurnInFlight(sent).turnInFlight).toBeUndefined()
    expect('turnInFlight' in withoutTurnInFlight(sent, 'u1')).toBe(false)
    const plain = conv()
    expect(withoutTurnInFlight(plain)).toBe(plain)
  })

  it('valida a marca vinda do banco', () => {
    expect(normalizeTurnInFlight(null)).toBeUndefined()
    expect(normalizeTurnInFlight({ at: 1 })).toBeUndefined()
    expect(normalizeTurnInFlight({ msgId: 'u1', at: 'x', sent: 'sim', mcpTaskId: 3, device: '' })).toEqual({ msgId: 'u1', at: 0 })
    expect(normalizeTurnInFlight({ msgId: 'u1', at: 7, sent: true, mcpTaskId: 't1', device: 'pc-a' })).toEqual({
      msgId: 'u1',
      at: 7,
      sent: true,
      mcpTaskId: 't1',
      device: 'pc-a'
    })
  })
})

describe('turnInFlight — reinício do app no meio do turno', () => {
  it('turno enviado com sessão: vira recuperação `transient` em poucos segundos, a marca sai', () => {
    const r = resumeAfterRestart(conv({ turnInFlight: { msgId: 'u1', at: 1, sent: true, device: 'pc-a' } }), opts)
    expect(r.notice).toBe('resumed')
    expect(r.conv.turnInFlight).toBeUndefined()
    expect(r.conv.recovery).toEqual({
      id: 'rec-1',
      reason: 'transient',
      scheduledAt: 1_000 + BOOT_RESUME_DELAY_MS,
      attempt: 0,
      maxAttempts: 5,
      errorText: RESTART_ERROR_TEXT,
      messageId: 'u1'
    })
  })

  it('tarefa MCP: só limpa a marca e avisa (regra 2 — sem recuperação)', () => {
    const r = resumeAfterRestart(conv({ turnInFlight: { msgId: 'u1', at: 1, sent: true, mcpTaskId: 't1' } }), opts)
    expect(r.notice).toBe('mcp')
    expect(r.conv.turnInFlight).toBeUndefined()
    expect(r.conv.recovery).toBeUndefined()
  })

  it('nunca saiu (ou sem sessão para retomar): a bolha vira erro com "Tentar de novo"', () => {
    for (const c of [conv({ turnInFlight: { msgId: 'u1', at: 1 } }), conv({ sdkSessionId: null, turnInFlight: { msgId: 'u1', at: 1, sent: true } })]) {
      const r = resumeAfterRestart(c, opts)
      expect(r.notice).toBe('unsent')
      expect(r.conv.recovery).toBeUndefined()
      expect(r.conv.turnInFlight).toBeUndefined()
      expect(r.conv.messages[0]).toMatchObject({ id: 'u1', error: UNSENT_AFTER_RESTART })
    }
  })

  it('marca de outro PC fica como está; sem marca e sem recuperação, nada muda', () => {
    const foreign = conv({ turnInFlight: { msgId: 'u1', at: 1, sent: true, device: 'pc-b' } })
    expect(resumeAfterRestart(foreign, opts)).toEqual({ conv: foreign })
    expect(resumeAfterRestart(foreign, { ...opts, self: null }).conv).toBe(foreign)
    const plain = conv()
    expect(resumeAfterRestart(plain, opts).conv).toBe(plain)
  })

  it('recuperação: a que estava em curso (-1) é reagendada; a agendada fica, e a marca sai', () => {
    const recovery = { id: 'r', reason: 'limit' as const, scheduledAt: -1, attempt: 2, maxAttempts: 5, errorText: 'x', messageId: 'u1' }
    const inFlight = resumeAfterRestart(conv({ recovery, turnInFlight: { msgId: 'u1', at: 1, sent: true } }), opts)
    expect(inFlight.notice).toBe('resumed')
    expect(inFlight.conv.recovery).toEqual({ ...recovery, scheduledAt: 1_000 + BOOT_RESUME_DELAY_MS })
    expect(inFlight.conv.turnInFlight).toBeUndefined()
    const scheduled = { ...recovery, scheduledAt: 50_000 }
    const waiting = resumeAfterRestart(conv({ recovery: scheduled, turnInFlight: { msgId: 'u1', at: 1, sent: true } }), opts)
    expect(waiting.notice).toBeUndefined()
    expect(waiting.conv.recovery).toBe(scheduled)
    expect(waiting.conv.turnInFlight).toBeUndefined()
    const stalled = conv({ recovery: { ...recovery, scheduledAt: 0 } })
    expect(resumeAfterRestart(stalled, opts).conv).toBe(stalled)
  })

  it('avisos do boot: um por tipo, no singular e no plural', () => {
    expect(restartNoticeTexts([])).toEqual([])
    const texts = restartNoticeTexts(['resumed', 'resumed', 'mcp', undefined, 'unsent'])
    expect(texts).toHaveLength(3)
    expect(texts[0]).toMatch(/^2 conversas foram interrompidas/)
    expect(texts[1]).toMatch(/^Uma tarefa do Forgia/)
    expect(texts[2]).toMatch(/^Uma mensagem não chegou/)
  })
})
