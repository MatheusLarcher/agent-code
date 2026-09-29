import { describe, expect, it, vi } from 'vitest'
import type { PlanningHandoffDto, PlanningHandoffSentDto } from '@shared/ipc'
import {
  deliveredMarks,
  HANDOFF_CLOCK_SLACK_MS,
  handoffOutcome,
  handoffPartialMessage,
  launchHandoff,
  managerHandoffRequest,
  managerQuestionnaireRequest,
  newHandoffsSince,
  pendingHandoffs
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

  it('com mídia no plano, exige caminho absoluto + tipo das mídias relevantes em cada prompt', () => {
    const dir = 'D:\\dados\\agent-code\\planning\\app\\checkout'
    const text = managerHandoffRequest(dir, 0, 2)
    expect(text).toContain('o plano tem 2 mídias em midia/')
    expect(text).toMatch(/Em cada prompt, inclua o CAMINHO ABSOLUTO e o TIPO de toda mídia relevante/)
    expect(text).toContain('"[Tipo] nome — caminho absoluto"')
    expect(text).toMatch(/abri-la com Read/)
    expect(managerHandoffRequest(dir, 0, 1)).toContain('o plano tem uma mídia em midia/')
    // Sem mídia, o pedido é o de sempre.
    expect(managerHandoffRequest(dir, 0, 0)).toBe(managerHandoffRequest(dir))
    expect(managerHandoffRequest(dir)).not.toMatch(/mídia/i)
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
    const conv = { id: 'x', title: 'Implementação: P' }
    expect(handoffOutcome({ conv, delivered: 2, total: 2 })).toEqual({ status: 'sent', delivered: 2, total: 2, conversation: conv })
    expect(handoffOutcome({ conv, delivered: 0, total: 2 })).toEqual({
      status: 'created-failed',
      delivered: 0,
      total: 2,
      conversation: conv
    })
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

describe('managerQuestionnaireRequest', () => {
  it('pede o questionário por AskUserQuestion, em levas de 4, registrando nos cards e sem implementar', () => {
    const text = managerQuestionnaireRequest()
    expect(text).toMatch(/^Lance agora o questionário/)
    expect(text).toContain('AskUserQuestion, até 4 por vez')
    expect(text).toContain("'(Recomendado)'")
    expect(text).toContain('registre nos cards (decisão, ambiguidade resolvida)')
    expect(text).toContain('mcp__planning__plan_read e percorra o roteiro etapa por etapa')
    expect(text).toContain('pesquise na web (WebSearch/WebFetch)')
    expect(text).toContain('mcp__planning__plan_etapa_marcar')
    expect(text).toContain(
      "Só diga 'Nenhuma pergunta em aberto.' se todas as etapas do roteiro estiverem concluídas e não houver ambiguidade aberta."
    )
    expect(text).toMatch(/Não implemente nada\.$/)
  })
})

describe('pendingHandoffs (a enviar = fora de enviados.json)', () => {
  const h = (name: string, createdAt = 0): PlanningHandoffDto => ({ name, createdAt, content: `# ${name}` })
  const at = '2026-09-25T10:00:00.000Z'
  const names = (l: PlanningHandoffDto[]): string[] => l.map((x) => x.name)
  // A ordem é a da lista do main (por nome), não a do relógio: gravados com
  // horas de distância continuam juntos, sem "lote" adivinhado.
  const list = [h('2026-09-24-01.md', 0), h('2026-09-25-01.md', 5 * 3_600_000), h('2026-09-25-02.md', 1)]

  it('sem enviados.json (plano antigo), todos estão a enviar, na ordem da lista', () => {
    expect(names(pendingHandoffs(list, []))).toEqual(['2026-09-24-01.md', '2026-09-25-01.md', '2026-09-25-02.md'])
    expect(pendingHandoffs([], [])).toEqual([])
  })

  it('enviado, substituído e marcado à mão saem da lista', () => {
    const sent: PlanningHandoffSentDto[] = [
      { nome: '2026-09-24-01.md', enviadoEm: at, conversaId: 'c1', conversaTitulo: 'Implementação: P' },
      { nome: '2026-09-25-01.md', enviadoEm: at, substituidoPor: '2026-09-25-03.md' }
    ]
    expect(names(pendingHandoffs([...list, h('2026-09-25-03.md')], sent))).toEqual(['2026-09-25-02.md', '2026-09-25-03.md'])
    expect(pendingHandoffs(list, [...sent, { nome: '2026-09-25-02.md', enviadoEm: at, marcadoManualmente: true }])).toEqual([])
  })

  it('registro de arquivo que já não existe não atrapalha', () => {
    expect(names(pendingHandoffs(list, [{ nome: 'sumiu.md', enviadoEm: at, marcadoManualmente: true }]))).toHaveLength(3)
  })
})

describe('deliveredMarks (o que vai para enviados.json depois do envio)', () => {
  const conversation = { id: 'c1', title: 'Implementação: P' }
  const names = ['a.md', 'b.md', 'c.md']
  it('envio completo: todos, ligados à conversa', () => {
    expect(deliveredMarks(names, { status: 'sent', delivered: 3, total: 3, conversation })).toEqual(
      names.map((nome) => ({ nome, conversaId: 'c1', conversaTitulo: 'Implementação: P' }))
    )
  })
  it('envio parcial: só os entregues; o resto continua a enviar', () => {
    expect(deliveredMarks(names, { status: 'created-failed', delivered: 1, total: 3, conversation })).toEqual([
      { nome: 'a.md', conversaId: 'c1', conversaTitulo: 'Implementação: P' }
    ])
    expect(deliveredMarks(names, { status: 'created-failed', delivered: 0, total: 3, conversation })).toEqual([])
  })
  it('nada criado: nada registrado', () => {
    expect(deliveredMarks(names, { status: 'not-created', delivered: 0, total: 0 })).toEqual([])
  })
})
