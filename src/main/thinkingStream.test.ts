// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { THINKING_EMIT_INTERVAL_MS, ThinkingStreams, type ThinkingDelta } from './thinkingStream'
import type { RawStreamEvent } from './toolInputStream'

/** Monta o leitor com relógio manual, ids previsíveis e os eventos emitidos. */
function harness(): { streams: ThinkingStreams; out: ThinkingDelta[]; clock: { t: number } } {
  const out: ThinkingDelta[] = []
  const clock = { t: 1_000 }
  let n = 0
  return { streams: new ThinkingStreams((e) => out.push(e), () => `th${++n}`, () => clock.t), out, clock }
}

const start = (index: number, type = 'thinking'): RawStreamEvent => ({
  type: 'content_block_start',
  index,
  content_block: { type }
})
const delta = (index: number, thinking: string): RawStreamEvent => ({
  type: 'content_block_delta',
  index,
  delta: { type: 'thinking_delta', thinking }
})
const stop = (index: number): RawStreamEvent => ({ type: 'content_block_stop', index })

describe('ThinkingStreams', () => {
  it('emite o texto acumulado no máximo uma vez por intervalo por bloco', () => {
    const { streams, out, clock } = harness()
    streams.handle({ type: 'message_start' })
    streams.handle(start(0))
    streams.handle(delta(0, 'Pre'))
    expect(out).toEqual([{ id: 'th1', text: 'Pre' }])
    // Dentro do intervalo: só acumula.
    clock.t += THINKING_EMIT_INTERVAL_MS - 1
    streams.handle(delta(0, 'ciso '))
    streams.handle(delta(0, 'ler '))
    expect(out).toHaveLength(1)
    clock.t += 1
    streams.handle(delta(0, 'o arquivo'))
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual({ id: 'th1', text: 'Preciso ler o arquivo' })
    // O stop não emite: a mensagem `assistant` traz o bloco inteiro.
    streams.handle(stop(0))
    expect(out).toHaveLength(2)
  })

  it('takeIds devolve os ids na ordem dos blocos e esvazia a lista', () => {
    const { streams, out, clock } = harness()
    streams.handle({ type: 'message_start' })
    streams.handle(start(0))
    streams.handle(delta(0, 'a'))
    streams.handle(stop(0))
    clock.t += THINKING_EMIT_INTERVAL_MS
    streams.handle(start(1, 'text'))
    streams.handle(start(2))
    streams.handle(delta(2, 'b'))
    expect(out.map((e) => e.id)).toEqual(['th1', 'th2'])
    expect(streams.takeIds()).toEqual(['th1', 'th2'])
    expect(streams.takeIds()).toEqual([])
  })

  it('message_start descarta blocos abertos e ids não consumidos da mensagem anterior', () => {
    const { streams, out, clock } = harness()
    streams.handle(start(0))
    streams.handle(delta(0, 'velho'))
    streams.handle({ type: 'message_start' })
    // O bloco antigo não existe mais: delta no mesmo index é ignorado.
    clock.t += THINKING_EMIT_INTERVAL_MS
    streams.handle(delta(0, 'x'))
    expect(out).toHaveLength(1)
    expect(streams.takeIds()).toEqual([])
    streams.handle(start(0))
    streams.handle(delta(0, 'novo'))
    expect(out.at(-1)).toEqual({ id: 'th2', text: 'novo' })
    expect(streams.takeIds()).toEqual(['th2'])
  })

  it('ignora signature_delta, text_delta, bloco que não é thinking e evento sem index', () => {
    const { streams, out } = harness()
    streams.handle(start(0, 'text'))
    streams.handle({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'olá' } })
    streams.handle(start(1))
    streams.handle({ type: 'content_block_delta', index: 1, delta: { type: 'signature_delta' } })
    streams.handle({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'sem index' } })
    expect(out).toEqual([])
    streams.handle(delta(1, 'ok'))
    expect(out).toEqual([{ id: 'th1', text: 'ok' }])
  })

  it('openSince: instante do start do bloco aberto; null depois do stop, do message_start ou do reset', () => {
    const { streams, clock } = harness()
    expect(streams.openSince()).toBeNull()
    streams.handle(start(0))
    const startedAt = clock.t
    // Sem delta nenhum durante minutos (display summarized): o bloco aberto é o sinal.
    clock.t += 4 * 60_000
    expect(streams.openSince()).toBe(startedAt)
    streams.handle(stop(0))
    expect(streams.openSince()).toBeNull()

    streams.handle(start(1))
    streams.handle({ type: 'message_start' })
    expect(streams.openSince()).toBeNull()

    streams.handle(start(2))
    streams.handle(delta(2, 'x'))
    streams.reset()
    expect(streams.openSince()).toBeNull()
    expect(streams.takeIds()).toEqual([])
  })

  it('deltas a cada 17 ms saem com pelo menos 250 ms entre emissões', () => {
    const clock = { t: 0 }
    const at: number[] = []
    const streams = new ThinkingStreams(() => at.push(clock.t), () => 'id', () => clock.t)
    streams.handle(start(0))
    for (let i = 0; i < 200; i++) {
      clock.t += 17
      streams.handle(delta(0, 'x'))
    }
    const gaps = at.slice(1).map((t, i) => t - at[i])
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(THINKING_EMIT_INTERVAL_MS)
    expect(at.length).toBeGreaterThan(10)
  })
})
