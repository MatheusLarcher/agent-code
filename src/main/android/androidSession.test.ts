// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

let failNext = false
const boots: { model: string; stop: ReturnType<typeof vi.fn>; release: () => void }[] = []

vi.mock('./androidDevice', () => ({
  AndroidDevice: class {
    model = `emulador-${boots.length + 1}`
    stop = vi.fn(async () => undefined)
    ensureBooted(progress: (line: string) => void): Promise<void> {
      if (failNext) {
        failNext = false
        return Promise.reject(new Error('Toolchain Android ausente. Rode "android_setup" para instalar.'))
      }
      progress(`Iniciando ${this.model}…`)
      return new Promise((release) => boots.push({ model: this.model, stop: this.stop, release }))
    }
  }
}))

import { AndroidSession, androidSessionFor, disposeAllAndroidSessions, disposeAndroidSession } from './androidSession'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(async () => {
  await disposeAllAndroidSessions()
  boots.length = 0
  failNext = false
})

describe('AndroidSession — o aparelho ativo da conversa', () => {
  it('liga uma vez só: pedidos simultâneos esperam a mesma partida', async () => {
    const s = new AndroidSession()
    expect(s.device).toBeNull()
    const lines: string[] = []
    const a = s.open((l) => lines.push(l))
    const b = s.open()
    await tick()
    expect(boots).toHaveLength(1)
    boots[0].release()
    expect(await a).toBe(await b)
    expect(s.device).toBe(await a)
    expect(lines).toEqual(['Iniciando emulador-1…'])
    // Já ligado: devolve o mesmo aparelho, sem nova partida.
    expect(await s.open()).toBe(await a)
    expect(boots).toHaveLength(1)
  })

  it('duas conversas ao mesmo tempo ligam em fila, nunca dois emuladores de uma vez', async () => {
    const first = androidSessionFor('conv-a').open()
    const second = androidSessionFor('conv-b').open()
    await tick()
    expect(boots).toHaveLength(1) // a segunda espera a primeira terminar de ligar
    boots[0].release()
    await first
    await tick()
    expect(boots).toHaveLength(2)
    boots[1].release()
    await second
  })

  it('descartar a conversa desliga o aparelho dela e só o dela', async () => {
    const a = androidSessionFor('conv-a').open()
    await tick()
    boots[0].release()
    const b = androidSessionFor('conv-b').open()
    await a
    await tick()
    boots[1].release()
    await b

    await disposeAndroidSession('conv-a')
    expect(boots[0].stop).toHaveBeenCalledTimes(1)
    expect(boots[1].stop).not.toHaveBeenCalled()
    expect(androidSessionFor('conv-a').device).toBeNull() // sessão nova, sem aparelho

    await disposeAllAndroidSessions()
    expect(boots[1].stop).toHaveBeenCalledTimes(1)
  })

  it('partida que falha devolve o erro, não deixa aparelho pela metade e a próxima tentativa anda', async () => {
    failNext = true
    const s = androidSessionFor('conv-a')
    await expect(s.open()).rejects.toThrow('Toolchain Android ausente')
    expect(s.device).toBeNull()

    const again = s.open()
    await tick()
    expect(boots).toHaveLength(1)
    boots[0].release()
    expect((await again).model).toBe('emulador-1')
  })
})
