import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { APIError, TypeSafeClient } from '@typesafe-ai/sdk'
import type { AskFn } from '../centralDecider'
import type { CentralAskRequest } from '../centralPrompts'

/**
 * Calibração da Central, parte 3: o `ask` fora do Electron, memoizado. Cada
 * pedido idêntico (`{state, questions}`) é pago UMA vez: a memória responde de
 * novo na mesma rodada, e o arquivo de cache (pasta de saída, fora do git) nas
 * seguintes. O cache guarda só o hash do pedido e as respostas reduzidas a
 * chaves de opção e números — nunca o `state`, nunca a chave. Nada aqui loga o
 * `state` nem as respostas: falha conta pelo tipo do erro.
 */

/** Os mesmos 8 s e zero retentativas do cliente do app (typesafe/client.ts), sem importá-lo. */
export const CALIBRATION_TIMEOUT_MS = 8000

export type Answers = Readonly<Record<string, unknown>>

/** Uma chamada de verdade: as respostas e o uso em tokens. */
export type RawCall = (request: CentralAskRequest) => Promise<{ answers: unknown; usage?: unknown }>

export interface MemoAskStats {
  /** Chamadas que saíram para a rede. */
  network: number
  ok: number
  failed: number
  /** Respondidas pela memória ou pelo arquivo de cache (não contam no orçamento). */
  hits: number
  /** Falhas por tipo de erro (`AuthenticationError 401`, `APITimeoutError`…). */
  failures: Record<string, number>
  inputTokens: number
  outputTokens: number
}

export interface MemoAsk {
  ask: AskFn
  stats(): MemoAskStats
  /** Respostas conhecidas (cache carregado + chamadas desta rodada). */
  size(): number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** A identidade de um pedido: sha256 do JSON de `{state, questions}`. */
export function requestHash(request: CentralAskRequest): string {
  return createHash('sha256')
    .update(JSON.stringify({ state: request.state, questions: request.questions }))
    .digest('hex')
}

/**
 * Só o que o decisor lê de cada resposta `choice`: tipo, escolha, confiança e
 * probabilidades — chaves de opção (d1, p3, sem_projeto…) e números. Qualquer
 * outra coisa (ou outro tipo de pergunta) não é guardada. Nada aproveitável = null.
 */
export function keepAnswers(answers: unknown): Answers | null {
  if (!isRecord(answers)) return null
  const out: Record<string, unknown> = {}
  for (const [name, answer] of Object.entries(answers)) {
    if (!isRecord(answer) || answer.type !== 'choice' || typeof answer.choice !== 'string') continue
    const confidence = finite(answer.confidence)
    if (confidence === null || !isRecord(answer.probabilities)) continue
    const probabilities: Record<string, number> = {}
    for (const [key, p] of Object.entries(answer.probabilities)) {
      const value = finite(p)
      if (value !== null) probabilities[key] = value
    }
    out[name] = { type: 'choice', choice: answer.choice, confidence, probabilities }
  }
  return Object.keys(out).length > 0 ? out : null
}

/** O SDK direto, como typesafe/client.ts: 8 s, sem retentativa; log do SDK desligado (o `state` nunca vai ao console). */
export function typeSafeCall(apiKey: string): RawCall {
  const client = new TypeSafeClient({ apiKey, logLevel: 'off' })
  return async (request) => {
    const { answers, usage } = await client.systemOne(request, {
      timeout: CALIBRATION_TIMEOUT_MS,
      retry: { maxRetries: 0 }
    })
    return { answers, usage }
  }
}

/** O tipo da falha, sem a mensagem (a de um 4xx pode citar o corpo). */
function failureKind(error: unknown): string {
  if (error instanceof APIError) return `${error.name || 'APIError'} ${error.status}`
  if (error instanceof Error) return error.name || 'Error'
  return 'desconhecido'
}

function loadCache(file: string, into: Map<string, Answers>): void {
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const entry: unknown = JSON.parse(line)
      if (!isRecord(entry) || typeof entry.h !== 'string') continue
      const answers = keepAnswers(entry.a)
      if (answers) into.set(entry.h, answers)
    } catch {
      // Linha cortada (rodada interrompida no meio da escrita): é só perder aquela resposta.
    }
  }
}

/** O `ask` memoizado; `cacheFile` (opcional) é lido na criação e recebe cada resposta nova numa linha. */
export function createMemoAsk(call: RawCall, cacheFile?: string): MemoAsk {
  const memo = new Map<string, Answers>()
  if (cacheFile) loadCache(cacheFile, memo)
  const inflight = new Map<string, Promise<Answers | null>>()
  const stats: MemoAskStats = { network: 0, ok: 0, failed: 0, hits: 0, failures: {}, inputTokens: 0, outputTokens: 0 }

  async function fetchOnce(hash: string, request: CentralAskRequest): Promise<Answers | null> {
    stats.network++
    try {
      const { answers: raw, usage } = await call(request)
      if (isRecord(usage)) {
        stats.inputTokens += finite(usage.input_tokens) ?? 0
        stats.outputTokens += finite(usage.output_tokens) ?? 0
      }
      const answers = keepAnswers(raw)
      if (!answers) throw new TypeError('resposta sem choice aproveitável')
      memo.set(hash, answers)
      if (cacheFile) appendFileSync(cacheFile, `${JSON.stringify({ h: hash, a: answers })}\n`, 'utf8')
      stats.ok++
      return answers
    } catch (error) {
      stats.failed++
      const kind = failureKind(error)
      stats.failures[kind] = (stats.failures[kind] ?? 0) + 1
      return null
    }
  }

  const ask: AskFn = (request) => {
    const hash = requestHash(request)
    const known = memo.get(hash)
    if (known) {
      stats.hits++
      return Promise.resolve(known)
    }
    const running = inflight.get(hash)
    if (running) {
      stats.hits++
      return running
    }
    // Sai da lista depois de assentar (assíncrono: nunca antes do `set` logo abaixo).
    const promise = fetchOnce(hash, request).finally(() => inflight.delete(hash))
    inflight.set(hash, promise)
    return promise
  }

  return {
    ask,
    stats: () => ({ ...stats, failures: { ...stats.failures } }),
    size: () => memo.size
  }
}
