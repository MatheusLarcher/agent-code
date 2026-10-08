// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackupReason } from '../../../shared/databaseBackup'
import {
  backupBaseName,
  backupPath,
  commitBackup,
  deleteBackup,
  listBackups,
  pruneBackups,
  readBackupMeta,
  removePartials,
  uniqueBackupFile,
  type BackupMeta
} from './backupFiles'

let root: string
let dir: string
let temp: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-code-backups-'))
  dir = join(root, 'backups')
  temp = join(root, 'tmp')
  await writeFile(join(root, 'placeholder'), '')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const meta = (file: string, reason: BackupReason, createdAt: string): BackupMeta => ({
  version: 1,
  file,
  createdAt,
  side: 'local',
  reason,
  appVersion: '0.1.93',
  conversations: 3,
  lastUpdate: null,
  sizeBytes: 5,
  tables: { conversations: 3 },
  serverVersion: '18.6'
})

async function add(reason: BackupReason, minute: number): Promise<string> {
  const date = new Date(2026, 9, 8, 0, minute)
  const file = uniqueBackupFile(dir, date, 'local', reason)
  const dump = join(root, `${file}.src`)
  await writeFile(dump, 'PGDMP')
  await commitBackup(dir, dump, meta(file, reason, date.toISOString()))
  return file
}

describe('pasta de backups', () => {
  it('nome com data e hora locais, lado e motivo; no mesmo minuto ganha -2', async () => {
    const date = new Date(2026, 9, 8, 0, 12)
    expect(backupBaseName(date, 'nuvem', 'antes-da-troca')).toBe('2026-10-08_0012_nuvem_antes-da-troca')
    const first = await add('diario', 12)
    expect(first).toBe('2026-10-08_0012_local_diario.dump')
    expect(uniqueBackupFile(dir, date, 'local', 'diario')).toBe('2026-10-08_0012_local_diario-2.dump')
  })

  it('o .json vai por último: a lista só mostra backup completo, do mais novo para o mais antigo', async () => {
    const older = await add('diario', 1)
    const newer = await add('antes-da-troca', 2)
    // Um dump sem .json (app fechado entre um e outro) não é backup.
    await writeFile(join(dir, '2026-10-08_0003_local_diario.dump'), 'PGDMP')
    const { items, totalBytes } = await listBackups(dir)
    expect(items.map((item) => item.file)).toEqual([newer, older])
    expect(totalBytes).toBeGreaterThan(0)
    expect((await readBackupMeta(dir, older)).tables).toEqual({ conversations: 3 })
  })

  it('parciais de um backup interrompido somem; um nome fora do padrão é recusado', async () => {
    await add('diario', 1)
    await writeFile(join(dir, '2026-10-08_0002_local_diario.dump.partial'), 'meio')
    await writeFile(join(dir, '2026-10-08_0002_local_diario.json.tmp-123'), '{')
    expect(await removePartials(dir)).toBe(2)
    expect((await readdir(dir)).sort()).toEqual(['2026-10-08_0001_local_diario.dump', '2026-10-08_0001_local_diario.json'])
    expect(() => backupPath(dir, '..\\..\\segredo.dump')).toThrow(/inválido/)
    await expect(deleteBackup(dir, 'qualquer.txt')).rejects.toThrow(/inválido/)
  })

  it('retenção por motivo: o 11º diário apaga o mais antigo, sem tocar no de antes da troca', async () => {
    const troca = await add('antes-da-troca', 0)
    const diarios: string[] = []
    for (let minute = 1; minute <= 11; minute++) diarios.push(await add('diario', minute))
    expect(await pruneBackups(dir, 'diario')).toEqual([diarios[0]])
    const { items } = await listBackups(dir)
    expect(items.filter((item) => item.reason === 'diario')).toHaveLength(10)
    expect(items.some((item) => item.file === troca)).toBe(true)
    expect(existsSync(join(dir, diarios[0]))).toBe(false)
    expect(existsSync(join(dir, diarios[0].replace('.dump', '.json')))).toBe(false)
  })

  it('commit falhando não deixa .dump pela metade na pasta', async () => {
    const date = new Date(2026, 9, 8, 0, 5)
    const file = uniqueBackupFile(dir, date, 'local', 'diario')
    await expect(commitBackup(dir, join(temp, 'nao-existe.dump'), meta(file, 'diario', date.toISOString()))).rejects.toThrow(
      /Não foi possível gravar/
    )
    expect(existsSync(join(dir, file))).toBe(false)
    expect(existsSync(join(dir, `${file}.partial`))).toBe(false)
    expect(await readFile(join(root, 'placeholder'), 'utf8')).toBe('')
  })
})
