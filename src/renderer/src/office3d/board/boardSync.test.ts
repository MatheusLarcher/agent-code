import { afterEach, describe, expect, it, vi } from 'vitest'
import { NEUTRAL_TEXT } from './boardModel'
import { at, event, fakeBoardApi, item, settle } from './boardTestKit'
import { appBoardApi, BoardSync, EVENTS_TIMEOUT_MS, MAX_EVENT_READS, POLL_BUSY_MS, POLL_IDLE_MS } from './boardSync'

afterEach(() => {
  vi.useRealTimers()
})

function setup(items = [item('a', { updatedAt: at(0) }), item('b', { updatedAt: at(0) })]) {
  const fake = fakeBoardApi({ available: true, items })
  let now = 1_000_000
  const sync = new BoardSync(fake.api, () => now)
  const walls: string[] = []
  sync.onWall = (id) => walls.push(id)
  return { ...fake, sync, walls, wait: (ms: number) => void (now += ms), get now() { return now } }
}

describe('BoardSync (dados ao vivo do quadro 3D)', () => {
  it('sala nova lê o quadro do projeto dela uma vez e mostra o estado atual sem replay (nenhum passo)', async () => {
    const s = setup()
    s.sync.setRooms([{ id: 'r1', cwd: 'C:/proj', busy: false }])
    await settle()
    expect(s.api.boardList.calls).toEqual([[{ projectCwd: 'C:/proj' }]])
    expect(s.sync.mirror('r1')?.shown.map((c) => c.id)).toEqual(['a', 'b'])
    expect(s.sync.steps.size).toBe(0)
    expect(s.api.boardItemEvents.calls).toEqual([])
    expect(s.walls).toEqual(['r1'])
    expect(s.sync.item('a')?.sourceTitle).toBe('Tarefa a')
  })

  it('mudança depois da abertura vira passos com autor e motivo, na ordem real; eventos só dos cartões que mudaram', async () => {
    const s = setup()
    s.sync.setRooms([{ id: 'r1', cwd: 'C:/proj', busy: false }])
    await settle()
    s.state.board = {
      available: true,
      items: [item('a', { sourceStatus: 'completed', revision: 3, updatedAt: at(7) }), item('b', { updatedAt: at(0) }), item('n', { updatedAt: at(5) })]
    }
    s.state.events.a = [
      event('a', at(0), { kind: 'created', toStatus: 'pending' }),
      event('a', at(3), { actor: 'agent', toStatus: 'in_progress' }),
      event('a', at(7), { actor: 'po', toStatus: 'completed', note: 'testes passaram' })
    ]
    s.state.events.n = [event('n', at(5), { kind: 'created', actor: 'po', toStatus: 'pending', note: 'faltou o deploy' })]
    s.emit('p1')
    await settle()
    expect(s.api.boardItemEvents.calls.map((c) => c[0]).sort()).toEqual(['a', 'n'])
    const steps = s.sync.steps.drain()
    expect(steps.map((x) => [x.cardId, x.kind, x.actor, x.text])).toEqual([
      ['a', 'moved', 'agent', 'mudou para fazendo'],
      ['n', 'new', 'po', 'faltou o deploy'],
      ['a', 'moved', 'po', 'testes passaram']
    ])
    // A parede só anda quando o passo é aplicado.
    expect(s.sync.mirror('r1')?.shown.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('sumido sem evento é do agente; leitura de eventos que falha sai neutra e não trava', async () => {
    const s = setup()
    s.sync.setRooms([{ id: 'r1', cwd: 'C:/proj', busy: false }])
    await settle()
    s.state.board = { available: true, items: [item('b', { poTitle: 'Novo', revision: 2, updatedAt: at(4) })] }
    s.state.events.b = new Error('banco fora')
    s.sync.refresh('r1')
    await settle()
    const steps = s.sync.steps.drain()
    expect(steps).toEqual([
      expect.objectContaining({ cardId: 'a', kind: 'removed', actor: 'agent' }),
      expect.objectContaining({ cardId: 'b', kind: 'renamed', actor: null, text: NEUTRAL_TEXT })
    ])
  })

  it('cartão que some e reaparece "voltou"', async () => {
    const s = setup()
    s.sync.setRooms([{ id: 'r1', cwd: 'C:/proj', busy: false }])
    await settle()
    const b = s.state.board.items[1]
    s.state.board = { available: true, items: [s.state.board.items[0]] }
    s.sync.refresh('r1')
    await settle()
    s.state.board = { available: true, items: [s.state.board.items[0], { ...b, revision: 4, updatedAt: at(9) }] }
    s.state.events.b = [event('b', at(9), { kind: 'restored', actor: 'user' })]
    s.sync.refresh('r1')
    await settle()
    expect(s.sync.steps.drain().map((x) => [x.cardId, x.kind, x.actor])).toEqual([
      ['b', 'removed', 'agent'],
      ['b', 'restored', 'user']
    ])
  })

  it('timeout da linha do tempo: o passo sai neutro depois de EVENTS_TIMEOUT_MS', async () => {
    vi.useFakeTimers()
    const s = setup()
    s.sync.setRooms([{ id: 'r1', cwd: 'C:/proj', busy: false }])
    await vi.advanceTimersByTimeAsync(0)
    s.state.board = { available: true, items: [item('a', { sourceStatus: 'in_progress', revision: 2, updatedAt: at(2) }), item('b', { updatedAt: at(0) })] }
    s.api.boardItemEvents = Object.assign(() => new Promise<never>(() => {}), { calls: [] })
    s.sync.refresh('r1')
    await vi.advanceTimersByTimeAsync(EVENTS_TIMEOUT_MS + 10)
    expect(s.sync.steps.drain()).toEqual([expect.objectContaining({ cardId: 'a', actor: null, text: NEUTRAL_TEXT })])
  })

  it('no máximo MAX_EVENT_READS linhas do tempo por retrato', async () => {
    const s = setup([])
    s.sync.setRooms([{ id: 'r1', cwd: 'C:/proj', busy: false }])
    await settle()
    s.state.board = { available: true, items: Array.from({ length: MAX_EVENT_READS + 3 }, (_, i) => item(`n${i}`, { updatedAt: at(i) })) }
    s.sync.refresh('r1')
    await settle()
    expect(s.api.boardItemEvents.calls.length).toBe(MAX_EVENT_READS)
    expect(s.sync.steps.drain().length).toBe(MAX_EVENT_READS + 3)
  })

  it(`ritmo: ${POLL_BUSY_MS / 1000} s com alguém trabalhando, ${POLL_IDLE_MS / 1000} s parada; pausado não lê; evento em voo vira UMA leitura a mais`, async () => {
    const s = setup()
    s.sync.setRooms([{ id: 'r1', cwd: 'C:/proj', busy: true }])
    await settle()
    s.wait(POLL_BUSY_MS - 1)
    s.sync.tick()
    expect(s.api.boardList.calls.length).toBe(1)
    s.wait(1)
    s.sync.tick()
    await settle()
    expect(s.api.boardList.calls.length).toBe(2)
    s.sync.setRooms([{ id: 'r1', cwd: 'C:/proj', busy: false }])
    s.wait(POLL_BUSY_MS)
    s.sync.tick()
    expect(s.api.boardList.calls.length).toBe(2)
    s.wait(POLL_IDLE_MS)
    s.sync.pause()
    s.sync.tick()
    s.emit('p1')
    await settle()
    expect(s.api.boardList.calls.length).toBe(2)
    s.sync.resume()
    s.emit('p1')
    s.emit('p1')
    await settle()
    expect(s.api.boardList.calls.length).toBe(4)
    // Outro projeto não relê esta sala.
    s.emit('outro')
    await settle()
    expect(s.api.boardList.calls.length).toBe(4)
  })

  it('volta da pausa aplica direto (sem passos do intervalo)', async () => {
    const s = setup()
    s.sync.setRooms([{ id: 'r1', cwd: 'C:/proj', busy: false }])
    await settle()
    s.sync.pause()
    s.state.board = { available: true, items: [item('a', { sourceStatus: 'completed', revision: 2, updatedAt: at(3) })] }
    s.sync.resume()
    await settle()
    expect(s.sync.steps.size).toBe(0)
    expect(s.sync.mirror('r1')?.shown.map((c) => `${c.id}:${c.status}`)).toEqual(['a:completed'])
  })

  it('banco fora: indisponível (diferente de vazio); IPC que falha na 1ª leitura também', async () => {
    const s = setup()
    s.state.board = { available: false, items: [] }
    s.sync.setRooms([{ id: 'r1', cwd: 'C:/proj', busy: false }])
    await settle()
    expect(s.sync.mirror('r1')?.available).toBe(false)
    const broken = new BoardSync({ ...s.api, boardList: () => Promise.reject(new Error('ipc')) })
    broken.setRooms([{ id: 'r2', cwd: 'C:/x', busy: false }])
    await settle()
    expect(broken.mirror('r2')?.available).toBe(false)
  })

  it('arrasto: otimista, boardMove do cartão e releitura; recusa volta com a mensagem do main', async () => {
    const s = setup()
    s.sync.setRooms([{ id: 'r1', cwd: 'C:/proj', busy: false }])
    await settle()
    const ok = await s.sync.move('r1', 'a', 'in_progress')
    expect(ok).toEqual({ ok: true })
    expect(s.api.boardMove.calls).toEqual([['a', 'in_progress']])
    s.state.moveResult = { ok: false, message: 'Abra esta conversa e mande uma mensagem para o agente começar antes de mover pelo quadro.' }
    const p = s.sync.move('r1', 'b', 'in_progress')
    expect(s.sync.mirror('r1')?.card('b')?.status).toBe('in_progress')
    const refused = await p
    expect(refused.ok).toBe(false)
    expect(refused.message).toContain('Abra esta conversa')
    expect(s.sync.mirror('r1')?.card('b')?.status).toBe('pending')
  })

  it('fora do app (sem window.api do quadro) não há quadro', () => {
    expect(appBoardApi()).toBeNull()
    const off = new BoardSync(null)
    off.setRooms([{ id: 'r', cwd: 'C:/x', busy: true }])
    off.tick()
    expect(off.enabled).toBe(false)
    expect(off.mirror('r')?.loaded).toBe(false)
  })
})
