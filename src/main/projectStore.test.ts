// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
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
  it('preserva o toggle Loop junto da conversa', () => {
    const record = { ...conv('loop-1', 'C:\\Projects\\loop-app'), loopEnabled: true, economyMode: false }
    saveAllConversationRecords(cacheDir, [record])
    expect(loadAllConversationRecords(cacheDir)).toEqual([record])
  })

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

describe('nunca perder dados por causa de um load que falhou', () => {
  /** A `.db` that exists but can't be opened as SQLite — the shape a locked,
   *  half-synced or corrupt file takes on disk. */
  function seedUnreadableDb(dir: string, name: string): void {
    mkdirSync(join(dir, 'data'), { recursive: true })
    writeFileSync(join(dir, 'data', name), 'isto não é um banco sqlite', 'utf8')
  }

  /** Write a valid project db straight to disk, as a backup restore or a
   *  cloud-sync client would — behind the app's back. */
  function seedProjectDb(path: string, list: ConversationRecord[]): void {
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO kv(key, value) VALUES(?, ?)').run('conversations', JSON.stringify(list))
    db.close()
  }

  it('um arquivo ilegível não derruba o load dos outros projetos', () => {
    saveAllConversationRecords(cacheDir, [conv('a1', 'C:\\Projects\\app-a')])
    seedUnreadableDb(cacheDir, 'corrompido-00000000.db')

    const loaded = loadAllConversationRecords(cacheDir)
    expect(loaded.map((c) => c.id)).toEqual(['a1'])
  })

  it('não apaga o arquivo que o load não conseguiu ler', () => {
    saveAllConversationRecords(cacheDir, [conv('a1', 'C:\\Projects\\app-a')])
    seedUnreadableDb(cacheDir, 'corrompido-00000000.db')

    // Load incompleto: o ilegível ficou de fora da lista devolvida — então o
    // save seguinte também não o menciona, e não pode ser lido como exclusão.
    const loaded = loadAllConversationRecords(cacheDir)
    saveAllConversationRecords(cacheDir, loaded)

    expect(readdirSync(join(cacheDir, 'data'))).toContain('corrompido-00000000.db')
  })

  it('não apaga um banco restaurado depois do load (backup/cloud-sync com o app aberto)', () => {
    saveAllConversationRecords(cacheDir, [conv('a1', 'C:\\Projects\\app-a')])
    loadAllConversationRecords(cacheDir)

    // Restauração de um projeto que não existia quando o app carregou.
    const restored = projectFileName('C:\\Projects\\resgatado')
    seedProjectDb(join(cacheDir, 'data', restored), [conv('r1', 'C:\\Projects\\resgatado')])

    // O app segue salvando o que tem em memória, sem saber do arquivo novo.
    saveAllConversationRecords(cacheDir, [conv('a1', 'C:\\Projects\\app-a')])

    expect(readdirSync(join(cacheDir, 'data'))).toContain(restored)
    expect(loadAllConversationRecords(cacheDir).map((c) => c.id).sort()).toEqual(['a1', 'r1'])
  })

  it('um save com lista vazia antes de qualquer load não apaga banco nenhum', async () => {
    saveAllConversationRecords(cacheDir, [conv('a1', 'C:\\Projects\\app-a'), conv('b1', 'C:\\Projects\\app-b')])
    expect(readdirSync(join(cacheDir, 'data')).length).toBe(2)

    // Processo novo, nenhum load ainda: é exatamente o caso de fechar o app
    // antes do histórico terminar de carregar.
    vi.resetModules()
    const fresh = await import('./projectStore')
    fresh.saveAllConversationRecords(cacheDir, [])

    expect(readdirSync(join(cacheDir, 'data')).length).toBe(2)
    expect(loadAllConversationRecords(cacheDir).map((c) => c.id).sort()).toEqual(['a1', 'b1'])
  })

  it('banco corrompido do projeto: o save volta a funcionar e guarda o arquivo velho', () => {
    const file = projectFileName('C:\\Projects\\app-a')
    saveAllConversationRecords(cacheDir, [conv('a1', 'C:\\Projects\\app-a')])
    // Corrompe o arquivo como um cloud-sync faria no meio de uma escrita.
    writeFileSync(join(cacheDir, 'data', file), 'lixo no lugar do banco', 'utf8')

    loadAllConversationRecords(cacheDir) // vê que está ilegível (a conversa some da lista)
    // Antes isso lançava "database disk image is malformed" em todo save.
    expect(() => saveAllConversationRecords(cacheDir, [conv('a2', 'C:\\Projects\\app-a')])).not.toThrow()

    expect(loadAllConversationRecords(cacheDir).map((c) => c.id)).toEqual(['a2'])
    // O arquivo danificado foi guardado, não sobrescrito por cima.
    const files = readdirSync(join(cacheDir, 'data'))
    expect(files.some((f) => f.startsWith(`${file}.corrupt-`))).toBe(true)
  })

  it('salvar não escreve dentro do arquivo em uso — troca por um pronto (à prova de sync/queda)', () => {
    const file = join(cacheDir, 'data', projectFileName('C:\\Projects\\app-a'))
    saveAllConversationRecords(cacheDir, [conv('a1', 'C:\\Projects\\app-a')])
    const before = statSync(file).ino

    saveAllConversationRecords(cacheDir, [conv('a1', 'C:\\Projects\\app-a'), conv('a2', 'C:\\Projects\\app-a')])

    // inode/índice diferente = o arquivo antigo foi SUBSTITUÍDO inteiro, não editado
    // no lugar (é a edição no lugar que o OneDrive transforma em "malformed").
    expect(statSync(file).ino).not.toBe(before)
    expect(loadAllConversationRecords(cacheDir).map((c) => c.id).sort()).toEqual(['a1', 'a2'])
    // E nenhum journal de rollback fica para trás ao lado do arquivo.
    expect(existsSync(`${file}-journal`)).toBe(false)
  })

  it('cópia de conflito do OneDrive não duplica a conversa na lista', () => {
    const cwd = 'C:\\Projects\\app-a'
    saveAllConversationRecords(cacheDir, [{ id: 'a1', cwd, title: 'a1', updatedAt: 10, messages: [1] }])
    // O cliente de sync deixa uma cópia ao lado, com o MESMO conteúdo antigo.
    const original = join(cacheDir, 'data', projectFileName(cwd))
    copyFileSync(original, join(cacheDir, 'data', 'app-a-1234abcd - PC do Fulano.db'))
    // ...e o app segue evoluindo a conversa no arquivo canônico.
    saveAllConversationRecords(cacheDir, [{ id: 'a1', cwd, title: 'a1', updatedAt: 20, messages: [1, 2, 3] }])

    const loaded = loadAllConversationRecords(cacheDir)
    expect(loaded.map((c) => c.id)).toEqual(['a1'])
    expect((loaded[0].messages as unknown[]).length).toBe(3) // ficou a versão mais nova
    // E gravar de volta não pode reintroduzir a cópia velha.
    saveAllConversationRecords(cacheDir, loaded)
    expect(loadAllConversationRecords(cacheDir).map((c) => c.id)).toEqual(['a1'])
  })

  it('lista já duplicada em disco é normalizada no load', () => {
    const cwd = 'C:\\Projects\\app-a'
    const dup = [
      { id: 'a1', cwd, title: 'a1', updatedAt: 1, messages: [1] },
      { id: 'a2', cwd, title: 'a2', updatedAt: 1, messages: [] },
      { id: 'a1', cwd, title: 'a1', updatedAt: 1, messages: [1, 2] },
      { id: 'a2', cwd, title: 'a2', updatedAt: 1, messages: [] }
    ]
    saveAllConversationRecords(cacheDir, dup)
    expect(loadAllConversationRecords(cacheDir).map((c) => c.id)).toEqual(['a1', 'a2'])
  })

  it('apagar todas as conversas de propósito ainda limpa os arquivos', () => {
    saveAllConversationRecords(cacheDir, [conv('a1', 'C:\\Projects\\app-a'), conv('b1', 'C:\\Projects\\app-b')])
    loadAllConversationRecords(cacheDir) // load completo → a poda está liberada
    saveAllConversationRecords(cacheDir, [])
    expect(readdirSync(join(cacheDir, 'data')).length).toBe(0)
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

  it('apaga a chave legada do db global após migrar (o .bak é o backup, não uma chave morta)', () => {
    seedLegacyDb(cacheDir, [conv('old1', 'C:\\Projects\\legado')])
    loadAllConversationRecords(cacheDir)
    const db = new DatabaseSync(join(cacheDir, 'agent-code.db'))
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get('agentcode.conversations.v1') as
      | { value?: string }
      | undefined
    db.close()
    expect(row).toBeUndefined()
    // O backup do banco inteiro continua intacto — é ele que guarda os dados originais.
    expect(existsSync(join(cacheDir, 'agent-code.db.bak'))).toBe(true)
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
