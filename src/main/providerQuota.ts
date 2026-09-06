/** Only inspect provider errors, never ordinary assistant/user/tool text. */
export function isUsageExhausted(error: unknown): boolean {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /usage_limit_reached|insufficient_quota|credit balance is too low|out of (?:usage|credits)|(?:you['’]ve |you have )?(?:hit|reached) your (?:usage )?limit|usage limit (?:has been )?(?:reached|exceeded)|(?:limite de uso|cr[eé]ditos).{0,80}(?:atingido|esgotad)/iu.test(text)
}

export function sdkUsageExhausted(message: unknown): boolean {
  const m = message as { type?: string; error?: string; message?: { content?: unknown }; errors?: string[] }
  if (m.type === 'assistant' && m.error) {
    if (m.error === 'billing_error') return true
    // A bare 429 can mean temporary throttling. Require the provider's quota message.
    return isUsageExhausted(JSON.stringify(m.message?.content ?? ''))
  }
  return Array.isArray(m.errors) && m.errors.some(isUsageExhausted)
}
