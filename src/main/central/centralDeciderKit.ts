import { vi } from 'vitest'
import type { CentralRecent, CentralRouteRequest, CentralTarget } from '../../shared/central'
import type { AskFn } from './centralDecider'
import { buildCentralIndex, type CentralConversationSummary, type CentralIndex } from './centralIndex'
import type { CentralAskRequest } from './centralPrompts'
import { SANDBOX_ROOT, sbx, sum } from './centralTestKit'

/**
 * Fixtures dos testes do decisor: um índice pequeno (alpha, beta e o sandbox), o
 * `ask` de mentira com respostas prontas por chamada e atalhos de pedido/destino.
 */

export { SANDBOX_ROOT }
export const ALPHA = 'C:\\work\\alpha'
export const BETA = 'C:\\work\\beta'

/** alpha (a1 mais recente, a2), beta (b1) e o sandbox (s1): nesta ordem de recência. */
export const SUMMARIES: CentralConversationSummary[] = [
  sum('a1', { title: 'Login torto', firstRequest: 'arruma o login', files: ['src/login.tsx'], updatedAt: 50 }),
  sum('a2', { title: 'Relatório PDF', firstRequest: 'gera o pdf', updatedAt: 40 }),
  sum('b1', { cwd: BETA, project: 'beta', title: 'API de pagamentos', updatedAt: 30 }),
  sbx('s1', 'x1', { title: 'Cotação do dólar', updatedAt: 20 })
]

export function makeIndex(summaries: CentralConversationSummary[] = SUMMARIES): CentralIndex {
  return buildCentralIndex(summaries, { sandboxRoot: SANDBOX_ROOT, exists: () => true })
}

export const target = {
  a1: { kind: 'conversation', convId: 'a1', cwd: ALPHA, project: 'alpha', title: 'Login torto', sandbox: false },
  a2: { kind: 'conversation', convId: 'a2', cwd: ALPHA, project: 'alpha', title: 'Relatório PDF', sandbox: false },
  b1: { kind: 'conversation', convId: 'b1', cwd: BETA, project: 'beta', title: 'API de pagamentos', sandbox: false },
  s1: {
    kind: 'conversation',
    convId: 's1',
    cwd: `${SANDBOX_ROOT}\\x1`,
    project: 'sandbox',
    title: 'Cotação do dólar',
    sandbox: true
  },
  newAlpha: { kind: 'new-conversation', cwd: ALPHA, project: 'alpha' },
  newBeta: { kind: 'new-conversation', cwd: BETA, project: 'beta' },
  newSandbox: { kind: 'new-sandbox' }
} satisfies Record<string, CentralTarget>

/** Uma resposta `choice` como o SDK devolve. */
export function pick(choice: string, confidence: number, probabilities: Record<string, number> = { [choice]: confidence }) {
  return { type: 'choice', choice, confidence, probabilities }
}

type Answers = Record<string, unknown> | null

/** `ask` de mentira: responde a 1ª ou a 2ª chamada (a que tem a pergunta `conversa`) e guarda os pedidos. */
export function fakeAsk(script: { first?: Answers; second?: Answers } = {}) {
  const calls: CentralAskRequest[] = []
  const spy = vi.fn(async (request: CentralAskRequest): Promise<Answers> => {
    calls.push(request)
    return 'conversa' in request.questions ? (script.second ?? null) : (script.first ?? null)
  })
  return { ask: spy as AskFn, spy, calls }
}

export function routeRequest(text: string, over: Partial<CentralRouteRequest> = {}): CentralRouteRequest {
  return { text, attachments: [], recent: [], ...over }
}

export const recent = (convId: string, over: Partial<CentralRecent> = {}): CentralRecent => ({
  convId,
  request: `pedido ${convId}`,
  replyStart: `resposta ${convId}`,
  ...over
})

/** O `state` de uma chamada, como objeto (o tipo do SDK é largo demais para ler campos). */
export const stateOf = (request: CentralAskRequest | undefined): Record<string, any> =>
  (request?.state ?? {}) as Record<string, any>

/** As chaves oferecidas numa pergunta. */
export const optionsOf = (request: CentralAskRequest | undefined, question: string): string[] => {
  const q = request?.questions[question]
  return q && q.type === 'choice' ? Object.keys(q.criteria) : []
}
