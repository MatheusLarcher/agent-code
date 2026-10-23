import { describe, expect, it } from 'vitest'
import { buildPlanningAppend } from '../planning/planningSession'
import { AGENT_RULES_HINT } from './agentRules'

describe('AGENT_RULES_HINT (resources/agent.md)', () => {
  it('traz a regra das skills de front e a exceção pedida pelo usuário', () => {
    expect(AGENT_RULES_HINT).toContain('`frontend-design`')
    expect(AGENT_RULES_HINT).toMatch(/quando o usuário disser para não\s+usar/)
  })

  it('entra também no system prompt do Agent Manager, antes da memória', () => {
    const append = buildPlanningAppend('C:\\projeto', 'plano-x', ['MEMORY HINT'])
    expect(append).toContain(AGENT_RULES_HINT)
    expect(append.indexOf(AGENT_RULES_HINT)).toBeLessThan(append.indexOf('MEMORY HINT'))
  })
})
