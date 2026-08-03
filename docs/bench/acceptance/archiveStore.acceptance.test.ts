import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadAllConversationRecords, saveAllConversationRecords } from '../../../src/main/projectStore'

/** Testes de aceitação do benchmark — NÃO são vistos por quem implementa. */

let cacheDir: string

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'agent-code-bench-archive-'))
})

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true })
})

describe('persistência do campo archived', () => {
  it('archived sobrevive ao salvar e carregar', () => {
    saveAllConversationRecords(cacheDir, [
      { id: 'a', cwd: 'C:\\Projects\\app-a', updatedAt: 1, archived: true },
      { id: 'b', cwd: 'C:\\Projects\\app-a', updatedAt: 1 }
    ])
    const loaded = loadAllConversationRecords(cacheDir)
    expect(loaded.find((c) => c.id === 'a')?.archived).toBe(true)
    expect(loaded.find((c) => c.id === 'b')?.archived).toBeUndefined()
  })
})
