import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClipPlayer, CLIP_PLAYER_IDLE_MS } from './clipPlayer'

/** AudioContext falso: cada source "toca" até o teste chamar `finish()`. */
function fakeContextFactory() {
  const contexts: FakeContext[] = []
  class FakeSource {
    buffer: unknown = null
    onended: (() => void) | null = null
    started = false
    connect(): void {}
    start(): void {
      this.started = true
    }
    stop(): void {
      this.onended?.()
    }
    finish(): void {
      this.onended?.()
    }
  }
  class FakeContext {
    state: 'running' | 'suspended' | 'closed' = 'running'
    destination = {}
    sources: FakeSource[] = []
    resume = vi.fn(async () => {
      this.state = 'running'
    })
    close = vi.fn(async () => {
      this.state = 'closed'
    })
    decodeAudioData = vi.fn(async (data: ArrayBuffer) => ({ bytes: data.byteLength }))
    createBufferSource(): FakeSource {
      const s = new FakeSource()
      this.sources.push(s)
      return s
    }
  }
  const make = (): AudioContext => {
    const c = new FakeContext()
    contexts.push(c)
    return c as unknown as AudioContext
  }
  return { make, contexts }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('createClipPlayer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // Um <audio> novo por parte abria e fechava a saída do Windows a cada parte, e
  // a placa "acordando" engolia o começo da fala. Uma leitura inteira passa por
  // UMA saída aberta.
  it('toca as partes em sequência pela mesma saída de áudio', async () => {
    const { make, contexts } = fakeContextFactory()
    const player = createClipPlayer(make)
    const first = player.play(btoa('parte-1'))
    await flush()
    contexts[0].sources[0].finish()
    await first
    const second = player.play(btoa('parte-2'))
    await flush()
    contexts[0].sources[1].finish()
    await second
    expect(contexts).toHaveLength(1)
    expect(contexts[0].sources.map((s) => s.started)).toEqual([true, true])
  })

  it('stop interrompe a parte tocando e resolve a espera dela', async () => {
    const { make, contexts } = fakeContextFactory()
    const player = createClipPlayer(make)
    const playing = player.play(btoa('parte'))
    await flush()
    player.stop()
    await expect(playing).resolves.toBeUndefined()
    expect(contexts[0].sources[0].started).toBe(true)
  })

  it('fecha a saída depois de um tempo parado e abre outra na próxima leitura', async () => {
    const { make, contexts } = fakeContextFactory()
    const player = createClipPlayer(make)
    const p = player.play(btoa('a'))
    await flush()
    contexts[0].sources[0].finish()
    await p
    vi.advanceTimersByTime(CLIP_PLAYER_IDLE_MS - 1)
    expect(contexts[0].close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(contexts[0].close).toHaveBeenCalled()
    const q = player.play(btoa('b'))
    await flush()
    expect(contexts).toHaveLength(2)
    contexts[1].sources[0].finish()
    await q
  })

  it('prime retoma uma saída suspensa (o toque do usuário libera o áudio no celular)', async () => {
    const { make, contexts } = fakeContextFactory()
    const player = createClipPlayer(make)
    player.prime()
    contexts[0].state = 'suspended'
    player.prime()
    expect(contexts[0].resume).toHaveBeenCalled()
  })
})
