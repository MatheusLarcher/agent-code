// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { isUsageExhausted, sdkUsageExhausted } from './providerQuota'

/** Formato real da mensagem de estouro gravada pelo CLI (transcript de 26/09/2026). */
const cliLimitMessage = (text: string, error = 'rate_limit') => ({
  type: 'assistant',
  error,
  isApiErrorMessage: true,
  apiErrorStatus: 429,
  parent_tool_use_id: null,
  message: { role: 'assistant', model: '<synthetic>', type: 'message', content: [{ type: 'text', text }] }
})

describe('estouro definitivo: as mensagens reais do CLI', () => {
  // O CLI monta `You've hit your ${Sfe[rateLimitType]}` (session/weekly/Opus/Sonnet/Fable limit).
  it.each([
    "You've hit your weekly limit · resets 11pm (America/Sao_Paulo)",
    "You've hit your session limit · resets 2:10am (America/Sao_Paulo)",
    "You've hit your Opus limit · resets Oct 1, 9pm (America/Sao_Paulo)",
    "You've hit your Sonnet limit · resets 9pm (America/Sao_Paulo) · progress saved",
    "You've hit your Fable limit · resets 9pm (America/Sao_Paulo)",
    "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model",
    'Fable 5.1 requires usage credits. Switch to another model, or manage usage credits at claude.ai',
    "You've hit your limit · resets 8pm",
    "You've hit your usage limit",
    "You're out of usage credits · resets 9pm",
    // Outras montagens do mesmo binário (claude.exe 0.3.283, grep em 27/09/2026).
    "You've hit your usage credit limit · resets 9pm (America/Sao_Paulo)",
    "You've reached your Fable limit.",
    "You've hit your monthly spend limit.",
    "You've hit your channel's monthly spend limit.",
    "You've hit your team's shared budget. /model to switch models.",
    'Lower-priority mode ended · you have reached your weekly usage limit'
  ])('%s', (text) => {
    expect(isUsageExhausted(text)).toBe(true)
    expect(sdkUsageExhausted(cliLimitMessage(text))).toBe(true)
  })
})

describe('estouro definitivo: todos os prefixos da lista VBr do claude.exe 0.3.283', () => {
  // VBr = a lista que o próprio CLI usa para reconhecer o aviso de limite
  // (node_modules/.cache/verify-acct-3/cli-VBr.txt). As 5 primeiras escapavam da regex anterior.
  it.each([
    "You're out of extra usage · resets 11pm (America/Sao_Paulo)",
    "Your group's usage limit is set to $0 · ask your admin to raise it",
    'Your usage allocation has been disabled by your admin',
    "Your seat type doesn't include usage credits",
    "Your seat type doesn't include extra usage",
    // As demais entradas da VBr (já reconhecidas, fixadas aqui).
    "You've hit your weekly limit",
    "You've reached your Fable 5 limit.",
    "You're out of usage credits",
    'Your org is out of usage · add funds to continue',
    'Your org is out of usage · contact your admin',
    "Your seat type doesn't include usage",
    'Fable 5 requires usage credits. Switch to another model.',
    // Apóstrofo tipográfico.
    'Your seat type doesn’t include extra usage'
  ])('%s', (text) => {
    expect(isUsageExhausted(text)).toBe(true)
    expect(sdkUsageExhausted(cliLimitMessage(text))).toBe(true)
    expect(sdkUsageExhausted({ type: 'result', errors: [text] })).toBe(true)
  })
})

describe('"hit/reached your … limit" que NÃO é o plano esgotado', () => {
  it.each([
    "You've hit your rate limit. Try again in a few seconds.",
    "You've reached your context limit",
    "You've hit your concurrency limit",
    "You've reached your per-minute request limit",
    "You've hit your Opus fast limit · resets in 2m",
    "You've hit your fast limit · resets in 3m",
    'You have reached your output token limit',
    // Avisos de aproximação (KBr) e de entrada no uso extra (YBr): não são estouro.
    "You've used 90% of your weekly limit · resets 11pm (America/Sao_Paulo)",
    "You're close to your session limit",
    "You're now using extra usage",
    'Now using usage credits',
    'This service is disabled for your org'
  ])('%s', (text) => {
    expect(isUsageExhausted(text)).toBe(false)
    expect(sdkUsageExhausted(cliLimitMessage(text))).toBe(false)
  })

  it('o nome transitório não esconde um estouro real na mesma mensagem', () => {
    expect(isUsageExhausted("You've hit your rate limit. You've hit your weekly limit")).toBe(true)
  })
})

describe('as variações que a detecção já reconhecia continuam reconhecidas', () => {
  it.each([
    'usage_limit_reached',
    'insufficient_quota',
    'Your credit balance is too low to access the Anthropic API',
    'You are out of credits',
    'You have reached your limit',
    'You have reached your usage limit',
    'Usage limit reached for this plan',
    'Usage limit has been exceeded',
    'You have reached your specified API usage limits',
    'Limite de uso do plano atingido',
    'Créditos esgotados'
  ])('%s', (text) => {
    expect(isUsageExhausted(text)).toBe(true)
    expect(isUsageExhausted(new Error(text))).toBe(true)
    expect(sdkUsageExhausted({ type: 'result', errors: [text] })).toBe(true)
  })

  it('billing_error do SDK é estouro mesmo sem texto reconhecível', () => {
    expect(sdkUsageExhausted({ type: 'assistant', error: 'billing_error', message: { content: [] } })).toBe(true)
  })
})

describe('erro transitório não é estouro', () => {
  it.each([
    'Server is temporarily limiting requests (not your usage limit) · Rate limited',
    "You've hit your fast limit · resets in 3m",
    'Request rejected (429) · Too many requests',
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}',
    'API Error: 529 overloaded_error',
    'Fast mode overloaded and is temporarily unavailable',
    'Request timed out'
  ])('%s', (text) => {
    expect(isUsageExhausted(text)).toBe(false)
    expect(sdkUsageExhausted(cliLimitMessage(text))).toBe(false)
  })

  it('texto do modelo (sem o campo error do SDK) nunca conta como estouro', () => {
    const message = cliLimitMessage("You've hit your weekly limit · resets 11pm")
    expect(sdkUsageExhausted({ ...message, error: undefined })).toBe(false)
  })
})
