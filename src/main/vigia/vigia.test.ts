// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ChatEvent, VigiaAlertMsg } from '../../shared/ipc'
import { Vigia } from './vigia'
import { VIGIA_COOLDOWN_MS } from './vigiaPrompt'

function toolUse(name: string, input: unknown = {}): ChatEvent {
  return { kind: 'tool-use', id: `t${Math.random()}`, name, input, parentToolUseId: null } as ChatEvent
}

function result(): ChatEvent {
  return { kind: 'result', id: 'r1', isError: false, text: '', durationMs: 10 } as ChatEvent
}

function setup(opts?: { enabled?: boolean; reply?: string; now?: () => number }) {
  const alerts: VigiaAlertMsg[] = []
  const ask = vi.fn(async () => opts?.reply ?? 'ALERTA: Qual o diâmetro real do eixo?')
  const vigia = new Vigia({
    config: () => ({ enabled: opts?.enabled ?? true, model: 'claude-sonnet-5' }),
    emit: (a) => alerts.push(a),
    ask,
    now: opts?.now
  })
  return { vigia, alerts, ask }
}

/** O gatilho: a análise só vale depois que o agente revelou COMO leu o pedido. */
describe('quando o vigia roda', () => {
  it('dispara uma vez, na 3ª chamada de ferramenta', async () => {
    const { vigia, alerts, ask } = setup()
    vigia.noteUserMessage('c1', 'faz o suporte')
    vigia.observe('c1', toolUse('Read'))
    vigia.observe('c1', toolUse('Read'))
    expect(ask).not.toHaveBeenCalled()
    vigia.observe('c1', toolUse('Write'))
    await vi.waitFor(() => expect(alerts).toHaveLength(1))
    // Mais ações do mesmo turno não geram uma segunda chamada.
    vigia.observe('c1', toolUse('Bash'))
    vigia.observe('c1', result())
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('turno curto ainda é analisado, no result', async () => {
    const { vigia, alerts } = setup()
    vigia.noteUserMessage('c1', 'faz o suporte')
    vigia.observe('c1', result())
    await vi.waitFor(() => expect(alerts).toHaveLength(1))
  })

  // Retomada de sessão e recuperação de turno não passam por noteUserMessage:
  // sem pedido do usuário não há premissa do usuário para questionar.
  it('não roda sem mensagem do usuário', async () => {
    const { vigia, ask } = setup()
    vigia.observe('c1', toolUse('Read'))
    vigia.observe('c1', toolUse('Read'))
    vigia.observe('c1', toolUse('Read'))
    vigia.observe('c1', result())
    await Promise.resolve()
    expect(ask).not.toHaveBeenCalled()
  })

  it('turno que morreu em erro não é analisado', async () => {
    const { vigia, ask } = setup()
    vigia.noteUserMessage('c1', 'faz o suporte')
    vigia.observe('c1', { kind: 'error', id: 'e1', text: 'boom' } as ChatEvent)
    vigia.observe('c1', result())
    await Promise.resolve()
    expect(ask).not.toHaveBeenCalled()
  })

  it('respeita o cooldown entre turnos da mesma conversa', async () => {
    let now = 1_000_000
    const { vigia, ask } = setup({ now: () => now })
    vigia.noteUserMessage('c1', 'primeiro pedido')
    vigia.observe('c1', result())
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1))

    now += VIGIA_COOLDOWN_MS - 1
    vigia.noteUserMessage('c1', 'segundo pedido')
    vigia.observe('c1', result())
    await Promise.resolve()
    expect(ask).toHaveBeenCalledTimes(1)

    now += 2
    vigia.noteUserMessage('c1', 'terceiro pedido')
    vigia.observe('c1', result())
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(2))
  })

  it('desligado na config não chama o modelo', async () => {
    const { vigia, ask, alerts } = setup({ enabled: false })
    vigia.noteUserMessage('c1', 'faz o suporte')
    vigia.observe('c1', result())
    await Promise.resolve()
    expect(ask).not.toHaveBeenCalled()
    expect(alerts).toHaveLength(0)
  })
})

describe('o que o vigia emite', () => {
  it('OK do modelo não vira aviso', async () => {
    const { vigia, alerts, ask } = setup({ reply: 'OK' })
    vigia.noteUserMessage('c1', 'pedido claro')
    vigia.observe('c1', result())
    await vi.waitFor(() => expect(ask).toHaveBeenCalled())
    expect(alerts).toHaveLength(0)
  })

  // Uma premissa não resolvida seguiria gerando o mesmo texto a cada turno;
  // repetir o aviso é como se perde o usuário.
  it('não repete o mesmo alerta na mesma conversa', async () => {
    let now = 1_000_000
    const { vigia, alerts } = setup({ now: () => now })
    vigia.noteUserMessage('c1', 'pedido 1')
    vigia.observe('c1', result())
    await vi.waitFor(() => expect(alerts).toHaveLength(1))

    now += VIGIA_COOLDOWN_MS + 1
    vigia.noteUserMessage('c1', 'pedido 2')
    vigia.observe('c1', result())
    await Promise.resolve()
    await Promise.resolve()
    expect(alerts).toHaveLength(1)
  })

  it('as respostas prováveis chegam ao alerta, separadas da pergunta', async () => {
    const { vigia, alerts } = setup({ reply: 'ALERTA: O alvo é o app ou a extensão? | só o app | os dois' })
    vigia.noteUserMessage('c1', 'pedido')
    vigia.observe('c1', result())
    await vi.waitFor(() => expect(alerts).toHaveLength(1))
    expect(alerts[0].text).toBe('O alvo é o app ou a extensão?')
    expect(alerts[0].options).toEqual(['só o app', 'os dois'])
  })

  it('o mesmo alerta em OUTRA conversa passa', async () => {
    const { vigia, alerts } = setup()
    vigia.noteUserMessage('c1', 'pedido')
    vigia.observe('c1', result())
    await vi.waitFor(() => expect(alerts).toHaveLength(1))
    vigia.noteUserMessage('c2', 'pedido')
    vigia.observe('c2', result())
    await vi.waitFor(() => expect(alerts).toHaveLength(2))
    expect(alerts[1].convId).toBe('c2')
  })

  // O observador nunca pode derrubar o observado.
  it('falha do modelo degrada em silêncio', async () => {
    const alerts: VigiaAlertMsg[] = []
    const vigia = new Vigia({
      config: () => ({ enabled: true, model: 'claude-sonnet-5' }),
      emit: (a) => alerts.push(a),
      ask: async () => {
        throw new Error('rede caiu')
      }
    })
    vigia.noteUserMessage('c1', 'pedido')
    expect(() => vigia.observe('c1', result())).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect(alerts).toHaveLength(0)
  })

  it('dispose esquece a conversa', async () => {
    const { vigia, ask } = setup()
    vigia.noteUserMessage('c1', 'pedido')
    vigia.dispose('c1')
    vigia.observe('c1', result())
    await Promise.resolve()
    expect(ask).not.toHaveBeenCalled()
  })
})
