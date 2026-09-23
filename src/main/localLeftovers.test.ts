// @vitest-environment node
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { localLeftoversSettled, relocateLocalLeftovers } from './localLeftovers'

describe('relocateLocalLeftovers', () => {
  let synced = ''
  let local = ''

  beforeEach(async () => {
    synced = await mkdtemp(join(tmpdir(), 'leftovers-synced-'))
    local = await mkdtemp(join(tmpdir(), 'leftovers-local-'))
  })

  afterEach(async () => {
    await rm(synced, { recursive: true, force: true })
    await rm(local, { recursive: true, force: true })
  })

  it('tira cache, log e backup da pasta sincronizada e deixa memórias e skills', async () => {
    await mkdir(join(synced, 'cli-config-sem-login', 'projects'), { recursive: true })
    await writeFile(join(synced, 'cli-config-sem-login', 'projects', 's.jsonl'), 'transcricao')
    await mkdir(join(synced, 'memorias-longo-praso'))
    await writeFile(join(synced, 'memorias-longo-praso', 'dia.parquet'), 'pq')
    await writeFile(join(synced, 'auth-debug.log'), 'linha\n')
    await mkdir(join(synced, 'memories'))
    await mkdir(join(synced, 'skills'))

    const result = await relocateLocalLeftovers(synced, local)

    expect(result.failed).toEqual([])
    expect(result.moved.sort()).toEqual(['auth-debug.log', 'cli-config-sem-login', 'memorias-longo-praso'])
    expect(await readFile(join(local, 'cli-config-sem-login', 'projects', 's.jsonl'), 'utf8')).toBe('transcricao')
    expect(await readFile(join(local, 'logs', 'auth-debug.log'), 'utf8')).toBe('linha\n')
    expect(existsSync(join(synced, 'cli-config-sem-login'))).toBe(false)
    expect(existsSync(join(synced, 'auth-debug.log'))).toBe(false)
    expect(existsSync(join(synced, 'memories'))).toBe(true)
    expect(existsSync(join(synced, 'skills'))).toBe(true)
  })

  it('não sobrescreve o que o app já gravou na raiz local', async () => {
    await mkdir(join(synced, 'memorias-longo-praso'))
    await writeFile(join(synced, 'memorias-longo-praso', 'hoje.parquet'), 'velho')
    await writeFile(join(synced, 'memorias-longo-praso', 'ontem.parquet'), 'ontem')
    await mkdir(join(local, 'memorias-longo-praso'))
    await writeFile(join(local, 'memorias-longo-praso', 'hoje.parquet'), 'novo')

    await relocateLocalLeftovers(synced, local)

    expect(await readFile(join(local, 'memorias-longo-praso', 'hoje.parquet'), 'utf8')).toBe('novo')
    expect(await readFile(join(local, 'memorias-longo-praso', 'ontem.parquet'), 'utf8')).toBe('ontem')
    expect(existsSync(join(synced, 'memorias-longo-praso'))).toBe(false)
  })

  it('sem sobras não faz nada, e quem espera é liberado ao fim', async () => {
    const running = relocateLocalLeftovers(synced, local)
    await localLeftoversSettled()
    expect(await running).toEqual({ moved: [], failed: [] })
  })
})
