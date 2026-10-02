import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { FileRefAttachment, ImageAttachment } from '@shared/ipc'
import { CENTRAL_ID } from '@shared/central'
import type { Conversation } from '../types'
import { useCentralSend, type CentralSendDeps } from './centralSend'

/**
 * O envio da Central sem montar o App: o pedido entra "routing" só com os nomes
 * dos anexos, o payload inteiro fica em memória pelo id da entrada e vai ao
 * roteador; sem TypeSafe o gate roda, e só o celular registra mesmo assim.
 */

const central = (): Conversation =>
  ({
    id: CENTRAL_ID,
    title: 'Central',
    cwd: '',
    mode: 'central',
    central: { entries: [] },
    model: 'claude-opus-4-8',
    sdkSessionId: null,
    messages: [],
    tokens: { context: 0, output: 0, cost: 0 },
    createdAt: 1,
    updatedAt: 1
  }) as Conversation

function setup(over: Partial<CentralSendDeps> = {}) {
  let conv = central()
  const spies = {
    needTypesafe: vi.fn(),
    ensure: vi.fn(async (): Promise<Conversation | null> => conv),
    patchConv: vi.fn((id: string, fn: (c: Conversation) => Conversation) => {
      if (id === CENTRAL_ID) conv = fn(conv)
    }),
    notifyError: vi.fn(),
    route: vi.fn()
  }
  const deps: CentralSendDeps = { typesafeReady: true, ...spies, ...over }
  const { result } = renderHook(() => useCentralSend(deps))
  return { spies, result, entries: () => conv.central?.entries ?? [] }
}

const IMG: ImageAttachment = { mediaType: 'image/png', data: 'QUJDRA==', label: 'midia:1 = tela.png' }
const REF: FileRefAttachment = { name: 'plano.pdf', path: 'C:\\docs\\plano.pdf', mediaType: 'application/pdf', size: 10, label: 'midia:2 = plano.pdf' }

describe('useCentralSend', () => {
  it('com TypeSafe: registra o pedido (só nomes), guarda o payload pelo id da entrada e o entrega ao roteador', async () => {
    const { spies, result, entries } = setup()
    const thumbs = ['data:image/png;base64,QUJDRA==']
    const ok = await result.current.send('veja {{midia:1}} e {{midia:2}}', [IMG], thumbs, [], [REF])
    expect(ok).toBe(true)
    const [entry] = entries()
    expect(entry).toMatchObject({
      kind: 'request',
      state: 'routing',
      text: 'veja {{midia:1}} e {{midia:2}}',
      attachments: ['tela.png', 'plano.pdf']
    })
    // Os bytes ficam fora da Central (ela é gravada no banco).
    expect(JSON.stringify(entries())).not.toContain('QUJDRA==')
    const payload = result.current.payloads.current.get(entry.id)
    expect(payload).toEqual({ text: 'veja {{midia:1}} e {{midia:2}}', images: [IMG], thumbs, files: [], fileRefs: [REF] })
    expect(spies.route).toHaveBeenCalledTimes(1)
    expect(spies.route).toHaveBeenCalledWith(entry.id, payload)
    expect(spies.route.mock.calls[0][1]).toBe(payload)
    expect(spies.needTypesafe).not.toHaveBeenCalled()
  })

  it('celular sem TypeSafe: o gate roda E o pedido é registrado e roteado (mensagem nenhuma se perde)', async () => {
    const { spies, result, entries } = setup({ typesafeReady: false })
    const ok = await result.current.send('quanto tá o dólar?', [], [], [], [], 'phone')
    expect(ok).toBe(true)
    expect(spies.needTypesafe).toHaveBeenCalledTimes(1)
    expect(entries()).toEqual([expect.objectContaining({ kind: 'request', state: 'routing', text: 'quanto tá o dólar?' })])
    const id = entries()[0].id
    expect(result.current.payloads.current.has(id)).toBe(true)
    expect(spies.route).toHaveBeenCalledWith(id, expect.objectContaining({ text: 'quanto tá o dólar?' }))
  })

  it('campo sem TypeSafe: o gate roda, devolve false e nada é registrado nem roteado', async () => {
    const { spies, result, entries } = setup({ typesafeReady: false })
    const ok = await result.current.send('deixa mais escuro', [], [], [], [])
    expect(ok).toBe(false)
    expect(spies.needTypesafe).toHaveBeenCalledTimes(1)
    expect(spies.ensure).not.toHaveBeenCalled()
    expect(spies.patchConv).not.toHaveBeenCalled()
    expect(spies.route).not.toHaveBeenCalled()
    expect(entries()).toEqual([])
    expect(result.current.payloads.current.size).toBe(0)
  })

  it('pedido vazio: nada acontece (nem o gate)', async () => {
    const { spies, result } = setup({ typesafeReady: false })
    expect(await result.current.send('   ', [], [], [], [])).toBe(false)
    expect(spies.needTypesafe).not.toHaveBeenCalled()
    expect(spies.patchConv).not.toHaveBeenCalled()
  })

  it('Central que não carregou: avisa e não registra', async () => {
    const { spies, result } = setup({ ensure: async () => null })
    expect(await result.current.send('oi', [], [], [], [])).toBe(false)
    expect(spies.notifyError).toHaveBeenCalledWith('A Central ainda não carregou. Tente de novo em instantes.')
    expect(spies.patchConv).not.toHaveBeenCalled()
    expect(spies.route).not.toHaveBeenCalled()
    expect(result.current.payloads.current.size).toBe(0)
  })
})
