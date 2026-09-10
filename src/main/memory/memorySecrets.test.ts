// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { StorageError } from '../persistence/types'
import type { MemoryProposeInput } from './memoryModel'
import { sanitizeProposal, type SecretSink } from './memorySecrets'

const KEY = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123'
const OTHER = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'

function proposal(overrides: Partial<MemoryProposeInput> = {}): MemoryProposeInput {
  return {
    op: 'create',
    relPath: 'infra/deploy.md',
    title: 'Deploy',
    hook: 'Como publicar',
    body: 'Nada de especial aqui.',
    proposedBy: 'agent',
    ...overrides
  }
}

function fakeVault(enabled: (() => boolean) | boolean = true): SecretSink & { puts: [string, string][] } {
  const puts: [string, string][] = []
  return {
    puts,
    enabled: typeof enabled === 'function' ? enabled : () => enabled,
    put: vi.fn(async (name: string, value: string) => {
      puts.push([name, value])
      return { name }
    })
  }
}

describe('sanitizeProposal', () => {
  it('scans body, title and hook and stores each value once', async () => {
    const vault = fakeVault()
    const result = await sanitizeProposal(
      proposal({ title: `chave ${KEY}`, hook: `token=${OTHER}`, body: `usar ${KEY} sempre` }),
      { vault }
    )
    expect(vault.puts).toEqual([
      ['infra.deploy.1', KEY],
      ['infra.deploy.2', OTHER]
    ])
    expect(result.stored).toEqual(['infra.deploy.1', 'infra.deploy.2'])
    expect(result.input.title).toBe('chave {{secret:infra.deploy.1}}')
    expect(result.input.hook).toBe('token={{secret:infra.deploy.2}}')
    expect(result.input.body).toBe('usar {{secret:infra.deploy.1}} sempre')
    expect(result.skipped).toEqual([])
  })

  it('honours explicit secrets the scanner missed and their given name', async () => {
    const vault = fakeVault()
    const result = await sanitizeProposal(proposal({ body: 'a senha do wifi é banana' }), {
      vault,
      explicit: [{ name: 'wifi.casa', value: 'banana' }]
    })
    expect(vault.puts).toEqual([['wifi.casa', 'banana']])
    expect(result.input.body).toBe('a senha do wifi é {{secret:wifi.casa}}')
  })

  it('stores an explicit secret whose value is absent from the text', async () => {
    const vault = fakeVault()
    const result = await sanitizeProposal(proposal({ body: 'sem nada aqui' }), {
      vault,
      explicit: [{ name: 'externa', value: 'valor-fora-do-texto' }]
    })
    expect(vault.puts).toEqual([['externa', 'valor-fora-do-texto']])
    expect(result.stored).toEqual(['externa'])
    expect(result.input.body).toBe('sem nada aqui')
  })

  it('rejects an invalid explicit name or an empty value', async () => {
    const vault = fakeVault()
    await expect(
      sanitizeProposal(proposal(), { vault, explicit: [{ name: 'nome inválido!', value: 'x' }] })
    ).rejects.toMatchObject({ code: 'INVALID_PERSISTED_DATA' })
    await expect(
      sanitizeProposal(proposal(), { vault, explicit: [{ name: 'ok', value: '' }] })
    ).rejects.toBeInstanceOf(StorageError)
    expect(vault.puts).toEqual([])
  })

  it('skips derived names already taken by an explicit secret', async () => {
    const vault = fakeVault()
    const result = await sanitizeProposal(proposal({ body: `use ${KEY}` }), {
      vault,
      explicit: [{ name: 'infra.deploy.1', value: 'outro-valor' }]
    })
    expect(result.stored).toEqual(['infra.deploy.1', 'infra.deploy.2'])
    expect(result.input.body).toBe('use {{secret:infra.deploy.2}}')
  })

  it('fails the whole sanitize when put rejects', async () => {
    const vault = fakeVault()
    vault.put = vi.fn(async () => {
      throw new Error('disco cheio')
    })
    await expect(sanitizeProposal(proposal({ body: `use ${KEY}` }), { vault })).rejects.toThrow('disco cheio')
  })

  it('redacts without storing when the vault is null', async () => {
    const result = await sanitizeProposal(proposal({ body: `use ${KEY}` }), { vault: null })
    expect(result.stored).toEqual([])
    expect(result.skipped).toHaveLength(1)
    expect(result.input.body).toBe('use {{secret:infra.deploy.1}}')
    expect(result.notes.join(' ')).toContain('Configurações')
    expect(result.notes.join(' ')).toContain('NÃO foram salvos')
  })

  it('redacts without storing when the vault is disabled', async () => {
    const vault = fakeVault(false)
    const result = await sanitizeProposal(proposal({ body: `use ${KEY}` }), { vault })
    expect(vault.puts).toEqual([])
    expect(result.stored).toEqual([])
    expect(result.input.body).toBe('use {{secret:infra.deploy.1}}')
  })

  it('para de gravar assim que o cofre é desligado no meio da chamada', async () => {
    // O interruptor é relido por segredo: o primeiro put acontece, e o
    // desligamento durante ele impede o segundo — sem perder a redação.
    let on = true
    const vault = fakeVault(() => on)
    const original = vault.put.bind(vault)
    vault.put = async (name: string, value: string) => {
      on = false
      return original(name, value)
    }
    const result = await sanitizeProposal(proposal({ body: `use ${KEY} e ${OTHER}` }), { vault })
    expect(result.stored).toHaveLength(1)
    expect(vault.puts).toHaveLength(1)
    expect(result.skipped).toHaveLength(1)
    expect(result.input.body).not.toContain(KEY)
    expect(result.input.body).not.toContain(OTHER)
  })

  it('returns the input unchanged and never touches the vault when there is nothing to redact', async () => {
    const vault = fakeVault()
    const enabled = vi.spyOn(vault, 'enabled')
    const input = proposal()
    const result = await sanitizeProposal(input, { vault })
    expect(result.input).toBe(input)
    expect(result).toMatchObject({ stored: [], skipped: [], notes: [] })
    expect(enabled).not.toHaveBeenCalled()
    expect(vault.put).not.toHaveBeenCalled()
  })

  it('never leaks a secret value in the returned object', async () => {
    const stored = await sanitizeProposal(proposal({ body: `use ${KEY}` }), {
      vault: fakeVault(),
      explicit: [{ name: 'wifi', value: 'banana-secreta' }]
    })
    const off = await sanitizeProposal(proposal({ body: `use ${KEY}` }), { vault: null })
    for (const result of [stored, off]) {
      const json = JSON.stringify(result)
      expect(json).not.toContain(KEY)
      expect(json).not.toContain('banana-secreta')
    }
  })

  it('does not crash on a retire op with a null body', async () => {
    const result = await sanitizeProposal(
      proposal({ op: 'retire', body: null, title: null, hook: null }),
      { vault: fakeVault() }
    )
    expect(result.input.body).toBeNull()
    expect(result.stored).toEqual([])
  })
})
