import { describe, expect, it } from 'vitest'
import { DEMO_LOOP_MS } from '../demoTimeline'
import { BoardSync } from './boardSync'
import { settle } from './boardTestKit'
import { demoBoardApi } from './demoBoard'

const T0 = 14_916_667 * DEMO_LOOP_MS

describe('Quadro falso da demonstração (demoBoard)', () => {
  it('uma sala viva com todos os tipos de mudança e todos os autores, uma cheia, uma vazia e uma indisponível', async () => {
    let now = T0
    const sync = new BoardSync(demoBoardApi(() => now), () => now)
    const rooms = ['agent-code', 'loja-virtual', 'portal-aluno', 'api-pagamentos'].map((p) => ({ id: p, cwd: `C:\\demo\\${p}`, busy: true }))
    sync.setRooms(rooms)
    await settle()
    expect(sync.mirror('loja-virtual')?.shown.length).toBe(22)
    expect([sync.mirror('portal-aluno')?.available, sync.mirror('portal-aluno')?.shown.length]).toEqual([true, 0])
    expect(sync.mirror('api-pagamentos')?.available).toBe(false)
    const kinds = new Set<string>()
    const actors = new Set<string>()
    for (let s = 0; s < 100; s += 4) {
      now = T0 + s * 1000
      sync.refresh('agent-code')
      await settle()
      for (const step of sync.steps.drain()) {
        kinds.add(step.kind)
        if (step.actor) actors.add(step.actor)
      }
    }
    expect([...kinds].sort()).toEqual(['justified', 'moved', 'new', 'removed', 'renamed', 'restored'])
    expect([...actors].sort()).toEqual(['agent', 'po', 'system', 'user'])
    sync.dispose()
  })

  it('roteiro da coreografia: ida agrupada do mesmo agente (s 8) e conversa fora do escritório (s 20)', async () => {
    let now = T0 + 4_000
    const sync = new BoardSync(demoBoardApi(() => now), () => now)
    sync.setRooms([{ id: 'agent-code', cwd: 'C:\\demo\\agent-code', busy: true }])
    await settle()
    now = T0 + 9_000
    sync.refresh('agent-code')
    await settle()
    const grouped = sync.steps.drain()
    expect(grouped.map((s) => [s.actor, s.convId, s.kind]).sort()).toEqual([
      ['agent', 'demo-0-0', 'moved'],
      ['agent', 'demo-0-0', 'new']
    ])
    now = T0 + 21_000
    sync.refresh('agent-code')
    await settle()
    expect(sync.steps.drain().find((s) => s.kind === 'new')?.convId).toBe('demo-0-99')
    sync.dispose()
  })

  it('arrastar: "A fazer" ↔ "Concluído" grava; para "Fazendo" recusa com a mensagem do main', async () => {
    const api = demoBoardApi(() => T0 + 1000)
    const list = await api.boardList({ projectCwd: 'C:\\demo\\agent-code' })
    const pending = list.items.find((i) => (i.poStatus ?? i.sourceStatus) === 'pending') as (typeof list.items)[number]
    expect(await api.boardMove(pending.id, 'in_progress')).toEqual({ ok: false, message: expect.stringContaining('Abra esta conversa') })
    expect(await api.boardMove(pending.id, 'completed')).toEqual({ ok: true })
    const after = await api.boardList({ projectCwd: 'C:\\demo\\agent-code' })
    expect(after.items.find((i) => i.id === pending.id)?.poStatus).toBe('completed')
  })
})
