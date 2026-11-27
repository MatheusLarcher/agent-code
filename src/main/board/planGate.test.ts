// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { newPlanGateState, notePlanTool, notePlanTurn, planGateReminder } from './planGate'

const main = { enabled: true, isSubagent: false, inTurn: true }

describe('trava do plano', () => {
  it('recusa a primeira escrita de arquivo enquanto o plano não foi declarado', () => {
    const state = newPlanGateState()
    const denial = planGateReminder(state, 'Write', main)
    expect(denial).toMatch(/TaskCreate/)
  })

  it('depois de declarar o plano, a escrita passa', () => {
    const state = newPlanGateState()
    notePlanTool(state, 'TaskCreate')
    expect(planGateReminder(state, 'Write', main)).toBeNull()
    expect(planGateReminder(state, 'Edit', main)).toBeNull()
  })

  it('TodoWrite também conta como declaração', () => {
    const state = newPlanGateState()
    notePlanTool(state, 'TodoWrite')
    expect(planGateReminder(state, 'Write', main)).toBeNull()
  })

  it('recusa UMA vez por turno — a segunda tentativa passa', () => {
    const state = newPlanGateState()
    expect(planGateReminder(state, 'Write', main)).not.toBeNull()
    expect(planGateReminder(state, 'Write', main)).toBeNull()
  })

  it('o direito de recusar volta no turno seguinte, mas o plano declarado não se perde', () => {
    const state = newPlanGateState()
    planGateReminder(state, 'Write', main)
    notePlanTurn(state)
    expect(planGateReminder(state, 'Write', main)).not.toBeNull()

    notePlanTool(state, 'TaskCreate')
    notePlanTurn(state)
    // Plano da conversa atravessa turnos: exigir declaração nova a cada
    // mensagem transformaria a trava em ruído.
    expect(planGateReminder(state, 'Write', main)).toBeNull()
  })

  it('não trava Bash, Read nem ferramenta de plano', () => {
    const state = newPlanGateState()
    expect(planGateReminder(state, 'Bash', main)).toBeNull()
    expect(planGateReminder(state, 'Read', main)).toBeNull()
    expect(planGateReminder(state, 'TaskCreate', main)).toBeNull()
    // Nenhuma dessas gastou a recusa: a escrita seguinte ainda é barrada.
    expect(planGateReminder(state, 'Write', main)).not.toBeNull()
  })

  it('não vale para subagente — quem declara o plano é a thread principal', () => {
    const state = newPlanGateState()
    expect(planGateReminder(state, 'Write', { enabled: true, isSubagent: true, inTurn: true })).toBeNull()
  })

  it('desligada na configuração não interfere em nada', () => {
    const state = newPlanGateState()
    expect(planGateReminder(state, 'Write', { enabled: false, isSubagent: false, inTurn: true })).toBeNull()
  })

  it('fora de um turno não trava nada — não há pedido do usuário para planejar', () => {
    const state = newPlanGateState()
    expect(planGateReminder(state, 'Write', { enabled: true, isSubagent: false, inTurn: false })).toBeNull()
  })

  it('cobre as quatro ferramentas que escrevem no projeto', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      expect(planGateReminder(newPlanGateState(), tool, main), tool).not.toBeNull()
    }
  })
})
