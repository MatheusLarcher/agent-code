import { describe, expect, it } from 'vitest'
import { PERSISTENCE_INVENTORY } from './inventory'
import {
  PERSISTED_KEY_REGISTRY,
  isRegisteredPersistedKey,
  migrationScopeForUnknownKey,
  persistedKeyDefinition
} from './keyRegistry'

const EXPECTED_KEYS = [
  'agentcode.conversations.legacy-checked.v1',
  'agentcode.conversations.v1',
  'agentcode.micId',
  'agentcode.pgraph.hidden-kinds.v1',
  'agentcode.pgraph.hidden-types.v1',
  'agentcode.ui.v1',
  'agentcode.usage-limits.v1',
  'codexAuth',
  'config',
  'config.localSpeech.model',
  'config.ollama.apiKey',
  'config.ollama.enabled',
  'config.openai.apiKey',
  'config.openai.speed',
  'config.openai.voice',
  'config.remoteEnabled',
  'config.remoteToken',
  'config.skipPermissions',
  'config.transcribeEngine',
  'config.windowsControlEnabled',
  'memory-curator:last-run-at'
]

describe('registro de persistência', () => {
  it('declara exatamente as chaves persistentes atuais', () => {
    expect(Object.keys(PERSISTED_KEY_REGISTRY).sort()).toEqual(EXPECTED_KEYS)
  })

  it('mantém inventário único e cobre todas as chaves registradas', () => {
    const ids = PERSISTENCE_INVENTORY.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)

    const inventoriedKeys = new Set(PERSISTENCE_INVENTORY.flatMap((item) => item.keys ?? []))
    expect([...inventoriedKeys].sort()).toEqual(EXPECTED_KEYS)
  })

  it('expõe escopo e rejeita chave nova sem classificação', () => {
    expect(isRegisteredPersistedKey('codexAuth')).toBe(true)
    expect(persistedKeyDefinition('codexAuth')).toMatchObject({ scope: 'device', sensitive: true })
    expect(() => persistedKeyDefinition('nova-chave')).toThrow('sem escopo declarado')
  })

  it('preserva chave desconhecida de migração no escopo do dispositivo', () => {
    expect(migrationScopeForUnknownKey()).toBe('device')
  })
})
