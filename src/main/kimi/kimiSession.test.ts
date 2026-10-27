import { describe, expect, it, vi } from 'vitest'
import { addKimiAuxListener, kimiCompactWindow, kimiSessionEnv, kimiWireModel, notifyKimiAuxReserve } from './kimiSession'

describe('sessão Kimi', () => {
  it('modelo no fio: [1m] só no K3.1 Pro com plano de 1M', () => {
    expect(kimiWireModel('k3.1-pro', { contextWindow: 262_144 })).toBe('k3.1-pro')
    expect(kimiWireModel('k3.1-pro', { contextWindow: 1_048_576 })).toBe('k3.1-pro[1m]')
    expect(kimiWireModel('k3.1-pro[1m]', { contextWindow: 262_144 })).toBe('k3.1-pro')
    expect(kimiWireModel('k3.1-pro-highspeed', { contextWindow: 1_048_576 })).toBe('k3.1-pro-highspeed')
  })

  it('janela de compactação: a janela no 256K, 400K no 1M', () => {
    expect(kimiCompactWindow(262_144)).toBe(262_144)
    expect(kimiCompactWindow(1_048_576)).toBe(400_000)
  })

  it('env: tira apelidos, base e token herdados; mantém a conta Claude (CLAUDE_CONFIG_DIR)', () => {
    const env = kimiSessionEnv(
      {
        PATH: '/bin',
        CLAUDE_CONFIG_DIR: '/contas/extra',
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'x',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'x',
        ANTHROPIC_SMALL_FAST_MODEL: 'x',
        ANTHROPIC_BASE_URL: 'https://outro',
        ANTHROPIC_AUTH_TOKEN: 'segredo-de-outro-provedor'
      },
      'k3.1-pro',
      'http://127.0.0.1:1/s',
      { contextWindow: 262_144 }
    )
    expect(env).toEqual({
      PATH: '/bin',
      CLAUDE_CONFIG_DIR: '/contas/extra',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/s',
      CLAUDE_CODE_SUBAGENT_MODEL: 'k3.1-pro',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '262144',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '262144',
      CLAUDE_CODE_TOTAL_TOKENS_REMINDER: 'padded-countdown',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000'
    })
  })

  it('aviso de reserva chega aos ouvintes e para depois de removido', () => {
    const seen = vi.fn()
    const stop = addKimiAuxListener(seen)
    notifyKimiAuxReserve('sess-1')
    stop()
    notifyKimiAuxReserve('sess-2')
    expect(seen.mock.calls).toEqual([['sess-1']])
  })
})
