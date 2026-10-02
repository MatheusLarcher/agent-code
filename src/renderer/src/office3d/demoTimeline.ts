/**
 * Motor da linha do tempo da demonstração 3D. Cada conversa tem um roteiro
 * (turnos com passos que duram `ms`); `playScript` diz, num instante `t` do
 * loop, o estado que o App teria ali: mensagens, ocupado, permissão pendente,
 * trilhas de subagente, silêncio (stalledSince) e recuperação por limite.
 * Puro e determinístico: mesmo roteiro e mesmo `t`, mesmo estado.
 *
 * Tempo: `t` e os `at`/`ms` do roteiro são relativos ao começo do ciclo
 * (`start`, epoch ms). `at` negativo = o turno começou antes do ciclo (assim o
 * quadro t=0 já mostra gente no meio do trabalho). Ids levam o número do ciclo,
 * para cada volta do loop trazer mensagens novas; turnos de antes de um ciclo
 * inteiro são histórico e mantêm o id em todas as voltas.
 */
import type { PermissionRequest, RateLimitStatus } from '@shared/ipc'
import type { TrackMap, TrackStep } from '../agentTracks'
import type { TurnRecovery, UIMessage } from '../types'

export const DEMO_LOOP_MS = 120_000

type Input = Record<string, unknown>

/** Uma chamada de ferramenta: aparece aberta e recebe o resultado depois de `ms`. */
export interface ToolStep {
  do: 'tool'
  ms: number
  name: string
  input: Input
  result?: string
  isError?: boolean
}

export type DemoStep =
  | ToolStep
  /** Pede permissão por `wait` ms (a chamada só entra no chat ao ser concedida) e roda por `ms`. */
  | { do: 'ask'; wait: number; ms: number; name: string; input: Input; result?: string }
  /** Delega (tool-use Agent): a trilha roda `steps` e fecha depois de `ms` (ok ou erro). */
  | { do: 'delegate'; ms: number; type: string; description: string; steps: ToolStep[]; ok: boolean; result: string }
  /** Silêncio de `ms`; o vigia do main marca stalledSince depois de `flagAfter`. */
  | { do: 'stall'; ms: number; flagAfter: number }
  /** Limite de uso: erro + recuperação agendada para o fim de `ms`, e o turno segue. */
  | { do: 'limit'; ms: number; text: string }
  /** Resposta final: fim OK do turno. */
  | { do: 'answer'; text: string }
  /** Erro da sessão: fim do turno com erro. */
  | { do: 'fail'; text: string }

export interface DemoTurn {
  at: number
  user: string
  steps: DemoStep[]
}

export interface DemoState {
  messages: UIMessage[]
  busy: boolean
  busySince: number | null
  permission: PermissionRequest | null
  stalledSince: number | null
  recovery: TurnRecovery | null
  tracks: TrackMap
  updatedAt: number
}

/** Atraso entre a delegação e o 1º passo do subagente. */
export const DELEGATE_LEAD_MS = 500

/** Quanto o passo ocupa na linha do tempo (answer/fail são instantâneos). */
export function stepMs(step: DemoStep): number {
  if (step.do === 'ask') return step.wait + step.ms
  return step.do === 'answer' || step.do === 'fail' ? 0 : step.ms
}

/** Duração do turno do `at` até a resposta/erro final. */
export const turnMs = (turn: DemoTurn): number => turn.steps.reduce((sum, s) => sum + stepMs(s), 0)

function toolUse(id: string, name: string, input: Input, closed: boolean, result?: string, isError = false): UIMessage {
  const m = { kind: 'tool-use' as const, id, name, input, parentToolUseId: null }
  return closed ? { ...m, result: { isError, text: result ?? '' } } : m
}

/** Estado do roteiro no instante `t` (ms desde `start`) do ciclo `cycle`. */
export function playScript(turns: readonly DemoTurn[], t: number, start: number, convId: string, cycle: number): DemoState {
  const st: DemoState = { messages: [], busy: false, busySince: null, permission: null, stalledSince: null, recovery: null, tracks: {}, updatedAt: start }
  const seen = (at: number): void => void (st.updatedAt = Math.max(st.updatedAt, start + at))
  let first = true
  turns.forEach((turn, k) => {
    if (turn.at > t) return
    const id = turn.at <= -DEMO_LOOP_MS ? `${convId}-h${k}` : `${convId}-c${cycle}-t${k}`
    if (first) st.updatedAt = start + turn.at
    first = false
    st.messages.push({ kind: 'user', id: `${id}-u`, text: turn.user, ts: start + turn.at })
    seen(turn.at)
    Object.assign(st, { busy: true, busySince: start + turn.at, permission: null, stalledSince: null, recovery: null })
    let s = turn.at
    for (let j = 0; j < turn.steps.length && s <= t; j++) {
      const step = turn.steps[j]
      const sid = `${id}-s${j}`
      switch (step.do) {
        case 'tool': {
          const closed = t >= s + step.ms
          st.messages.push(toolUse(sid, step.name, step.input, closed, step.result, step.isError))
          seen(closed ? s + step.ms : s)
          break
        }
        case 'ask': {
          if (t < s + step.wait) {
            st.permission = { id: `${sid}-p`, toolName: step.name, input: step.input }
            break
          }
          const closed = t >= s + step.wait + step.ms
          st.messages.push(toolUse(sid, step.name, step.input, closed, step.result))
          seen(closed ? s + step.wait + step.ms : s + step.wait)
          break
        }
        case 'delegate': {
          const closed = t >= s + step.ms
          const steps: TrackStep[] = []
          let u = s + DELEGATE_LEAD_MS
          for (const [n, sub] of step.steps.entries()) {
            if (u > t) break
            const end = u + sub.ms
            const done = t >= end
            steps.push({ id: `${sid}-k${n}`, name: sub.name, input: sub.input, startedAt: start + u, ...(done ? { endedAt: start + end, isError: !!sub.isError, result: sub.result ?? '' } : {}) })
            seen(done ? end : u)
            u = end
          }
          st.tracks[sid] = {
            id: sid,
            label: `${step.type}: ${step.description}`,
            subagentType: step.type,
            status: closed ? (step.ok ? 'done' : 'error') : 'running',
            startedAt: start + s,
            ...(closed ? { endedAt: start + s + step.ms } : {}),
            stepCount: steps.length,
            steps
          }
          const input = { description: step.description, prompt: step.description, subagent_type: step.type }
          st.messages.push(toolUse(sid, 'Agent', input, closed, step.result, !step.ok))
          seen(closed ? s + step.ms : s)
          break
        }
        case 'stall':
          if (t >= s + step.flagAfter && t < s + step.ms) st.stalledSince = start + s
          break
        case 'limit': {
          const back = start + s + step.ms
          const text = `${step.text}|${Math.floor(back / 1000)}`
          st.messages.push({ kind: 'error', id: `${sid}-e`, text, usageExhausted: true })
          seen(s)
          // Como o App: a conversa fica ocupada, sem busySince, até a recuperação rodar.
          if (t < s + step.ms) {
            st.recovery = { id: `${sid}-r`, reason: 'limit', scheduledAt: back, attempt: 0, maxAttempts: 5, errorText: text, messageId: `${id}-u` }
            st.busySince = null
          } else {
            st.busySince = back
          }
          break
        }
        case 'answer':
          st.messages.push({ kind: 'assistant-text', id: `${sid}-a`, text: step.text, final: true, answer: true, ts: start + s })
          seen(s)
          Object.assign(st, { busy: false, busySince: null })
          break
        case 'fail':
          st.messages.push({ kind: 'error', id: `${sid}-e`, text: step.text })
          seen(s)
          Object.assign(st, { busy: false, busySince: null })
          break
      }
      s += stepMs(step)
      if (step.do === 'answer' || step.do === 'fail') break
    }
  })
  return st
}

/** A janela de 5h esgota aqui… */
export const USAGE_OUT_AT = 68_000
/** …e volta (reset) aqui. */
export const USAGE_BACK_AT = 84_000

/** Janela `five_hour` da conta no instante `t`: enche até esgotar e zera no reset. */
export function demoUsage(t: number, start: number, now: number): RateLimitStatus {
  const base = { rateLimitType: 'five_hour' as const, updatedAt: now }
  if (t < USAGE_OUT_AT) {
    const utilization = 0.37 + 0.6 * (t / USAGE_OUT_AT)
    return { ...base, status: utilization < 0.8 ? 'allowed' : 'allowed_warning', utilization, resetsAt: start + (2 * 60 + 13) * 60_000 }
  }
  if (t < USAGE_BACK_AT) return { ...base, status: 'rejected', utilization: 1, resetsAt: start + USAGE_BACK_AT }
  const utilization = 0.02 + 0.1 * ((t - USAGE_BACK_AT) / (DEMO_LOOP_MS - USAGE_BACK_AT))
  return { ...base, status: 'allowed', utilization, resetsAt: start + USAGE_BACK_AT + 5 * 3_600_000 }
}
