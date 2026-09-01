// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isReadableDb, quarantineDb, writeDbAtomically } from './atomicDb'

let dir: string
let db: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-code-atomicdb-'))
  db = join(dir, 'teste.db')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
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
})
