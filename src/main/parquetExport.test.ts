// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { dailyParquetPath } from './conversationParquet'
import { removeParquetTemps, startDailyParquetExport } from './parquetExport'

const dirs: string[] = []
async function cacheDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'parquet-export-'))
  dirs.push(dir)
  await mkdir(join(dir, 'memories'), { recursive: true })
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const snapshot = {
  conversations: [{ id: 'c1', cwd: 'C:/repo', title: 'Teste', messages: [] }],
  backend: 'postgres' as const,
  watermark: 'w1'
}

describe('startDailyParquetExport', () => {
  it('lê, codifica e grava o arquivo do dia, com os tempos no log', async () => {
    const cache = await cacheDir()
    const log = vi.fn()
    const handle = startDailyParquetExport({
      cacheDir: cache,
      memoryDir: join(cache, 'memories'),
      readSnapshot: async () => snapshot,
      log,
      workerFile: null
    })
    await expect(handle.done).resolves.toBe(dailyParquetPath(cache))
    expect(existsSync(dailyParquetPath(cache))).toBe(true)
    expect(log.mock.calls[0][0]).toMatch(/parquet: 1 conversas exportadas em \d+ ms \(leitura \d+ ms, codificação \d+ ms/)
    handle.cancel() // depois de pronto: nada a fazer
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('cancelado ainda lendo o banco: não grava nada e o fechamento não espera', async () => {
    const cache = await cacheDir()
    const log = vi.fn()
    let release!: () => void
    const handle = startDailyParquetExport({
      cacheDir: cache,
      memoryDir: join(cache, 'memories'),
      readSnapshot: () => new Promise((resolve) => (release = () => resolve(snapshot))),
      log,
      workerFile: null
    })
    handle.cancel()
    release()
    await expect(handle.done).resolves.toBeNull()
    expect(existsSync(dailyParquetPath(cache))).toBe(false)
    expect(log.mock.calls.map((call) => call[0])).toEqual([expect.stringMatching(/cancelado no fechamento .*lendo o banco/)])
  })

  it('cancelado codificando: termina o worker e apaga o temporário', async () => {
    const cache = await cacheDir()
    // Um "worker" que nunca responde: a codificação de um snapshot enorme.
    const workerFile = join(cache, 'worker-lento.mjs')
    await writeFile(workerFile, "import { parentPort } from 'node:worker_threads'\nparentPort.on('message', () => {})\n")
    const target = dailyParquetPath(cache)
    await mkdir(dirname(target), { recursive: true })
    const log = vi.fn()
    let read = false
    const handle = startDailyParquetExport({
      cacheDir: cache,
      memoryDir: join(cache, 'memories'),
      readSnapshot: async () => {
        read = true
        return snapshot
      },
      log,
      workerFile
    })
    // O worker começa logo depois da leitura; ele estaria escrevendo o temporário.
    await vi.waitFor(() => expect(read).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await writeFile(`${target}.tmp-1-2`, 'parcial')
    handle.cancel()
    expect(log.mock.calls.map((call) => String(call[0]))).toEqual([expect.stringMatching(/cancelado no fechamento .*codificando/)])
    await expect(handle.done).resolves.toBeNull()
    await vi.waitFor(async () => expect((await readdir(dirname(target))).filter((name) => name.includes('.tmp-'))).toEqual([]))
    expect(existsSync(target)).toBe(false)
  })

  it('removeParquetTemps apaga só os temporários do export', async () => {
    const cache = await cacheDir()
    const target = dailyParquetPath(cache)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(`${target}.tmp-9-9`, 'x')
    await writeFile(target, 'arquivo bom')
    removeParquetTemps(cache)
    expect(await readdir(dirname(target))).toEqual([target.split(/[\\/]/).pop()])
  })
})
