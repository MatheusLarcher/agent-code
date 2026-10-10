import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPlanningHint } from './planningPrompt'

/** A seção ### Handoff do prompt do Agent Manager como era antes dos
 *  interruptores do handoff: sem eles (ou desligados), tem que continuar igual. */
describe('buildPlanningHint — golden da seção ### Handoff', () => {
  it('sem interruptores = o texto de hoje', async () => {
    const hint = buildPlanningHint({
      slug: 'checkout',
      planDir: path.resolve('/dados/agent-code/planning/app/checkout'),
      sandboxDir: path.resolve('/projeto-planning/app/_sandbox')
    })
    await expect(hint.slice(hint.indexOf('### Handoff'))).toMatchFileSnapshot('./__golden__/hint-handoff.txt')
  })
})
