import { summarizeConversation, type CentralConversationSummary, type VersionedConversationLike } from './centralIndex'

/**
 * Fixtures dos testes do índice (resumidor, construtor e orçamento). O resumidor é
 * independente de plataforma (caminhos com \ e /): os testes usam caminhos do Windows
 * literais e valem em qualquer sistema.
 */

export const CWD = 'C:\\Users\\x\\proj'
export const notSandbox = (): boolean => false

let seq = 0
export const user = (text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'user',
  id: `u${++seq}`,
  text,
  ...extra
})
export const say = (text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'assistant-text',
  id: `a${++seq}`,
  text,
  final: true,
  ...extra
})
export const tool = (name: string, input: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'tool-use',
  id: `t${++seq}`,
  name,
  input,
  parentToolUseId: null,
  ...extra
})
export const inProj = (...parts: string[]): string => [CWD, ...parts].join('\\')

/** Uma linha de `loadConversations()`: o `id` vale para a linha e para o payload. */
export function conv(
  payload: Record<string, unknown> = {},
  row: Partial<VersionedConversationLike> = {}
): VersionedConversationLike {
  const id = row.id ?? (payload.id as string | undefined) ?? 'c1'
  return {
    id,
    payload: { id, title: 'Título', cwd: CWD, messages: [], updatedAt: 1_000, ...payload },
    updatedAt: '2026-10-02T10:00:00.000Z',
    ...row
  }
}

export const summarize = (payload: Record<string, unknown> = {}, row: Partial<VersionedConversationLike> = {}) =>
  summarizeConversation(conv(payload, row), notSandbox)

export const SANDBOX_ROOT = 'C:\\local\\sandbox'

/** Um resumo pronto (o que o resumidor devolveria), para os testes do construtor e do orçamento. */
export function sum(convId: string, over: Partial<CentralConversationSummary> = {}): CentralConversationSummary {
  return {
    convId,
    cwd: 'C:\\work\\alpha',
    project: 'alpha',
    sandbox: false,
    title: `Título ${convId}`,
    firstRequest: '',
    lastRequests: [],
    files: [],
    answerStart: '',
    updatedAt: 1,
    ...over
  }
}
export const sbx = (convId: string, name: string, over: Partial<CentralConversationSummary> = {}): CentralConversationSummary =>
  sum(convId, { cwd: `${SANDBOX_ROOT}\\${name}`, project: 'sandbox', sandbox: true, ...over })

export const exists = (): boolean => true
