// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeAuthExpiry, claudeConnectedForCard, isClaudeAuthFailure } from './authExpiry'
import { providerStatusWith } from './providerStatus'

const off = { gpt: async () => false, ollama: () => false }

afterEach(() => {
  claudeAuthExpiry.onChange(null)
  claudeAuthExpiry.clear()
})

describe('claudeConnectedForCard', () => {
  it('checagem indeterminada (sem JSON válido) não desliga o Claude: sem card', async () => {
    const extraConnected = vi.fn(async () => false)
    const status = await providerStatusWith({ ...off, claude: () => claudeConnectedForCard({ probe: async () => null, extraConnected }) })
    expect(status).toEqual({ claude: true, gpt: false, ollama: false })
    expect(extraConnected).not.toHaveBeenCalled()
  })

  it('loggedIn:false comprovado e sem conta extra: card', async () => {
    const status = await providerStatusWith({
      ...off,
      claude: () => claudeConnectedForCard({ probe: async () => ({ loggedIn: false, authMethod: 'none' }), extraConnected: async () => false })
    })
    expect(status.claude).toBe(false)
  })

  it('loggedIn:false mas conta extra conectada: sem card', async () => {
    expect(
      await claudeConnectedForCard({ probe: async () => ({ loggedIn: false, authMethod: 'none' }), extraConnected: async () => true })
    ).toBe(true)
  })

  it('logado: conectado', async () => {
    expect(
      await claudeConnectedForCard({ probe: async () => ({ loggedIn: true, authMethod: 'claude.ai' }), extraConnected: async () => false })
    ).toBe(true)
  })

  it('sessão expirada num turno: card mesmo com o CLI dizendo loggedIn:true; login limpa', async () => {
    const changed = vi.fn()
    claudeAuthExpiry.onChange(changed)
    const deps = { probe: async () => ({ loggedIn: true, authMethod: 'claude.ai' }), extraConnected: async () => false }
    claudeAuthExpiry.markExpired()
    claudeAuthExpiry.markExpired()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(await claudeConnectedForCard(deps)).toBe(false)
    // O que o index faz no login Claude bem-sucedido.
    claudeAuthExpiry.clear()
    expect(changed).toHaveBeenCalledTimes(2)
    expect(await claudeConnectedForCard(deps)).toBe(true)
  })
})

describe('isClaudeAuthFailure', () => {
  it('só authentication_failed na thread principal', () => {
    expect(isClaudeAuthFailure({ type: 'assistant', error: 'authentication_failed', parent_tool_use_id: null })).toBe(true)
    expect(isClaudeAuthFailure({ type: 'assistant', error: 'authentication_failed', parent_tool_use_id: 't1' })).toBe(false)
    for (const error of ['rate_limit', 'billing_error', 'server_error', 'overloaded', 'unknown']) {
      expect(isClaudeAuthFailure({ type: 'assistant', error, parent_tool_use_id: null })).toBe(false)
    }
    expect(isClaudeAuthFailure({ type: 'result', error: 'authentication_failed' })).toBe(false)
    expect(isClaudeAuthFailure(null)).toBe(false)
  })
})
