import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  projectFileName,
  loadAllConversationRecords,
  saveAllConversationRecords,
  type ConversationRecord
} from './projectStore'

let cacheDir: string

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'agent-code-projectstore-'))
})

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true })
})

function conv(id: string, cwd: string): ConversationRecord {
  return { id, cwd, title: id, updatedAt: 1 }
}

/** Seed a legacy single-blob `agent-code.db` (the pre-migration format). */
function seedLegacyDb(dir: string, list: ConversationRecord[]): void {
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'agent-code.db'))
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.prepare('INSERT INTO kv(key, value) VALUES(?, ?)').run('agentcode.conversations.v1', JSON.stringify(list))
  db.close()
}

describe('projectFileName', () => {
  it('é estável para o mesmo cwd', () => {
    const a = projectFileName('C:\\Projects\\meuapp')
    const b = projectFileName('C:\\Projects\\meuapp')
    expect(a).toBe(b)
  })

  it('não colide entre pastas de mesmo nome em pais diferentes', () => {
    const a = projectFileName('C:\\Projects\\api')
    const b = projectFileName('D:\\Work\\api')
    expect(a).not.toBe(b)
  })

  it('cai no bucket compartilhado quando não há cwd', () => {
    expect(projectFileName(undefined)).toBe('sem-projeto.db')
    expect(projectFileName('')).toBe('sem-projeto.db')
    expect(projectFileName(42)).toBe('sem-projeto.db')
  })
})

describe('save/load — split por projeto', () => {
  it('grava cada projeto no seu próprio arquivo e o load junta tudo de volta', () => {
    const list = [conv('a1', 'C:\\Projects\\app-a'), conv('a2', 'C:\\Projects\\app-a'), conv('b1', 'C:\\Projects\\app-b')]
    saveAllConversationRecords(cacheDir, list)

    const files = readdirSync(join(cacheDir, 'data')).filter((f) => f.endsWith('.db'))
    expect(files.length).toBe(2) // app-a e app-b

    const loaded = loadAllConversationRecords(cacheDir)
    expect(loaded.map((c) => c.id).sort()).toEqual(['a1', 'a2', 'b1'])
  })

  it('remove o arquivo de um projeto quando todas as conversas dele somem', () => {
    saveAllConversationRecords(cacheDir, [conv('a1', 'C:\\Projects\\app-a'), conv('b1', 'C:\\Projects\\app-b')])
    expect(readdirSync(join(cacheDir, 'data')).length).toBe(2)

    // Só sobra a conversa do projeto b.
    saveAllConversationRecords(cacheDir, [conv('b1', 'C:\\Projects\\app-b')])
    const files = readdirSync(join(cacheDir, 'data'))
    expect(files.length).toBe(1)

    const loaded = loadAllConversationRecords(cacheDir)
    expect(loaded.map((c) => c.id)).toEqual(['b1'])
  })

  it('não mistura conversas de projetos diferentes num mesmo save subsequente', () => {
    saveAllConversationRecords(cacheDir, [conv('a1', 'C:\\Projects\\app-a')])
    saveAllConversationRecords(cacheDir, [conv('a1', 'C:\\Projects\\app-a'), conv('b1', 'C:\\Projects\\app-b')])
    const loaded = loadAllConversationRecords(cacheDir)
    expect(loaded.map((c) => c.id).sort()).toEqual(['a1', 'b1'])
  })
})

describe('migração do blob legado', () => {
  it('divide o array único antigo em arquivos por projeto e preserva tudo', () => {
    seedLegacyDb(cacheDir, [conv('old1', 'C:\\Projects\\legado'), conv('old2', 'C:\\Projects\\legado'), conv('old3', 'C:\\Projects\\outro')])

    const loaded = loadAllConversationRecords(cacheDir)
    expect(loaded.map((c) => c.id).sort()).toEqual(['old1', 'old2', 'old3'])
    expect(existsSync(join(cacheDir, 'data'))).toBe(true)
  })

  it('faz backup do db antigo antes de migrar', () => {
    seedLegacyDb(cacheDir, [conv('old1', 'C:\\Projects\\legado')])
    loadAllConversationRecords(cacheDir)
    expect(existsSync(join(cacheDir, 'agent-code.db.bak'))).toBe(true)
  })

  it('não apaga a chave legada do db antigo (fica como backup inerte)', () => {
    seedLegacyDb(cacheDir, [conv('old1', 'C:\\Projects\\legado')])
    loadAllConversationRecords(cacheDir)
    const db = new DatabaseSync(join(cacheDir, 'agent-code.db'))
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get('agentcode.conversations.v1') as
      | { value?: string }
      | undefined
    db.close()
    expect(row?.value).toBeTruthy()
  })

  it('é idempotente — rodar duas vezes não duplica nem corrompe', () => {
    seedLegacyDb(cacheDir, [conv('old1', 'C:\\Projects\\legado')])
    const first = loadAllConversationRecords(cacheDir)
    const second = loadAllConversationRecords(cacheDir)
    expect(first.map((c) => c.id)).toEqual(['old1'])
    expect(second.map((c) => c.id)).toEqual(['old1'])
  })

  it('sem dado legado, só cria a pasta data/ vazia', () => {
    const loaded = loadAllConversationRecords(cacheDir)
    expect(loaded).toEqual([])
    expect(existsSync(join(cacheDir, 'data'))).toBe(true)
  })
})
