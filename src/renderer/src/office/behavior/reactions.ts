/**
 * Decisor de reações (cards dec-reacoes e sug-decisor-utilidade): Utility AI
 * sem LLM. Cada reação recebe uma nota 0..1 calculada do contexto; vence a
 * maior, com sorteio leve (RNG injetável) entre as notas próximas dela.
 *
 * - Só três momentos geram reação visível: 'chamado' (à reunião), 'fim' (turno
 *   ou trilha terminou bem) e 'erro' (inclui o ✗ do crítico). Interrupções,
 *   limite de uso e travamento só mexem no humor (nudge).
 * - Raiva cômica: chamado no lazer ou no meio de tarefa importante → irritado.
 *   Todo chamado devolve onArrive = 'feliz': ao chegar à mesa de reunião, na
 *   frente do chefe, a cara muda na hora — sempre, qualquer que seja a nota.
 * - Humor curto em memória: sobe com sucessos, cai com erros e interrupções e
 *   volta ao neutro sozinho (meia-vida MOOD_HALF_LIFE_MS). Não é salvo.
 * - Freios: a mesma emoção não repete no mesmo personagem em < COOLDOWN_MS;
 *   com '…' ou '?' no personagem (blocked) não há reação nenhuma.
 *
 * Pura quanto ao relógio: o instante vem em ctx.now.
 */

import type { ReactionKind } from '../engine/types'

// O tipo mora no motor (ele desenha a reação); reexportado por conveniência.
export type { ReactionKind } from '../engine/types'

export type ReactionMoment = 'chamado' | 'fim' | 'erro'

/** O que o personagem fazia no instante do momento. */
export type Doing = 'celular' | 'dormindo' | 'parado' | 'tarefa' | 'revisao'

export interface ReactionContext {
  moment: ReactionMoment
  doing: Doing
  /** Há quanto tempo está na tarefa (now - busySince); 0 sem tarefa. */
  busyMs: number
  /** Passos do turno (trocas de ferramenta). */
  steps: number
  /** Passos de edição (Edit/Write). */
  edits: number
  /** Delegações abertas (trilhas de subagente vivas). */
  openTracks: number
  /** O erro é o ✗ do crítico. */
  critic?: boolean
  /** O personagem mostra '…' ou '?': esses sempre ganham, sem reação. */
  blocked?: boolean
  now: number
}

export interface ReactionChoice {
  /** null = nada na saída (freio ou '…'/'?'), mas a chegada ainda vale. */
  kind: ReactionKind | null
  /** 1 a 3 s (0 sem kind). */
  durationSec: number
  /** Reação ao chegar à mesa de reunião (só no chamado; sempre 'feliz'). */
  onArrive: ReactionKind | null
  /** Notas de todas as candidatas (diagnóstico e testes). */
  scores: Partial<Record<ReactionKind, number>>
}

/** Mesma emoção no mesmo personagem: no mínimo isto entre uma e outra. */
export const COOLDOWN_MS = 20_000
/** Humor cai à metade (rumo ao neutro) a cada minuto: neutro em ~4 min. */
export const MOOD_HALF_LIFE_MS = 60_000
/** Janela das "interrupções recentes". */
export const INTERRUPT_WINDOW_MS = 5 * 60_000
/** Notas até esta distância da maior entram no sorteio. */
export const TIE_MARGIN = 0.05
/** Abaixo disto ninguém reage. */
export const MIN_SCORE = 0.2
/** Tarefa "importante" começa a contar a partir de ~2 min. */
export const LONG_TASK_MS = 2 * 60_000

export const DURATION_SEC: Readonly<Record<ReactionKind, number>> = {
  irritado: 2.5,
  surpreso: 1.2,
  sonolento: 3,
  feliz: 2,
  comemora: 3,
  nervoso: 2,
  frustrado: 2.5,
  aliviado: 2
}

/** Quanto cada sinal empurra o humor (-1..1). */
const NUDGE = { sucesso: 0.3, erro: -0.35, interrupcao: -0.2, limite: -0.15, travamento: -0.1 } as const
export type MoodSignal = keyof typeof NUDGE

export interface ReactionsOptions {
  /** Gerador em [0,1); injetável para os testes. Padrão: Math.random. */
  rng?: () => number
}

export interface Reactions {
  /** Decide a reação de um momento-chave; null = nenhuma visível. Atualiza o humor. */
  decide(id: number, ctx: ReactionContext): ReactionChoice | null
  /** Sinal que só mexe no humor (interrupção, limite de uso, travamento…). */
  nudge(id: number, signal: MoodSignal, now: number): void
  /** Humor atual, -1..1, já com o retorno ao neutro aplicado. */
  moodOf(id: number, now: number): number
  /** Registra uma reação mostrada fora do decisor (o 'feliz' da chegada). */
  noteShown(id: number, kind: ReactionKind, now: number): void
  forget(id: number): void
}

interface Memory {
  mood: number
  moodAt: number
  interrupts: number[]
  /** Erros seguidos desde o último sucesso. */
  errorStreak: number
  lastShown: Map<ReactionKind, number>
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

/** Importância 0..1: passos, tempo na tarefa, edições e delegações abertas. */
export function importanceOf(ctx: Pick<ReactionContext, 'steps' | 'busyMs' | 'edits' | 'openTracks'>): number {
  return clamp01(
    clamp01(ctx.steps / 12) * 0.45 +
      clamp01(ctx.busyMs / LONG_TASK_MS) * 0.35 +
      clamp01(ctx.edits / 5) * 0.1 +
      clamp01(ctx.openTracks / 2) * 0.1
  )
}

interface Signals {
  importance: number
  /** Interrupções recentes, 0..1 (3 ou mais = 1). */
  annoy: number
  /** Mau humor, 0..1. */
  grumpy: number
  /** Bom humor, 0..1. */
  cheer: number
  errorStreak: number
}

/** As notas de cada momento. Tabela de pesos: ajuste aqui. */
export function scoreReactions(ctx: ReactionContext, s: Signals): Partial<Record<ReactionKind, number>> {
  const { doing } = ctx
  const working = doing === 'tarefa' || doing === 'revisao'
  if (ctx.moment === 'chamado') {
    const rage = 0.25 * s.annoy + 0.2 * s.grumpy
    let irritado = 0.1 + rage
    if (working) irritado = 0.3 + 0.6 * s.importance + rage
    else if (doing === 'celular') irritado = 0.6 + rage
    else if (doing === 'dormindo') irritado = Math.min(0.8, 0.3 + rage)
    return {
      irritado: clamp01(irritado),
      sonolento: doing === 'dormindo' ? 0.9 : 0,
      surpreso: doing === 'parado' ? 0.55 : working ? 0.45 * (1 - s.importance) : 0.15,
      feliz: doing === 'parado' ? clamp01(0.45 + 0.3 * s.cheer - 0.2 * s.annoy) : 0.1
    }
  }
  if (ctx.moment === 'fim') {
    const long = clamp01(ctx.busyMs / (3 * 60_000))
    return {
      comemora: clamp01(0.6 * long + 0.4 * s.importance),
      aliviado: s.errorStreak > 0 ? clamp01(0.7 + 0.1 * s.errorStreak) : 0,
      feliz: clamp01(0.5 + 0.2 * s.cheer)
    }
  }
  // Erro: o ✗ do crítico frustra; erro de ferramenta deixa nervoso.
  return {
    frustrado: ctx.critic ? 0.95 : clamp01(0.4 + 0.3 * s.grumpy + 0.1 * s.errorStreak),
    nervoso: ctx.critic ? 0.3 : clamp01(0.55 + 0.2 * s.importance)
  }
}

export function createReactions(opts: ReactionsOptions = {}): Reactions {
  const rng = opts.rng ?? Math.random
  const byId = new Map<number, Memory>()

  const memOf = (id: number, now: number): Memory => {
    let m = byId.get(id)
    if (!m) {
      m = { mood: 0, moodAt: now, interrupts: [], errorStreak: 0, lastShown: new Map() }
      byId.set(id, m)
    }
    return m
  }

  /** Aplica o retorno ao neutro até `now`. */
  const settle = (m: Memory, now: number): void => {
    const dt = Math.max(0, now - m.moodAt)
    m.mood *= Math.pow(0.5, dt / MOOD_HALF_LIFE_MS)
    if (Math.abs(m.mood) < 0.01) m.mood = 0
    m.moodAt = now
    m.interrupts = m.interrupts.filter((t) => now - t < INTERRUPT_WINDOW_MS)
  }

  const push = (m: Memory, signal: MoodSignal, now: number): void => {
    settle(m, now)
    m.mood = Math.max(-1, Math.min(1, m.mood + NUDGE[signal]))
    if (signal === 'interrupcao') m.interrupts.push(now)
    if (signal === 'erro') m.errorStreak++
    if (signal === 'sucesso') m.errorStreak = 0
  }

  const coolingDown = (m: Memory, kind: ReactionKind, now: number): boolean => {
    const t = m.lastShown.get(kind)
    return t !== undefined && now - t < COOLDOWN_MS
  }

  return {
    decide(id, ctx) {
      const m = memOf(id, ctx.now)
      settle(m, ctx.now)
      const scores = scoreReactions(ctx, {
        importance: importanceOf(ctx),
        annoy: clamp01(m.interrupts.length / 3),
        grumpy: clamp01(-m.mood),
        cheer: clamp01(m.mood),
        errorStreak: m.errorStreak
      })
      // O momento sempre mexe no humor, mesmo sem reação visível.
      push(m, ctx.moment === 'chamado' ? 'interrupcao' : ctx.moment === 'fim' ? 'sucesso' : 'erro', ctx.now)
      // A chegada feliz vale sempre, até sem reação na saída (é a piada).
      const onArrive: ReactionKind | null = ctx.moment === 'chamado' ? 'feliz' : null
      const none = (): ReactionChoice | null => (onArrive ? { kind: null, durationSec: 0, onArrive, scores } : null)
      if (ctx.blocked) return none()

      const cands = (Object.entries(scores) as [ReactionKind, number][]).filter(
        ([k, v]) => v >= MIN_SCORE && !coolingDown(m, k, ctx.now)
      )
      if (cands.length === 0) return none()
      const best = Math.max(...cands.map(([, v]) => v))
      const near = cands.filter(([, v]) => v >= best - TIE_MARGIN)
      const [kind] = near[Math.min(near.length - 1, Math.floor(rng() * near.length))]
      m.lastShown.set(kind, ctx.now)
      return { kind, durationSec: DURATION_SEC[kind], onArrive, scores }
    },
    nudge(id, signal, now) {
      push(memOf(id, now), signal, now)
    },
    moodOf(id, now) {
      const m = byId.get(id)
      if (!m) return 0
      settle(m, now)
      return m.mood
    },
    noteShown(id, kind, now) {
      memOf(id, now).lastShown.set(kind, now)
    },
    forget(id) {
      byId.delete(id)
    }
  }
}
