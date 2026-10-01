import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { browserRunStepsShape } from './browserTools'

const schema = z.object(browserRunStepsShape)
const errorOf = (input: unknown): string => {
  const r = schema.safeParse(input)
  return r.success ? '' : r.error.issues.map((i) => i.message).join('; ')
}

describe('browser_run_steps: validação zod', () => {
  it('aceita um plano completo', () => {
    const r = schema.safeParse({
      steps: [
        { action: 'fill', target: { label: 'Nome' }, value: 'Ana' },
        { action: 'select', target: { ref: 'e4' }, value: ['A', 'B'] },
        { action: 'check', target: { label: 'Aceito' } },
        { action: 'click', target: { text: 'Enviar' }, timeoutMs: 2000 },
        { action: 'wait_for', value: 'Obrigado' }
      ],
      expect: 'Obrigado'
    })
    expect(r.success).toBe(true)
  })

  it('recusa action desconhecida, fill sem value, click sem target, steps vazio e ref inválido', () => {
    expect(errorOf({ steps: [{ action: 'hover', target: { label: 'x' } }] })).not.toBe('')
    expect(errorOf({ steps: [{ action: 'fill', target: { label: 'Nome' } }] })).toMatch(/fill needs value/)
    expect(errorOf({ steps: [{ action: 'click' }] })).toMatch(/click needs target/)
    expect(errorOf({ steps: [] })).not.toBe('')
    expect(errorOf({ steps: [{ action: 'click', target: { ref: 'botao' } }] })).not.toBe('')
    expect(errorOf({ steps: [{ action: 'press', value: 'Enter', timeoutMs: 99 }] })).not.toBe('')
    expect(errorOf({ steps: [{ action: 'navigate', value: ['a'] }] })).toMatch(/must be a string/)
  })
})
