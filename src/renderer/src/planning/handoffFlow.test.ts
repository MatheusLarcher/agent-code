import { describe, expect, it, vi } from 'vitest'
import {
  HANDOFF_CLOCK_SLACK_MS,
  handoffOutcome,
  handoffPartialMessage,
  launchHandoff,
  managerHandoffRequest,
  newHandoffsSince
} from './handoffFlow'

describe('managerHandoffRequest', () => {
  it('pede plan_handoff_write com um ou mais prompts autocontidos, sem implementar', () => {
    const dir = 'D:\\dados\\agent-code\\planning\\app\\checkout'
    const text = managerHandoffRequest(dir)
    expect(text).toContain('mcp__planning__plan_handoff_write')
    expect(text).toMatch(/UM OU MAIS prompts autocontidos/)
    // A pasta real que o main informou, não um docs/spec montado no renderer.
    expect(text).toContain(`consultar ${dir} sem replanejar`)
    expect(text).not.toContain('docs/spec')
    expect(text).toMatch(/TodoWrite\/TaskCreate/)
    expect(text).toMatch(/Não implemente nada/)
    expect(text).not.toMatch(/ambiguidade.*aberta/i)
  })

  it('com ambiguidades abertas (enviar mesmo assim), avisa o Manager', () => {
    expect(managerHandoffRequest('checkout', 1)).toMatch(/Uma ambiguidade continua aberta/)
    expect(managerHandoffRequest('checkout', 3)).toMatch(/3 ambiguidades continuam abertas/)
  })
})

describe('newHandoffsSince', () => {
  const at = 1_000_000
  const h = (name: string, createdAt: number) => ({ name, createdAt, content: name })

  it('só nomes que não existiam E criados a partir do pedido (com folga do relógio do disco)', () => {
    const list = [
      h('2026-09-22-01.md', at - 60_000), // já existia
      h('2026-09-22-02.md', at + 10), // novo
      h('2026-09-22-03.md', at - HANDOFF_CLOCK_SLACK_MS + 1), // novo, dentro da folga
      h('2026-09-22-04.md', at - 60_000) // nome novo, mas criado muito antes do pedido
    ]
    const before = new Set(['2026-09-22-01.md'])
    expect(newHandoffsSince(list, before, at).map((x) => x.name)).toEqual(['2026-09-22-02.md', '2026-09-22-03.md'])
  })
})

describe('launchHandoff', () => {
  type Conv = { id: string }

  it('cria a conversa antes de enviar e envia os prompts na ordem, um de cada vez', async () => {
    const log: string[] = []
    const registered = new Set<string>()
    let inFlight = 0
    const res = await launchHandoff<Conv>(['um', 'dois', 'tres'], {
      create: () => {
        log.push('create')
        registered.add('impl')
        return { id: 'impl' }
      },
      send: async (conv, text) => {
        // A conversa já existe para o caminho de envio quando o 1º prompt sai.
        expect(registered.has(conv.id)).toBe(true)
        expect(inFlight).toBe(0)
        inFlight++
        await Promise.resolve()
        log.push(`send:${text}`)
        inFlight--
        return true
      }
    })
    expect(log).toEqual(['create', 'send:um', 'send:dois', 'send:tres'])
    expect(res).toEqual({ conv: { id: 'impl' }, delivered: 3, total: 3 })
  })

  it('para no primeiro envio que falha: os seguintes não saem fora de ordem', async () => {
    const send = vi.fn(async (_c: Conv, text: string) => text !== 'dois')
    const res = await launchHandoff<Conv>(['um', 'dois', 'tres'], { create: () => ({ id: 'x' }), send })
    expect(send.mock.calls.map((c) => c[1])).toEqual(['um', 'dois'])
    expect(res).toMatchObject({ delivered: 1, total: 3 })
  })

  it('envio que LANÇA depois de criada a conversa vira falha, não exceção', async () => {
    const send = vi.fn(async (_c: Conv, text: string) => {
      if (text === 'dois') throw new Error('ipc caiu')
      return true
    })
    const res = await launchHandoff<Conv>(['um', 'dois', 'tres'], { create: () => ({ id: 'x' }), send })
    expect(res).toEqual({ conv: { id: 'x' }, delivered: 1, total: 3 })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('descarta prompt em branco; sem nenhum, nem cria a conversa', async () => {
    const create = vi.fn(() => ({ id: 'x' }))
    const send = vi.fn(async () => true)
    expect(await launchHandoff<Conv>(['  ', '\n'], { create, send })).toEqual({ conv: null, delivered: 0, total: 0 })
    expect(create).not.toHaveBeenCalled()
    await launchHandoff<Conv>(['', 'só este'], { create, send })
    expect(send.mock.calls.map((c) => (c as unknown[])[1])).toEqual(['só este'])
  })
})

describe('handoffOutcome e handoffPartialMessage', () => {
  it('distingue enviado, conversa criada com falha e nada criado', () => {
    expect(handoffOutcome({ conv: { id: 'x' }, delivered: 2, total: 2 })).toEqual({ status: 'sent', delivered: 2, total: 2 })
    expect(handoffOutcome({ conv: { id: 'x' }, delivered: 0, total: 2 })).toEqual({ status: 'created-failed', delivered: 0, total: 2 })
    expect(handoffOutcome({ conv: null, delivered: 0, total: 0 })).toEqual({ status: 'not-created', delivered: 0, total: 0 })
  })

  it('o toast manda usar "Tentar de novo" na conversa nova e avisa que reenviar criaria outra', () => {
    const one = handoffPartialMessage('Checkout', { status: 'created-failed', delivered: 0, total: 1 })
    expect(one).toMatch(/"Implementação: Checkout" foi criada/)
    expect(one).toMatch(/prompt 1 de 1/)
    expect(one).toMatch(/"Tentar de novo"/)
    expect(one).toMatch(/criaria outra conversa/)
    expect(one).not.toMatch(/seguinte/)
    expect(handoffPartialMessage('C', { status: 'created-failed', delivered: 1, total: 3 })).toMatch(
      /prompt 2 de 3[\s\S]*o prompt seguinte está em _handoff\//
    )
    expect(handoffPartialMessage('C', { status: 'created-failed', delivered: 0, total: 3 })).toMatch(/os 2 prompts seguintes estão/)
  })
})
