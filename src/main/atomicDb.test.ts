// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isReadableDb, quarantineDb, writeDbAtomically } from './atomicDb'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, copyFileSync: vi.fn(actual.copyFileSync) }
})
const mockedCopyFileSync = vi.mocked(copyFileSync)
let realCopyFileSync: typeof copyFileSync

beforeAll(async () => {
  realCopyFileSync = (await vi.importActual<typeof import('node:fs')>('node:fs')).copyFileSync
})

let dir: string
let db: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-code-atomicdb-'))
  db = join(dir, 'teste.db')
  mockedCopyFileSync.mockClear()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  // Volta à implementação real (não mockReset, que apagaria o wrapper
  // configurado em vi.mock acima e deixaria a cópia sem efeito nenhum).
  mockedCopyFileSync.mockImplementation(realCopyFileSync)
})

function put(key: string, value: string): void {
  writeDbAtomically(
    db,
    (d) =>
      void d
        .prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value),
    { seed: true }
  )
}

function get(key: string): string | undefined {
  const d = new DatabaseSync(db, { readOnly: true })
  try {
    return (d.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value?: string } | undefined)?.value
  } finally {
    d.close()
  }
}

describe('writeDbAtomically', () => {
  it('cria o banco e grava', () => {
    put('a', '1')
    expect(get('a')).toBe('1')
    expect(isReadableDb(db)).toBe(true)
  })

  it('com seed, preserva as outras chaves', () => {
    put('a', '1')
    put('b', '2')
    expect(get('a')).toBe('1')
    expect(get('b')).toBe('2')
  })

  it('sem seed, o arquivo é reescrito do zero', () => {
    put('a', '1')
    writeDbAtomically(db, (d) => void d.prepare('INSERT INTO kv(key, value) VALUES(?, ?)').run('b', '2'))
    expect(get('a')).toBeUndefined()
    expect(get('b')).toBe('2')
  })

  it('banco corrompido: guarda o arquivo velho e volta a gravar', () => {
    writeFileSync(db, 'isto nao e um banco', 'utf8')
    expect(isReadableDb(db)).toBe(false)

    expect(() => put('a', '1')).not.toThrow()
    expect(get('a')).toBe('1')
    expect(readdirSync(dir).some((f) => f.startsWith('teste.db.corrupt-'))).toBe(true)
  })

  it('não deixa journal de rollback ao lado do arquivo', () => {
    writeFileSync(`${db}-journal`, 'sobra de uma escrita interrompida', 'utf8')
    put('a', '1')
    expect(existsSync(`${db}-journal`)).toBe(false)
    expect(get('a')).toBe('1')
  })

  it('não deixa arquivo temporário para trás', () => {
    // tmpDir próprio: o %TEMP% do sistema também recebe os temporários de
    // qualquer instância do app rodando em paralelo, e a contagem mentiria.
    const scratch = join(dir, 'scratch')
    mkdirSync(scratch, { recursive: true })
    writeDbAtomically(db, (d) => void d.prepare('INSERT INTO kv(key, value) VALUES(?, ?)').run('a', '1'), {
      tmpDir: scratch
    })
    expect(get('a')).toBe('1')
    expect(readdirSync(scratch)).toEqual([])
    expect(readdirSync(dir).some((name) => name.includes('.swap-'))).toBe(false)
  })

  it('quarantineDb move o arquivo em vez de apagar', () => {
    writeFileSync(db, 'conteudo', 'utf8')
    quarantineDb(db)
    expect(existsSync(db)).toBe(false)
    expect(readdirSync(dir).some((f) => f.startsWith('teste.db.corrupt-'))).toBe(true)
  })

  it('lock transitório (EBUSY) na cópia de seed: tenta de novo e não coloca o banco em quarentena', () => {
    put('a', '1')
    let calls = 0
    mockedCopyFileSync.mockImplementation((src, dest) => {
      calls += 1
      if (calls < 3) {
        const error = new Error('busy') as NodeJS.ErrnoException
        error.code = 'EBUSY'
        throw error
      }
      return realCopyFileSync(src, dest)
    })
    expect(() => put('b', '2')).not.toThrow()
    expect(calls).toBeGreaterThanOrEqual(3)
    expect(get('a')).toBe('1')
    expect(get('b')).toBe('2')
    expect(readdirSync(dir).some((f) => f.startsWith('teste.db.corrupt-'))).toBe(false)
  })

  it('lock persistente na cópia de seed: propaga o erro em vez de zerar o banco', () => {
    put('a', '1')
    mockedCopyFileSync.mockImplementation(() => {
      const error = new Error('busy') as NodeJS.ErrnoException
      error.code = 'EBUSY'
      throw error
    })
    expect(() => put('b', '2')).toThrow()
    // O banco original não foi tocado nem colocado em quarentena.
    expect(get('a')).toBe('1')
    expect(get('b')).toBeUndefined()
    expect(readdirSync(dir).some((f) => f.startsWith('teste.db.corrupt-'))).toBe(false)
  })
})
