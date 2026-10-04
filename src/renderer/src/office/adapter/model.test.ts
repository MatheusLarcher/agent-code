import { describe, expect, it } from 'vitest'
import type { PermissionRequest } from '@shared/ipc'
import { buildCrew, callSegments, lineText } from '../../crew'
import { deriveOfficeModel, roomIdFor, type OfficeCharacterModel } from './model'
import { scanTurn } from './turn'
import { HOUR, NOW, conv, feed, toolUse, track, user } from './testFeed'

const byKey = (chars: OfficeCharacterModel[], key: string): OfficeCharacterModel | undefined => chars.find((c) => c.key === key)
const perm = (questions?: boolean): PermissionRequest => ({
  id: 'p',
  toolName: questions ? 'AskUserQuestion' : 'Bash',
  input: {},
  ...(questions ? { questions: [] } : {})
})

describe('quem entra no escritório', () => {
  it('regra das 12 h e as exceções (ativa, busy, pendência)', () => {
    const old = (id: string) => conv(id, { updatedAt: NOW - 13 * HOUR })
    const m = deriveOfficeModel(
      feed({
        conversations: [conv('recente'), old('velha'), old('ativa'), old('ocupada'), old('perm'), old('vigia')],
        activeId: 'ativa',
        busyIds: new Set(['ocupada']),
        permissions: { perm: perm() },
        vigiaAlerts: { vigia: { question: '?', options: [] } as never }
      }),
      NOW
    )
    const ids = m.characters.filter((c) => c.role === 'principal').map((c) => c.convId).sort()
    expect(ids).toEqual(['ativa', 'ocupada', 'perm', 'recente', 'vigia'])
  })

  it('duas conversas de projetos diferentes → duas salas com nome e ícone', () => {
    const m = deriveOfficeModel(
      feed({
        conversations: [conv('a', { cwd: 'C:\\proj\\Alpha' }), conv('b', { cwd: 'D:/work/beta/' }), conv('c', { cwd: 'c:/proj/alpha' })],
        projectIcons: { 'C:\\proj\\Alpha': 'data:icon' }
      }),
      NOW
    )
    expect(m.rooms).toEqual([
      { id: 'c:/proj/alpha', projectKey: 'C:\\proj\\Alpha', name: 'Alpha', icon: 'data:icon', principals: 2 },
      { id: 'd:/work/beta', projectKey: 'D:/work/beta/', name: 'beta', icon: null, principals: 1 }
    ])
    expect(roomIdFor('/home/x/Proj/')).toBe('/home/x/Proj')
  })

  it('a Central vira UM personagem no console (sem sala, nem para o cwd vazio dela); conversa sem pasta não vira sala', () => {
    const m = deriveOfficeModel(feed({ conversations: [conv('central', { cwd: '', mode: 'central' } as never), conv('solta', { cwd: '' }), conv('a')], activeId: 'central' }), NOW)
    const central = m.characters.filter((c) => c.convId === 'central')
    expect(central).toHaveLength(1)
    expect(central[0]).toMatchObject({ key: 'conv:central', roomId: null, role: 'principal', placement: { kind: 'destination', papel: 'central' } })
    expect(m.rooms.map((r) => r.id)).toEqual(['c:/proj/alpha'])
    expect(m.characters.some((c) => c.convId === 'solta')).toBe(false)
  })

  it('conversa de planejamento entra como as outras', () => {
    const m = deriveOfficeModel(feed({ conversations: [conv('p', { mode: 'planning', planningSlug: 's' })] }), NOW)
    expect(byKey(m.characters, 'conv:p')).toBeDefined()
  })
})

describe('estado do principal', () => {
  const busy = (msgs: ReturnType<typeof toolUse>[]) =>
    deriveOfficeModel(feed({ conversations: [conv('a', { messages: [user('u'), ...msgs] })], busyIds: new Set(['a']) }), NOW)
      .characters[0]

  it('Edit → type, Read/Grep → read, com rótulo no formato do cartão', () => {
    const edit = busy([toolUse('t1', 'Edit', { file_path: 'C:/x/src/a.ts', old_string: 'a', new_string: 'b\nc' })])
    expect(edit.active).toBe(true)
    expect(edit.activity).toBe('type')
    expect(edit.label).toBe(`Edit ${lineText(callSegments('Edit', { file_path: 'C:/x/src/a.ts', old_string: 'a', new_string: 'b\nc' }))}`)
    expect(busy([toolUse('t1', 'Read', { file_path: 'a.ts' })]).activity).toBe('read')
    expect(busy([toolUse('t1', 'Grep', { pattern: 'x' })]).activity).toBe('read')
    // Ferramenta já com resultado: não está mais nela.
    expect(busy([toolUse('t1', 'Edit', {}, true)]).activity).toBeNull()
  })

  it('rótulo sem ferramenta = lineText do CrewMember principal', () => {
    const c = deriveOfficeModel(feed({ conversations: [conv('a')] }), NOW).characters[0]
    const member = buildCrew({ tracks: {}, busy: false, busySince: null, vigia: null, po: null, poEnabled: false, vigiaEnabled: false, now: NOW })[0]
    expect(c.label).toBe(lineText(member.line))
  })

  it('permissão em sala que não é a ativa → permissao; AskUserQuestion → pergunta', () => {
    const m = deriveOfficeModel(
      feed({
        conversations: [conv('a'), conv('b', { cwd: 'D:/outro' }), conv('c', { cwd: 'D:/outro' })],
        activeId: 'a',
        permissions: { b: perm(), c: perm(true) }
      }),
      NOW
    )
    expect(byKey(m.characters, 'conv:b')!.bubble).toBe('permissao')
    expect(byKey(m.characters, 'conv:c')!.bubble).toBe('pergunta')
  })

  it('erro do turno → erro; turno novo limpa; ok por 2 s; ampulheta', () => {
    const at = (messages: never[], over = {}) =>
      deriveOfficeModel(feed({ conversations: [conv('a', { messages })], ...over }), NOW).characters[0].bubble
    expect(at([user('u'), { kind: 'error', id: 'e', text: 'x' }] as never[])).toBe('erro')
    expect(at([user('u', 'falhou')] as never[])).toBe('erro')
    expect(at([user('u'), { kind: 'error', id: 'e', text: 'x' }, user('u2')] as never[])).toBeNull()
    const answer = (ts: number) => [user('u'), { kind: 'assistant-text', id: 'a', text: 'fim', final: true, answer: true, ts }] as never[]
    expect(at(answer(NOW - 500))).toBe('ok')
    expect(at(answer(NOW - 3000))).toBeNull()
    expect(at([] as never[], { stalledSince: { a: NOW } })).toBe('ampulheta')
  })

  it('contexto do último result com o limite do modelo', () => {
    const c = deriveOfficeModel(feed({ conversations: [conv('a', { tokens: { context: 5000, output: 0, cost: 0 } })] }), NOW).characters[0]
    expect(c.context?.tokens).toBe(5000)
    expect(c.context?.max).toBeGreaterThan(5000)
  })

  it('scanTurn para no começo do turno', () => {
    const s = scanTurn([toolUse('velho', 'Edit', {}), user('u')])
    expect(s.tool).toBeNull()
  })
})

describe('elenco por sala', () => {
  it('especialista no slot do papel e reforco com 2 em paralelo; 3º vira subagente', () => {
    const m = deriveOfficeModel(
      feed({
        conversations: [conv('a'), conv('b')],
        tracks: {
          a: { t1: track('t1', { startedAt: NOW - 3000 }) },
          b: { t2: track('t2', { startedAt: NOW - 2000 }), t3: track('t3', { startedAt: NOW - 1000 }) }
        }
      }),
      NOW
    )
    const room = 'c:/proj/alpha'
    const main = byKey(m.characters, `role:${room}:executor`)!
    expect(main.trackId).toBe('t3')
    expect(main.placement).toEqual({ kind: 'seat', seatKind: 'especialista', slot: 'executor' })
    expect(byKey(m.characters, `role:${room}:executor:reforco`)!.placement).toEqual({ kind: 'seat', seatKind: 'especialista', slot: 'reforco' })
    expect(byKey(m.characters, 'track:t1')!.placement).toEqual({ kind: 'beside', parentKey: `role:${room}:executor` })
    // Rótulo = lineText do CrewMember do papel (Equipe).
    const crew = buildCrew({ tracks: { t3: track('t3', { startedAt: NOW - 1000 }) }, busy: false, busySince: null, vigia: null, po: null, poEnabled: false, vigiaEnabled: false, now: NOW })
    expect(main.label).toBe(lineText(crew.find((x) => x.role === 'executor')!.line))
    expect(main.activity).toBe('type')
  })

  it('subagente genérico entra ao lado do principal e sai quando a trilha acaba', () => {
    const gen = track('g', { subagentType: 'Explore', label: 'Explore: x' })
    const on = deriveOfficeModel(feed({ conversations: [conv('a')], tracks: { a: { g: gen } } }), NOW)
    expect(byKey(on.characters, 'track:g')!.placement).toEqual({ kind: 'beside', parentKey: 'conv:a' })
    const off = deriveOfficeModel(feed({ conversations: [conv('a')], tracks: { a: { g: { ...gen, status: 'done' } } } }), NOW)
    expect(byKey(off.characters, 'track:g')).toBeUndefined()
  })

  it('memória na estante de Memórias (do projeto), PO perto do kanban, vigia ao lado do principal', () => {
    const m = deriveOfficeModel(
      feed({
        conversations: [conv('a')],
        tracks: { a: { m: track('m', { subagentType: 'memoria' }) } },
        poDiagnostics: { a: { phase: 'audit-started', at: NOW } as never },
        vigiaAlerts: { a: { question: '?', options: [] } as never }
      }),
      NOW
    )
    const mem = byKey(m.characters, 'role:c:/proj/alpha:memoria')!
    expect(mem.roomId).toBe('c:/proj/alpha')
    expect(mem.placement).toMatchObject({ kind: 'destination', papel: 'arquivo-memorias' })
    const po = byKey(m.characters, 'po:c:/proj/alpha')!
    expect(po.placement).toMatchObject({ kind: 'destination', papel: 'kanban' })
    expect(po.active).toBe(true)
    expect(byKey(m.characters, 'vigia:a')).toMatchObject({ bubble: 'pergunta', placement: { kind: 'beside', parentKey: 'conv:a' } })
    const noPo = deriveOfficeModel(feed({ conversations: [conv('a')], poDiagnostics: { a: { phase: 'audit-started', at: NOW } as never }, observersOn: { po: false, vigia: true, memorista: true } }), NOW)
    expect(byKey(noPo.characters, 'po:c:/proj/alpha')).toBeUndefined()
  })
})
