import { describe, expect, it } from 'vitest'
import { VISUAL_GATE_MESSAGE, newVisualGateState, noteVisualTurn, visualGateReminder } from './visualGate'

const main = { isSubagent: false, inTurn: true }
const edit = (file_path: string): Record<string, unknown> => ({ file_path, old_string: 'a', new_string: 'b' })

describe('visualGate', () => {
  it('edição de .tsx sem print no turno → lembrete uma vez só', () => {
    const s = newVisualGateState()
    expect(visualGateReminder(s, 'Edit', edit('src/App.tsx'), main)).toBe(VISUAL_GATE_MESSAGE)
    expect(visualGateReminder(s, 'Write', edit('src/app.css'), main)).toBeNull()
  })

  it('print antes da edição → sem lembrete', () => {
    for (const check of [
      ['mcp__browser__browser_screenshot', {}],
      ['mcp__windows__windows_get_state', {}],
      ['mcp__app__app_anexar_print', {}],
      ['Read', { file_path: 'C:/tmp/tela.PNG' }]
    ] as const) {
      const s = newVisualGateState()
      visualGateReminder(s, check[0], check[1], main)
      expect(visualGateReminder(s, 'Edit', edit('src/App.tsx'), main)).toBeNull()
    }
  })

  it('.ts comum, Read de .ts e Bash → sem lembrete', () => {
    const s = newVisualGateState()
    expect(visualGateReminder(s, 'Read', edit('src/a.ts'), main)).toBeNull()
    expect(visualGateReminder(s, 'Edit', edit('src/main/a.ts'), main)).toBeNull()
    expect(visualGateReminder(s, 'Bash', { command: 'echo > a.tsx' }, main)).toBeNull()
    // o Read de .ts não marcou conferência: a edição de tela ainda lembra
    expect(visualGateReminder(s, 'MultiEdit', edit('index.html'), main)).toBe(VISUAL_GATE_MESSAGE)
  })

  it('subagente e fora de turno → nada', () => {
    const s = newVisualGateState()
    expect(visualGateReminder(s, 'Edit', edit('a.tsx'), { isSubagent: true, inTurn: true })).toBeNull()
    expect(visualGateReminder(s, 'Edit', edit('a.tsx'), { isSubagent: false, inTurn: false })).toBeNull()
  })

  it('turno novo zera o lembrete e a conferência', () => {
    const s = newVisualGateState()
    visualGateReminder(s, 'mcp__browser__browser_screenshot', {}, main)
    noteVisualTurn(s)
    expect(visualGateReminder(s, 'Edit', edit('a.vue'), main)).toBe(VISUAL_GATE_MESSAGE)
    noteVisualTurn(s)
    expect(visualGateReminder(s, 'Edit', edit('a.scss'), main)).toBe(VISUAL_GATE_MESSAGE)
  })
})
