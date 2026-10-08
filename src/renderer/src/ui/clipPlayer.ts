/**
 * Toca os áudios do "Ouvir" (WAV em base64, uma parte por vez) por UM
 * AudioContext que fica aberto durante a leitura inteira.
 *
 * Antes era um `new Audio()` por parte: cada um abria e fechava a própria saída,
 * e no Windows a placa (Realtek em economia de energia, Bluetooth, HDMI)
 * "acordava" a cada parte e engolia o começo da fala — mesmo com a entrada de
 * silêncio que o Kokoro já põe no arquivo. Com a saída aberta entre as partes
 * ela não volta a dormir. Parado por CLIP_PLAYER_IDLE_MS, a saída é fechada.
 */

/** Sem tocar por este tempo, a saída fecha (a próxima leitura abre outra). */
export const CLIP_PLAYER_IDLE_MS = 15_000

export interface ClipPlayer {
  /** Toca um áudio até o fim; resolve no fim, no erro ou no `stop`. */
  play(base64: string): Promise<void>
  /** Para o que estiver tocando (a espera do `play` resolve). */
  stop(): void
  /** Abre/retoma a saída já no toque do usuário (política de autoplay do celular). */
  prime(): void
}

function decodeBase64(base64: string): ArrayBuffer {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

export function createClipPlayer(makeContext: () => AudioContext = () => new AudioContext()): ClipPlayer {
  let ctx: AudioContext | null = null
  let source: AudioBufferSourceNode | null = null
  let finish: (() => void) | null = null
  let idle: ReturnType<typeof setTimeout> | null = null

  const context = (): AudioContext => {
    if (idle) clearTimeout(idle)
    idle = null
    if (!ctx || ctx.state === 'closed') ctx = makeContext()
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
    return ctx
  }

  const scheduleClose = (): void => {
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => {
      idle = null
      if (finish || !ctx) return
      const closing = ctx
      ctx = null
      void closing.close().catch(() => undefined)
    }, CLIP_PLAYER_IDLE_MS)
  }

  // Cada `stop` (e cada `play`) invalida o que ainda estava decodificando.
  let generation = 0

  const stop = (): void => {
    generation++
    const playing = source
    source = null
    try {
      playing?.stop()
    } catch {
      /* já parado */
    }
    if (finish) finish()
    else if (ctx) scheduleClose()
  }

  /** Sem saída de áudio possível (sem dispositivo, ambiente sem Web Audio): null, sem lançar. */
  const tryContext = (): AudioContext | null => {
    try {
      return context()
    } catch {
      return null
    }
  }

  return {
    prime: () => void tryContext(),
    stop,
    async play(base64) {
      stop()
      const mine = generation
      const c = tryContext()
      if (!c) return
      let buffer: AudioBuffer
      try {
        buffer = await c.decodeAudioData(decodeBase64(base64))
      } catch {
        scheduleClose()
        return
      }
      // Parada ou trocada enquanto decodificava: não toca.
      if (mine !== generation || c !== ctx) {
        if (!finish) scheduleClose()
        return
      }
      await new Promise<void>((resolve) => {
        const node = c.createBufferSource()
        node.buffer = buffer
        node.connect(c.destination)
        const done = (): void => {
          if (finish !== done) return
          finish = null
          if (source === node) source = null
          scheduleClose()
          resolve()
        }
        finish = done
        source = node
        node.onended = done
        try {
          node.start()
        } catch {
          done()
        }
      })
    }
  }
}
