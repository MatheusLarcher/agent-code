// Derivado de pixel-agents (MIT, (c) 2026 Pablo De Lucca) — ver ../LICENSE-pixel-agents.md

import { MAX_DELTA_TIME_SEC } from './constants'

export interface GameLoopCallbacks {
  update: (dt: number) => void
  render: () => void
}

export interface GameLoop {
  start(): void
  /** Cancela o quadro agendado — nada roda depois de stop, nem um último tique. */
  stop(): void
  readonly running: boolean
}

/**
 * Laço de quadros sobre requestAnimationFrame. raf/caf são injetáveis para o
 * teste (o jsdom não anima) e para quem quiser um relógio próprio.
 *
 * O dt é limitado a MAX_DELTA_TIME_SEC: depois de a aba ficar em segundo plano,
 * o primeiro quadro não faz ninguém atravessar a sala num salto.
 */
export function createGameLoop(
  callbacks: GameLoopCallbacks,
  raf: (cb: FrameRequestCallback) => number = (cb) => requestAnimationFrame(cb),
  caf: (id: number) => void = (id) => cancelAnimationFrame(id)
): GameLoop {
  let rafId = 0
  let lastTime = 0
  let running = false
  // Token de geração: cada start() abre uma geração nova. Um quadro só roda e
  // só reagenda se ainda pertence à geração corrente — assim stop()+start()
  // dentro de update/render não deixa dois rAF vivos.
  let generation = 0
  let inFrame = false

  const schedule = (gen: number): void => {
    rafId = raf((time) => frame(time, gen))
  }

  const frame = (time: number, gen: number): void => {
    if (!running || gen !== generation) return
    const dt = lastTime === 0 ? 0 : Math.min((time - lastTime) / 1000, MAX_DELTA_TIME_SEC)
    lastTime = time
    inFrame = true
    try {
      callbacks.update(dt)
      callbacks.render()
    } finally {
      inFrame = false
    }
    // stop() (com ou sem start() depois) no meio do quadro: quem reagenda é
    // este fim de quadro, na geração atual, uma vez só.
    if (running) schedule(generation)
  }

  return {
    start() {
      if (running) return
      running = true
      lastTime = 0
      generation++
      // Dentro de um quadro, o fim do quadro já reagenda.
      if (!inFrame) schedule(generation)
    },
    stop() {
      if (!running) return
      running = false
      caf(rafId)
      rafId = 0
    },
    get running() {
      return running
    }
  }
}
