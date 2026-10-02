import { describe, expect, it } from 'vitest'
import { demoScripts } from './demoFeed'
import { DELEGATE_LEAD_MS, DEMO_LOOP_MS, demoUsage, playScript, turnMs, USAGE_BACK_AT, USAGE_OUT_AT, USAGE_START, type DemoStep, type DemoTurn } from './demoTimeline'

const START = 1_000_000
const play = (turns: DemoTurn[], t: number): ReturnType<typeof playScript> => playScript(turns, t, START, 'c', 7)
const turn = (at: number, ...steps: DemoStep[]): DemoTurn[] => [{ at, user: 'faz isso', steps }]
const kinds = (t: DemoTurn[], at: number): string[] => play(t, at).messages.map((m) => m.kind)

describe('playScript', () => {
  it('tool: aparece aberta e ganha o resultado no fim; ocupado até a resposta', () => {
    const t = turn(1_000, { do: 'tool', ms: 2_000, name: 'Read', input: { file_path: 'a.ts' }, result: 'x' }, { do: 'answer', text: 'pronto' })
    expect(play(t, 500)).toMatchObject({ messages: [], busy: false })
    const mid = play(t, 2_000)
    expect(mid.messages.map((m) => m.kind)).toEqual(['user', 'tool-use'])
    expect(mid.messages[1]).not.toHaveProperty('result')
    expect(mid).toMatchObject({ busy: true, busySince: START + 1_000, updatedAt: START + 1_000 })
    const end = play(t, 3_000)
    expect(end.messages[0]).toMatchObject({ id: 'c-c7-t0-u', ts: START + 1_000 })
    expect(end.messages[1]).toMatchObject({ result: { isError: false, text: 'x' } })
    expect(end.messages[2]).toMatchObject({ kind: 'assistant-text', answer: true, ts: START + 3_000 })
    expect(end).toMatchObject({ busy: false, busySince: null, updatedAt: START + 3_000 })
  })

  it('ask: pede permissão sem a chamada; concedida, a chamada entra e roda', () => {
    const t = turn(0, { do: 'ask', wait: 4_000, ms: 1_000, name: 'Bash', input: { command: 'rm -rf dist' } }, { do: 'answer', text: 'ok' })
    const waiting = play(t, 2_000)
    expect(waiting.permission).toMatchObject({ toolName: 'Bash', input: { command: 'rm -rf dist' } })
    expect(waiting.messages.map((m) => m.kind)).toEqual(['user'])
    const running = play(t, 4_500)
    expect(running.permission).toBeNull()
    expect(running.messages[1]).toMatchObject({ kind: 'tool-use', name: 'Bash' })
    expect(running.messages[1]).not.toHaveProperty('result')
    expect(kinds(t, 5_000)).toEqual(['user', 'tool-use', 'assistant-text'])
  })

  it('delegate: tool-use Agent + trilha com os passos no tempo; fecha ok ou com erro', () => {
    const sub = { do: 'tool' as const, ms: 2_000, name: 'Bash', input: { command: 'npm test' }, result: 'ok' }
    const make = (ok: boolean): DemoTurn[] => turn(0, { do: 'delegate', ms: 6_000, type: 'executor', description: 'corrigir o teste', steps: [sub, sub], ok, result: 'feito' }, { do: 'answer', text: 'ok' })
    const mid = play(make(true), 3_000)
    const track = mid.tracks['c-c7-t0-s0']
    expect(track).toMatchObject({ label: 'executor: corrigir o teste', subagentType: 'executor', status: 'running', startedAt: START, stepCount: 2 })
    expect(track.steps[0]).toMatchObject({ endedAt: START + DELEGATE_LEAD_MS + 2_000, result: 'ok' })
    expect(track.steps[1]).not.toHaveProperty('result')
    expect(mid.messages[1]).toMatchObject({ kind: 'tool-use', name: 'Agent', input: { subagent_type: 'executor', description: 'corrigir o teste' } })
    expect(play(make(true), 6_000).tracks['c-c7-t0-s0']).toMatchObject({ status: 'done', endedAt: START + 6_000 })
    const failed = play(make(false), 6_000)
    expect(failed.tracks['c-c7-t0-s0'].status).toBe('error')
    expect(failed.messages[1]).toMatchObject({ result: { isError: true, text: 'feito' } })
  })

  it('stall: stalledSince (= começo do silêncio) só depois de flagAfter e até o fim', () => {
    const t = turn(0, { do: 'stall', ms: 10_000, flagAfter: 6_000 }, { do: 'answer', text: 'voltei' })
    expect(play(t, 5_000).stalledSince).toBeNull()
    expect(play(t, 7_000)).toMatchObject({ stalledSince: START, busy: true })
    expect(play(t, 10_000)).toMatchObject({ stalledSince: null, busy: false })
  })

  it('limit: erro com usageExhausted e recuperação agendada (ocupado, sem busySince); depois segue', () => {
    const t = turn(0, { do: 'limit', ms: 8_000, text: 'Claude AI usage limit reached' }, { do: 'tool', ms: 1_000, name: 'Read', input: {} }, { do: 'answer', text: 'ok' })
    const out = play(t, 3_000)
    expect(out.messages[1]).toMatchObject({ kind: 'error', usageExhausted: true, text: `Claude AI usage limit reached|${Math.floor((START + 8_000) / 1000)}` })
    expect(out).toMatchObject({ busy: true, busySince: null, recovery: { reason: 'limit', scheduledAt: START + 8_000, messageId: 'c-c7-t0-u' } })
    expect(play(t, 8_500)).toMatchObject({ recovery: null, busySince: START + 8_000, busy: true })
    expect(kinds(t, 8_500)).toEqual(['user', 'error', 'tool-use'])
  })

  it('fail: o erro encerra o turno e os passos depois dele não rodam', () => {
    const t = turn(0, { do: 'fail', text: 'API Error: 529' }, { do: 'answer', text: 'nunca' })
    expect(play(t, 5_000)).toMatchObject({ busy: false, messages: [{ kind: 'user' }, { kind: 'error', text: 'API Error: 529' }] })
  })

  it('turno de antes de um ciclo inteiro é histórico: o id não muda de volta para volta', () => {
    const t = turn(-30 * 60_000, { do: 'answer', text: 'ok' })
    expect(playScript(t, 0, START, 'c', 1).messages[0]).toMatchObject({ id: 'c-h0-u' })
    expect(playScript(t, 0, START + DEMO_LOOP_MS, 'c', 2).messages[0]).toMatchObject({ id: 'c-h0-u' })
    expect(play(turn(-5_000, { do: 'answer', text: 'ok' }), 0).messages[0]).toMatchObject({ id: 'c-c7-t0-u' })
  })
})

describe('roteiros da demo', () => {
  it('turnos não se sobrepõem, terminam dentro do loop e os passos do subagente cabem na delegação', () => {
    const rooms = demoScripts()
    expect(rooms).toHaveLength(5)
    for (const room of rooms) {
      expect(room).toHaveLength(4)
      for (const turns of room) {
        turns.forEach((t, k) => {
          const end = t.at + turnMs(t)
          expect(end).toBeLessThan(DEMO_LOOP_MS)
          if (k + 1 < turns.length) expect(end).toBeLessThanOrEqual(turns[k + 1].at)
          expect(['answer', 'fail']).toContain(t.steps[t.steps.length - 1].do)
          for (const s of t.steps) {
            if (s.do === 'delegate') expect(DELEGATE_LEAD_MS + s.steps.reduce((n, x) => n + x.ms, 0)).toBeLessThanOrEqual(s.ms)
            if (s.do === 'stall') expect(s.flagAfter).toBeLessThan(s.ms)
          }
        })
      }
    }
  })
})

describe('demoUsage', () => {
  it('enche até esgotar em USAGE_OUT_AT e volta zerada em USAGE_BACK_AT; o fim do loop emenda no começo', () => {
    expect(demoUsage(0, START, START)).toMatchObject({ rateLimitType: 'five_hour', status: 'allowed', utilization: USAGE_START, resetsAt: START + USAGE_BACK_AT })
    expect(demoUsage(USAGE_OUT_AT - 1, START, START).utilization).toBeGreaterThan(0.98)
    expect(demoUsage(USAGE_OUT_AT, START, START)).toMatchObject({ status: 'rejected', utilization: 1, resetsAt: START + USAGE_BACK_AT })
    const back = demoUsage(USAGE_BACK_AT, START, START)
    expect(back).toMatchObject({ status: 'allowed', resetsAt: START + USAGE_BACK_AT + 5 * 3_600_000 })
    expect(back.utilization).toBeLessThan(0.05)
    expect(demoUsage(DEMO_LOOP_MS - 1, START, START).utilization).toBeCloseTo(USAGE_START, 3)
    // Festa de pelo menos 20 s.
    expect(USAGE_BACK_AT - USAGE_OUT_AT).toBeGreaterThanOrEqual(20_000)
  })
})
