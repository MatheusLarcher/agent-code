import { describe, expect, it } from 'vitest'
import type { OfficeCharacterModel } from '../office/adapter/model'
import { conv, feed, track } from '../office/adapter/testFeed'
import type { UIMessage } from '../types'
import { deviceOf, PROJECTOR_IDLE_MS, ProjectorTracker, scanDeviceUse, titleFromResult, type DeviceUse } from './projectorUse'

const ROOM = 'c:/proj/alpha'
const principal = (id: string): OfficeCharacterModel => ({
  key: `conv:${id}`, convId: id, roomId: ROOM, role: 'principal', placement: { kind: 'seat', seatKind: 'principal' },
  seed: `conv:${id}`, active: true, activity: null, bubble: null, label: ''
})
const tool = (id: string, name: string, input: unknown, result?: string): UIMessage => ({
  kind: 'tool-use', id, name, input, parentToolUseId: null, ...(result !== undefined ? { result: { isError: false, text: result } } : {})
})

describe('deviceOf: o que desce a tela do projetor', () => {
  it('navegador embutido e Chrome são web; Android com tela é android; toolchain e o resto, nada', () => {
    expect(deviceOf('mcp__browser__browser_navigate')).toBe('web')
    expect(deviceOf('mcp__chrome__chrome_screenshot')).toBe('web')
    expect(deviceOf('mcp__android__android_tap')).toBe('android')
    expect(deviceOf('mcp__android__android_install_run')).toBe('android')
    for (const name of ['mcp__android__android_setup', 'mcp__android__android_build_apk', 'mcp__android__android_list_devices', 'mcp__android__android_list_device_models', 'Edit', 'WebFetch', 'mcp__tasks__task_get']) {
      expect(deviceOf(name), name).toBeNull()
    }
  })

  it('o título vem do resultado do navigate', () => {
    expect(titleFromResult('Navegou para http://localhost:5173/ — "Loja · Carrinho" (aba: "web - Loja").')).toBe('Loja · Carrinho')
    expect(titleFromResult('{"title": "Docs"}')).toBe('Docs')
    expect(titleFromResult(undefined)).toBe('')
  })
})

describe('scanDeviceUse', () => {
  it('principal: a última chamada do turno (aberta ou não), a última URL navegada e o título; o turno anterior não conta', () => {
    const msgs: UIMessage[] = [
      { kind: 'user', id: 'u0', text: 'antes' },
      tool('old', 'mcp__browser__browser_navigate', { url: 'http://velho' }, 'Navegou para http://velho — "Velho" (aba: "x").'),
      { kind: 'user', id: 'u1', text: 'testa a loja' },
      tool('n1', 'mcp__browser__browser_navigate', { url: 'http://localhost:5173/carrinho' }, 'Navegou para http://localhost:5173/carrinho — "Carrinho" (aba: "web - Carrinho").'),
      tool('e1', 'Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, 'ok'),
      tool('s1', 'mcp__browser__browser_screenshot', {})
    ]
    const f = feed({ conversations: [conv('a', { messages: msgs })], busyIds: new Set(['a']) })
    const [use] = scanDeviceUse(f, [principal('a')])
    expect(use).toEqual({ roomId: ROOM, convId: 'a', key: 'conv:a', kind: 'web', lastId: 's1', open: true, busy: true, url: 'http://localhost:5173/carrinho', title: 'Carrinho' })
    // Turno novo sem navegador: ninguém usa.
    const next = feed({ conversations: [conv('a', { messages: [...msgs, { kind: 'user', id: 'u2', text: 'outra coisa' }] })] })
    expect(scanDeviceUse(next, [principal('a')])).toEqual([])
  })

  it('subagente: os passos da trilha; Android pega o nome do app do install_run', () => {
    const t = track('T', {
      steps: [
        { id: 'k1', name: 'mcp__android__android_install_run', input: { apkPath: 'app.apk', appName: 'Portal' }, startedAt: 1, endedAt: 2, result: 'ok' },
        { id: 'k2', name: 'mcp__android__android_tap', input: { nx: 0.5, ny: 0.5 }, startedAt: 3 }
      ]
    })
    const f = feed({ conversations: [conv('a')], tracks: { a: { T: t } } })
    const sub: OfficeCharacterModel = { ...principal('a'), key: 'track:T', role: 'executor', trackId: 'T' }
    expect(scanDeviceUse(f, [sub])).toEqual([{ roomId: ROOM, convId: 'a', key: 'track:T', kind: 'android', lastId: 'k2', open: true, busy: true, url: '', title: 'Portal' }])
    // Sem sala (corredor) ou observador: fora.
    expect(scanDeviceUse(f, [{ ...sub, roomId: null }])).toEqual([])
  })
})

describe('ProjectorTracker: a tela desce no uso e sobe sem uso', () => {
  const use = (over: Partial<DeviceUse> = {}): DeviceUse => ({ roomId: ROOM, convId: 'a', key: 'conv:a', kind: 'web', lastId: 'c1', open: false, busy: false, url: '', title: '', ...over })
  const T = 1_000_000

  it('1º feed: histórico parado não desce; quem trabalha agora desce', () => {
    const idle = new ProjectorTracker()
    idle.update([use()], T)
    expect(idle.down(ROOM, T)).toBe(false)
    expect(idle.use(ROOM, T)?.convId).toBe('a') // a TV sabe quem foi o último
    const busy = new ProjectorTracker()
    busy.update([use({ busy: true })], T)
    expect(busy.down(ROOM, T)).toBe(true)
  })

  it(`chamada nova desce; sem chamada nova por ${PROJECTOR_IDLE_MS / 1000} s sobe; chamada aberta segura a tela`, () => {
    const tr = new ProjectorTracker()
    tr.update([], T)
    tr.update([use({ lastId: 'c2' })], T + 1_000)
    expect(tr.down(ROOM, T + 1_000)).toBe(true)
    // A mesma chamada nos feeds seguintes não renova.
    tr.update([use({ lastId: 'c2' })], T + 60_000)
    expect(tr.down(ROOM, T + 1_000 + PROJECTOR_IDLE_MS - 1)).toBe(true)
    expect(tr.down(ROOM, T + 1_000 + PROJECTOR_IDLE_MS)).toBe(false)
    // Aberta (o print demorando): cada feed renova.
    tr.update([use({ lastId: 'c3', open: true })], T + 200_000)
    tr.update([use({ lastId: 'c3', open: true })], T + 280_000)
    expect(tr.down(ROOM, T + 280_000 + PROJECTOR_IDLE_MS - 1)).toBe(true)
  })

  it('dois testando: fila — quem começou primeiro fica com a TV, o outro espera e assume quando o primeiro fica ocioso; outra sala não interfere', () => {
    const tr = new ProjectorTracker()
    tr.update([], T)
    tr.update([use({ lastId: 'a1' })], T + 1_000)
    const b = (lastId: string): DeviceUse => use({ key: 'conv:b', convId: 'b', lastId, kind: 'android' })
    tr.update([use({ lastId: 'a1' }), b('b1')], T + 5_000)
    expect(tr.queue(ROOM, T + 5_000).map((u) => u.convId)).toEqual(['a', 'b'])
    expect(tr.use(ROOM, T + 5_000)).toMatchObject({ convId: 'a' })
    // b continua usando (chamadas novas), a fica parado: passado o tempo de a, a vez é de b.
    tr.update([use({ lastId: 'a1' }), b('b2')], T + 60_000)
    expect(tr.use(ROOM, T + 60_000)?.convId).toBe('a')
    expect(tr.use(ROOM, T + 1_000 + PROJECTOR_IDLE_MS)?.convId).toBe('b')
    expect(tr.queue(ROOM, T + 1_000 + PROJECTOR_IDLE_MS).map((u) => u.convId)).toEqual(['b'])
    expect(tr.down('outra', T + 5_000)).toBe(false)
    tr.forget(ROOM)
    expect(tr.use(ROOM, T + 60_000)).toBeNull()
  })
})
