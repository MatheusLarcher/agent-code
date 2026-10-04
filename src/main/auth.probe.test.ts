// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const outputs = vi.hoisted(() => ({ list: [] as string[] }))
vi.mock('./claudeCli', () => ({ claudeCliPath: () => 'claude.exe' }))
vi.mock('node:child_process', () => ({
  execFile: (_cli: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    const out = outputs.list.shift() ?? ''
    cb(out ? null : new Error('timeout'), out)
  }
}))

import { claudeAuthProbe, claudeAuthStatus } from './auth'

beforeEach(() => {
  outputs.list = []
})

describe('claudeAuthProbe', () => {
  it('nenhuma tentativa com JSON válido: null (indeterminado)', async () => {
    outputs.list = ['', 'not json']
    expect(await claudeAuthProbe()).toBeNull()
  })

  it('a 2ª tentativa responde: usa a resposta', async () => {
    outputs.list = ['', '{"loggedIn":true,"authMethod":"claude.ai"}']
    expect(await claudeAuthProbe()).toEqual({ loggedIn: true, authMethod: 'claude.ai' })
  })

  it('loggedIn:false comprovado', async () => {
    outputs.list = ['{"loggedIn":false,"authMethod":"none"}']
    expect(await claudeAuthProbe()).toEqual({ loggedIn: false, authMethod: 'none' })
  })

  it('claudeAuthStatus mantém o achatamento para deslogado', async () => {
    outputs.list = ['', '']
    expect(await claudeAuthStatus()).toEqual({ loggedIn: false, authMethod: 'none' })
  })
})
