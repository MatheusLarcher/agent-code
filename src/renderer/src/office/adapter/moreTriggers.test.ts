import type { RateLimitStatus } from '@shared/ipc'
import { contextLimitFor } from '@shared/ipc'
import { describe, expect, it } from 'vitest'
import type { UIMessage } from '../../types'
import { roomIdFor } from './model'
import { accountName, deriveOverlayState, detectExtraTriggers, pileLevel } from './moreTriggers'
import { conv, feed, NOW } from './testFeed'

const exhausted = (id: string, text = 'Claude AI usage limit reached|1999999999'): UIMessage => ({ kind: 'error', id, text, usageExhausted: true })
const sw = (id: string, reason: 'turn-end' | 'exhausted' | 'manual' | 'suggest' | 'scheduled', text: string): UIMessage => ({
  kind: 'account-switch',
  id,
  reason,
  toAccountId: 'acc-b',
  text
})
const limit = (status: RateLimitStatus['status'], over: Partial<RateLimitStatus> = {}): RateLimitStatus => ({ rateLimitType: 'five_hour', status, ...over })

describe('gatilho 6: café na copa', () => {
  it('erro novo com usageExhausted → cafe só de quem estourou (sem conta) com a hora do texto', () => {
    const a0 = conv('a')
    const a1 = conv('a', { messages: [exhausted('e1')] })
    const out = detectExtraTriggers(feed({ conversations: [a0, conv('b')] }), feed({ conversations: [a1, conv('b')] }))
    expect(out).toEqual([{ type: 'cafe', convIds: ['a'], resetsAt: 1_999_999_999_000 }])
  })

  it('limite da conta: vão todas as conversas da mesma claudeAccountId', () => {
    const base = [conv('a', { claudeAccountId: 'x' }), conv('b', { claudeAccountId: 'x' }), conv('c', { claudeAccountId: 'y' })]
    const next = [conv('a', { claudeAccountId: 'x', messages: [exhausted('e1', 'limite')] }), base[1], base[2]]
    const out = detectExtraTriggers(feed({ conversations: base, usageLimits: { five_hour: limit('rejected', { resetsAt: NOW + 3_600_000 }) } }), feed({ conversations: next, usageLimits: { five_hour: limit('rejected', { resetsAt: NOW + 3_600_000 }) } }))
    // Sem hora no texto: usa o resetsAt da janela rejeitada.
    expect(out).toEqual([{ type: 'cafe', convIds: ['a', 'b'], resetsAt: NOW + 3_600_000 }])
  })

  it('janela Claude que passa a rejected → cafe da conta da conversa aberta; GPT não conta', () => {
    const cs = [conv('a', { claudeAccountId: 'x' }), conv('b', { claudeAccountId: 'x' })]
    const f0 = feed({ conversations: cs, activeId: 'b', usageLimits: { five_hour: limit('allowed_warning') } })
    const f1 = feed({ conversations: cs, activeId: 'b', usageLimits: { five_hour: limit('rejected', { resetsAt: NOW }) } })
    expect(detectExtraTriggers(f0, f1)).toEqual([{ type: 'cafe', convIds: ['a', 'b'], resetsAt: NOW }])
    // Continua rejeitada: não repete.
    expect(detectExtraTriggers(f1, f1)).toEqual([])
    const g = feed({ conversations: cs, activeId: 'b', usageLimits: { gpt_primary: limit('rejected', { rateLimitType: 'gpt_primary' }) } })
    expect(detectExtraTriggers(f0, g)).toEqual([])
  })

  it('turno novo → cafe-fim; primeiro feed (histórico) não dispara nada', () => {
    const a1 = conv('a', { messages: [exhausted('e1')] })
    expect(detectExtraTriggers(null, feed({ conversations: [a1], busyIds: new Set(['a']) }))).toEqual([])
    expect(detectExtraTriggers(feed({ conversations: [a1] }), feed({ conversations: [a1], busyIds: new Set(['a']) }))).toEqual([{ type: 'cafe-fim', convId: 'a' }])
  })
})

describe('gatilho 8: troca de crachá', () => {
  it('account-switch efetiva → cracha com o nome da conta nova; sugestão e agendamento não', () => {
    const a0 = conv('a')
    const msgs = [
      sw('s1', 'exhausted', 'A conta Pessoal atingiu o limite. Continuei na conta Trabalho.'),
      sw('s2', 'suggest', 'A conta Outra ainda tem folga (10% usado).'),
      sw('s3', 'scheduled', 'Vai trocar para a conta Outra ao terminar.')
    ]
    const out = detectExtraTriggers(feed({ conversations: [a0] }), feed({ conversations: [conv('a', { messages: msgs })] }))
    expect(out).toEqual([{ type: 'cracha', convId: 'a', name: 'Trabalho' }])
  })

  it('nome da conta nos três formatos do providerFailover; sem achar, o id', () => {
    expect(accountName('Troquei para a conta Pessoal (40% usado) — a conta Trabalho estava em 96%.', 'id')).toBe('Pessoal')
    expect(accountName('Esta conversa passou a usar a conta Equipe. motivo', 'id')).toBe('Equipe')
    expect(accountName('texto qualquer', 'acc-9')).toBe('acc-9')
  })

  it('a mesma mensagem não dispara de novo', () => {
    const a1 = conv('a', { messages: [sw('s1', 'manual', 'Troquei para a conta B (1% usado).')] })
    const a2 = conv('a', { messages: [...a1.messages, { kind: 'user', id: 'u', text: 'oi' }] })
    expect(detectExtraTriggers(feed({ conversations: [a1] }), feed({ conversations: [a2] }))).toEqual([])
  })
})

describe('estado 7, 9 e 10', () => {
  it('7: impressora por sala soma as tarefas em segundo plano; zera quando a lista esvazia', () => {
    const task = { taskId: 't', taskType: 'local_bash', description: 'npm run dev' } as never
    const o = deriveOverlayState(feed({ conversations: [conv('a', { backgroundTasks: [task, task] }), conv('b', { backgroundTasks: [task] }), conv('c', { cwd: 'C:\\proj\\beta' })] }))
    expect(o.printers).toEqual(new Map([[roomIdFor('C:\\proj\\alpha'), 3]]))
    expect(deriveOverlayState(feed({ conversations: [conv('a', { backgroundTasks: [] })] })).printers.size).toBe(0)
  })

  it('9: pilha em degraus de 80, 90 e 95% do contextLimitFor(modelo); some quando cai', () => {
    const max = contextLimitFor('claude-opus-4-5')
    expect(pileLevel(max * 0.79, 'claude-opus-4-5')).toBe(0)
    expect(pileLevel(max * 0.8, 'claude-opus-4-5')).toBe(1)
    expect(pileLevel(max * 0.9, 'claude-opus-4-5')).toBe(2)
    expect(pileLevel(max * 0.96, 'claude-opus-4-5')).toBe(3)
    const o = deriveOverlayState(feed({ conversations: [conv('a', { tokens: { context: max * 0.91, output: 0, cost: 0 } }), conv('b')] }))
    expect(o.piles).toEqual(new Map([['a', 2]]))
  })

  it('10: speakingId → conversa da mensagem lida; null → ninguém', () => {
    const a = conv('a', { messages: [{ kind: 'assistant-text', id: 'm1', text: 'olá' } as UIMessage] })
    expect(deriveOverlayState(feed({ conversations: [conv('b'), a], speakingId: 'm1' })).speakingConvId).toBe('a')
    expect(deriveOverlayState(feed({ conversations: [a], speakingId: null })).speakingConvId).toBeNull()
  })
})
