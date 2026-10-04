import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { conv, feed } from '../office/adapter/testFeed'
import type { UIMessage } from '../types'
import { callMarks } from './officeCalls'
import { setMeetingProbe } from './officeWatch'
import { endReason, useOfficeCalls } from './useOfficeCalls'

const NOW = Date.now()
const uid = `${NOW}-${Math.random().toString(36).slice(2)}`
const callMsg = (id: string, arquivo = 'tela.html'): UIMessage => ({ kind: 'tool-use', id, name: 'mcp__app__app_chamar_usuario', input: { arquivo }, parentToolUseId: null, result: { isError: false, text: 'ok' } })
const user = (id: string): UIMessage => ({ kind: 'user', id, text: 'oi' })
const withMsgs = (a: UIMessage[], b: UIMessage[] = []) =>
  feed({ conversations: [conv('a', { title: 'Loja', messages: a, updatedAt: NOW }), conv('b', { title: 'Portal', messages: b, updatedAt: NOW })], activeId: 'a' })

const sent = vi.fn(async () => {})
const url = vi.fn(async () => ({ ok: true as const, url: 'agent-mockup://t/tela.html' }))
const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

beforeEach(() => {
  sent.mockClear()
  url.mockClear()
  vi.stubGlobal('api', { officeCallsState: sent, officeMockupUrl: url })
})
afterEach(() => {
  vi.unstubAllGlobals()
  setMeetingProbe(null)
})

describe('os chamados fora do 3D (useOfficeCalls)', () => {
  it('conta os abertos e avisa o main: abertos, títulos, quem está olhando; respondido e aberto viram fim com o motivo', async () => {
    const c1 = `c1-${uid}`
    const c2 = `c2-${uid}`
    const { result, rerender } = renderHook(({ f, office }) => useOfficeCalls(f, office), { initialProps: { f: withMsgs([callMsg(c1)], [callMsg(c2)]), office: false } })
    expect(result.current.map((c) => c.id)).toEqual([c1, c2])
    expect(sent).toHaveBeenLastCalledWith({ open: [c1, c2], ended: [], watching: false, titles: { a: 'Loja', b: 'Portal' } })
    // O usuário respondeu na conversa a.
    rerender({ f: withMsgs([callMsg(c1), user('u1')], [callMsg(c2)]), office: false })
    expect(sent).toHaveBeenLastCalledWith(expect.objectContaining({ open: [c2], ended: [{ id: c1, motivo: 'respondido' }] }))
    // Abriu o de b na TV, olhando a sala.
    setMeetingProbe(() => true)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    act(() => callMarks.end(c2, 'aberto'))
    rerender({ f: withMsgs([callMsg(c1), user('u1')], [callMsg(c2)]), office: true })
    expect(result.current).toEqual([])
    expect(sent).toHaveBeenCalledWith(expect.objectContaining({ open: [], ended: [{ id: c2, motivo: 'aberto' }] }))
    expect(sent).toHaveBeenLastCalledWith(expect.objectContaining({ watching: true }))
  })

  it('o HTML do chamado sumiu: cancelado', async () => {
    const c3 = `c3-${uid}`
    url.mockResolvedValue({ ok: false, error: 'o arquivo não existe dentro da pasta da conversa' } as never)
    const { result } = renderHook(() => useOfficeCalls(withMsgs([callMsg(c3)]), false))
    expect(url).toHaveBeenCalledWith({ cwd: 'C:\\proj\\alpha', path: 'C:\\proj\\alpha\\tela.html' })
    await flush()
    expect(callMarks.reason(c3)).toBe('cancelado')
    expect(result.current).toEqual([])
    expect(sent).toHaveBeenLastCalledWith(expect.objectContaining({ ended: [{ id: c3, motivo: 'cancelado' }] }))
  })

  it('endReason: chamou de novo (vale o último) e conversa fora do escritório cancelam', () => {
    const old = { id: 'x1', convId: 'a', key: 'conv:a', cwd: 'C:\\p', path: 'C:\\p\\a.html', mensagem: null }
    expect(endReason(old, [{ ...old, id: 'x2' }], withMsgs([]), NOW)).toBe('cancelado')
    expect(endReason(old, [], withMsgs([]), NOW)).toBe('respondido')
    expect(endReason({ ...old, convId: 'sumiu' }, [], withMsgs([]), NOW)).toBe('cancelado')
  })
})
