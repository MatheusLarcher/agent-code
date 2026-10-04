import { describe, expect, it } from 'vitest'
import type { HtmlWrite } from './agentHtml'
import type { OfficeCall } from './officeCalls'
import type { DeviceUse } from './projectorUse'
import { agendaConv, agendaSig, tvAgenda } from './tvAgenda'

const call = (id: string, convId = id): OfficeCall => ({ id, convId, key: `conv:${convId}`, cwd: 'C:\\p', path: `C:\\p\\${id}.html`, mensagem: null })
const test = (convId: string): DeviceUse => ({ key: `conv:${convId}`, convId, roomId: 'office', kind: 'web', url: 'http://x', title: 'x', open: true }) as DeviceUse
const html = (convId: string): HtmlWrite => ({ id: `w-${convId}`, convId, key: `conv:${convId}`, path: 'C:\\p\\a.html', ok: true })

describe('quem manda na TV (tvAgenda)', () => {
  it('1 chamado > 2 teste ao vivo (no quadrinho com chamado) > 4 último HTML > 5 placar', () => {
    expect(tvAgenda([call('c1'), call('c2')], [test('t1'), test('t2')], html('h'))).toMatchObject({ main: { kind: 'call', call: { id: 'c1' } }, pip: { convId: 't1' }, waiting: 2 })
    expect(tvAgenda([], [test('t1'), test('t2')], html('h'))).toMatchObject({ main: { kind: 'test', use: { convId: 't1' } }, pip: null, waiting: 1 })
    expect(tvAgenda([], [], html('h'))).toMatchObject({ main: { kind: 'html' }, waiting: 0 })
    // 3: o planejamento fica abaixo do chamado e do teste e acima do último HTML.
    const plan = { convId: 'p', cwd: 'C:\\p', slug: 's', title: 'Plano' }
    expect(tvAgenda([], [], html('h'), undefined, plan)).toMatchObject({ main: { kind: 'plan', plan: { slug: 's' } } })
    expect(tvAgenda([], [test('t1')], html('h'), undefined, plan).main.kind).toBe('test')
    expect(tvAgenda([call('c1')], [], null, undefined, plan).main.kind).toBe('call')
    expect(tvAgenda([], [], null)).toMatchObject({ main: { kind: 'score' }, pip: null, waiting: 0 })
  })

  it('com filtro de projeto, só os itens dele contam (o resto não entra nem na fila)', () => {
    const keep = (convId: string): boolean => convId.startsWith('a')
    const a = tvAgenda([call('b1'), call('a1')], [test('b2')], html('b3'), keep)
    expect(a).toMatchObject({ main: { kind: 'call', call: { id: 'a1' } }, pip: null, waiting: 0 })
    expect(tvAgenda([call('b1')], [test('b2')], html('b3'), keep).main.kind).toBe('score')
  })

  it('a assinatura muda com o conteúdo e a fila; agendaConv diz de quem é', () => {
    const a = tvAgenda([call('c1')], [], null)
    const b = tvAgenda([call('c1'), call('c2')], [], null)
    expect(agendaSig(a)).not.toBe(agendaSig(b))
    expect(agendaSig(a)).toBe(agendaSig(tvAgenda([call('c1')], [], html('x'))))
    expect(agendaConv(a)).toBe('c1')
    expect(agendaConv(tvAgenda([], [], null))).toBeNull()
  })
})
