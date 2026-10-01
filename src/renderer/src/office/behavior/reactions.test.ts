import { describe, expect, it } from 'vitest'
import {
  COOLDOWN_MS,
  createReactions,
  DURATION_SEC,
  importanceOf,
  MOOD_HALF_LIFE_MS,
  type ReactionContext
} from './reactions'

const T0 = 1_000_000

function ctx(over: Partial<ReactionContext> = {}): ReactionContext {
  return { moment: 'chamado', doing: 'parado', busyMs: 0, steps: 0, edits: 0, openTracks: 0, now: T0, ...over }
}

/** Tarefa importante: muitos passos e mais de 2 min. */
const IMPORTANTE = { doing: 'tarefa' as const, busyMs: 3 * 60_000, steps: 15, edits: 4, openTracks: 1 }

describe('decisor de reações', () => {
  it('chamado no meio de tarefa importante → irritado, e feliz ao chegar', () => {
    const r = createReactions({ rng: () => 0 })
    const c = r.decide(1, ctx(IMPORTANTE))!
    expect(c.kind).toBe('irritado')
    expect(c.onArrive).toBe('feliz')
  })

  it('chamado no celular também irrita; parado não', () => {
    const r = createReactions({ rng: () => 0 })
    expect(r.decide(1, ctx({ doing: 'celular' }))!.kind).toBe('irritado')
    expect(r.decide(2, ctx({ doing: 'parado' }))!.kind).not.toBe('irritado')
  })

  it('a raiva cresce com interrupções recentes e mau humor', () => {
    const r = createReactions({ rng: () => 0 })
    const calmo = r.decide(1, ctx({ doing: 'tarefa', busyMs: 30_000, steps: 3 }))!.scores.irritado!
    r.nudge(2, 'interrupcao', T0 - 60_000)
    r.nudge(2, 'interrupcao', T0 - 30_000)
    r.nudge(2, 'erro', T0 - 10_000)
    const bravo = r.decide(2, ctx({ doing: 'tarefa', busyMs: 30_000, steps: 3 }))!.scores.irritado!
    expect(bravo).toBeGreaterThan(calmo)
  })

  it('chamado dormindo → sonolento', () => {
    const r = createReactions({ rng: () => 0.99 })
    expect(r.decide(1, ctx({ doing: 'dormindo' }))!.kind).toBe('sonolento')
  })

  it('erro → nervoso ou frustrado; ✗ do crítico → frustrado', () => {
    const r = createReactions({ rng: () => 0.5 })
    expect(['nervoso', 'frustrado']).toContain(r.decide(1, ctx({ moment: 'erro', doing: 'tarefa' }))!.kind)
    expect(r.decide(2, ctx({ moment: 'erro', doing: 'revisao', critic: true }))!.kind).toBe('frustrado')
  })

  it('tarefa longa concluída → comemora; ✓ depois de erros → aliviado', () => {
    const r = createReactions({ rng: () => 0 })
    expect(r.decide(1, ctx({ moment: 'fim', ...IMPORTANTE, busyMs: 6 * 60_000 }))!.kind).toBe('comemora')
    r.nudge(2, 'erro', T0 - 5000)
    r.nudge(2, 'erro', T0 - 3000)
    expect(r.decide(2, ctx({ moment: 'fim', doing: 'tarefa', busyMs: 20_000, steps: 2 }))!.kind).toBe('aliviado')
  })

  it('fim e erro não trazem cara de chegada', () => {
    const r = createReactions()
    expect(r.decide(1, ctx({ moment: 'fim' }))!.onArrive).toBeNull()
    expect(r.decide(1, ctx({ moment: 'erro' }))!.onArrive).toBeNull()
  })

  it('a mesma emoção não repete no mesmo personagem em < 20 s', () => {
    const r = createReactions({ rng: () => 0 })
    const kinds: (string | null)[] = []
    for (let i = 0; i < 6; i++) kinds.push(r.decide(1, ctx({ moment: 'erro', critic: true, now: T0 + i * 3000 }))?.kind ?? null)
    for (let i = 0; i < kinds.length; i++) {
      for (let j = i + 1; j < kinds.length; j++) {
        if (kinds[i] !== null && (j - i) * 3000 < COOLDOWN_MS) expect(kinds[j]).not.toBe(kinds[i])
      }
    }
    // Passado o esfriamento, pode de novo.
    expect(r.decide(1, ctx({ moment: 'erro', critic: true, now: T0 + COOLDOWN_MS + 1 }))!.kind).toBe('frustrado')
  })

  it("'…' e '?' nunca ficam escondidos: com eles, nenhuma reação visível na saída", () => {
    const r = createReactions({ rng: () => 0 })
    expect(r.decide(1, ctx({ ...IMPORTANTE, blocked: true }))).toEqual(expect.objectContaining({ kind: null }))
    expect(r.decide(2, ctx({ moment: 'erro', blocked: true }))).toBeNull()
    expect(r.decide(3, ctx({ moment: 'fim', blocked: true }))).toBeNull()
  })

  it('chamado em esfriamento ainda chega feliz', () => {
    const r = createReactions({ rng: () => 0 })
    r.decide(1, ctx({ doing: 'dormindo' }))
    const c = r.decide(1, ctx({ doing: 'dormindo', now: T0 + 1000 }))!
    expect(c.kind).not.toBe('sonolento')
    expect(c.onArrive).toBe('feliz')
  })

  it('sorteio leve entre notas próximas usa o RNG injetado', () => {
    // celular: irritado 0.6 vs. nada perto → sempre irritado.
    expect(createReactions({ rng: () => 0.99 }).decide(1, ctx({ doing: 'celular' }))!.kind).toBe('irritado')
    // parado: surpreso 0.55 e feliz 0.45 + humor; com humor bom ficam a ≤ 0.05.
    const pick = (v: number): string | null => {
      const r = createReactions({ rng: () => v })
      r.nudge(1, 'sucesso', T0)
      return r.decide(1, ctx({ doing: 'parado' }))!.kind
    }
    expect(new Set([pick(0), pick(0.99)])).toEqual(new Set(['surpreso', 'feliz']))
  })

  it('humor sobe com sucesso, cai com erro e volta ao neutro em minutos', () => {
    const r = createReactions()
    r.nudge(1, 'sucesso', T0)
    expect(r.moodOf(1, T0)).toBeGreaterThan(0)
    r.nudge(2, 'erro', T0)
    expect(r.moodOf(2, T0)).toBeLessThan(0)
    expect(Math.abs(r.moodOf(2, T0 + MOOD_HALF_LIFE_MS))).toBeLessThan(0.2)
    expect(r.moodOf(2, T0 + 10 * MOOD_HALF_LIFE_MS)).toBe(0)
    r.forget(2)
    expect(r.moodOf(2, T0)).toBe(0)
  })

  it('durações entre 1 e 3 s; importância cresce com passos e tempo', () => {
    for (const d of Object.values(DURATION_SEC)) {
      expect(d).toBeGreaterThanOrEqual(1)
      expect(d).toBeLessThanOrEqual(3)
    }
    expect(importanceOf(IMPORTANTE)).toBeGreaterThan(importanceOf({ steps: 2, busyMs: 10_000, edits: 0, openTracks: 0 }))
  })
})
