import { describe, expect, it } from 'vitest'
import { fastModeNotice } from './fastModeNotice'

describe('fastModeNotice', () => {
  it('não pedido, ou servido ("on"): sem aviso', () => {
    expect(fastModeNotice(false, 'off', 'extra_usage_disabled')).toBeNull()
    expect(fastModeNotice(true, 'on', undefined)).toBeNull()
  })

  it('sem informação do CLI (sessão antiga): sem aviso', () => {
    expect(fastModeNotice(true, undefined, undefined)).toBeNull()
  })

  it('conta sem uso extra: explica o motivo e como resolver', () => {
    const n = fastModeNotice(true, 'off', 'extra_usage_disabled')
    expect(n?.key).toBe('extra_usage_disabled')
    expect(n?.text).toContain('uso extra')
    expect(n?.text).toContain('velocidade padrão')
  })

  it('cooldown por limite de taxa', () => {
    expect(fastModeNotice(true, 'cooldown', undefined)?.key).toBe('cooldown')
  })

  it('motivo desconhecido ainda avisa, sem inventar causa', () => {
    expect(fastModeNotice(true, 'off', 'unknown')?.text).toContain('não liberou')
  })
})
