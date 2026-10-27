import { describe, expect, it } from 'vitest'
import type { KimiConfig } from '../../shared/ipc'
import { isKimiConnected, kimiApiKey } from './kimiAuth'

const base: KimiConfig = { enabled: true, apiKey: ' sk-kimi-x ', region: 'intl', contextWindow: 262_144, models: ['k3.1-pro'] }

describe('credencial do Kimi', () => {
  it('chave só com o Kimi ligado, sem espaços', () => {
    expect(kimiApiKey(base)).toBe('sk-kimi-x')
    expect(kimiApiKey({ ...base, enabled: false })).toBeNull()
    expect(kimiApiKey({ ...base, apiKey: '  ' })).toBeNull()
    expect(kimiApiKey(undefined)).toBeNull()
  })

  it('conectado = ligado + chave + conexão testada (modelo liberado)', () => {
    expect(isKimiConnected(base)).toBe(true)
    expect(isKimiConnected({ ...base, models: [] })).toBe(false)
    expect(isKimiConnected({ ...base, apiKey: '' })).toBe(false)
    expect(isKimiConnected({ ...base, enabled: false })).toBe(false)
    expect(isKimiConnected({ ...base, models: ['desconhecido'] })).toBe(false)
  })
})
