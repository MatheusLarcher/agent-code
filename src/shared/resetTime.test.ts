// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseResetFromError } from './resetTime'

// 24/09/2026 09:00 em São Paulo (UTC-3).
const NOW = Date.parse('2026-09-24T12:00:00Z')

describe('parseResetFromError (formatos do claude.exe 0.3.283, função ud)', () => {
  it.each([
    ["You've hit your weekly limit · resets 11pm (America/Sao_Paulo)", '2026-09-25T02:00:00Z'],
    ["You've hit your session limit · resets 2:10am (America/Sao_Paulo)", '2026-09-25T05:10:00Z'],
    ["You're out of extra usage · resets 10:30am (America/Sao_Paulo)", '2026-09-24T13:30:00Z'],
    ["You've hit your Opus limit · resets Oct 1, 9pm (America/Sao_Paulo)", '2026-10-02T00:00:00Z'],
    ["You've hit your weekly limit · resets Sep 30, 9:30pm (America/Sao_Paulo)", '2026-10-01T00:30:00Z'],
    ["You've hit your weekly limit · resets Jan 2, 2027, 8am (UTC)", '2027-01-02T08:00:00Z']
  ])('%s', (text, expected) => {
    expect(parseResetFromError(text, NOW)).toBe(Date.parse(expected))
  })

  it.each([
    "You've hit your limit · resets 8pm", // sem fuso: não dá para saber o instante
    "You've hit your fast limit · resets in 3m",
    "You've hit your Opus limit · resets Oct 1",
    "You've hit your weekly limit · resets Sep 1, 9pm (America/Sao_Paulo)", // data já passou: aviso velho
    'resets 9pm (Fuso/Inexistente)'
  ])('sem reset utilizável: %s', (text) => {
    expect(parseResetFromError(text, NOW)).toBeNull()
  })
})
