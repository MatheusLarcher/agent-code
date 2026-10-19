import { describe, expect, it } from 'vitest'
import { MODEL_HOLD_MS, ModelHold } from './modelHold'
import type { ConvSummary } from './types'

const conv = (id: string, model: string, effort: string): ConvSummary => ({ id, title: id, cwd: 'C:\\p', busy: true, connected: true, updatedAt: 1, queued: [], model, effort }) as ConvSummary

describe('ModelHold — a troca do celular não some no retrato seguinte', () => {
  it('retrato velho (a caminho antes da troca) não desfaz a escolha; o que já a traz encerra a trava', () => {
    let t = 0
    const hold = new ModelHold(() => t)
    hold.set('c1', { effort: 'max' })
    const stale = hold.apply([conv('c1', 'opus', 'high'), conv('c2', 'opus', 'low')])
    expect(stale[0].effort).toBe('max')
    expect(stale[1].effort).toBe('low')
    t += 4000
    expect(hold.apply([conv('c1', 'opus', 'max')])[0].effort).toBe('max')
    // Confirmada: um retrato posterior com outro valor (o PC mudou de novo) já vale.
    expect(hold.apply([conv('c1', 'opus', 'low')])[0].effort).toBe('low')
  })

  it('o PC recusou: depois do prazo a tela volta ao valor real', () => {
    let t = 0
    const hold = new ModelHold(() => t)
    hold.set('c1', { model: 'auto' })
    expect(hold.apply([conv('c1', 'opus', 'high')])[0].model).toBe('auto')
    t += MODEL_HOLD_MS + 1
    expect(hold.apply([conv('c1', 'opus', 'high')])[0].model).toBe('opus')
  })
})
