// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { missingDependencies } from './buildApk'

// O build do APK precisa rodar `npm install` de novo quando um plugin local
// (plugins/parakeet-stt) foi acrescentado depois da 1ª instalação: sem ele em
// node_modules, o `cap sync` gera um APK sem o plugin, em silêncio.

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'apk-deps-'))
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ dependencies: { jsqr: '^1.4.0', 'parakeet-stt': 'file:plugins/parakeet-stt' } })
  )
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function installed(name: string): Promise<void> {
  await mkdir(join(dir, 'node_modules', name), { recursive: true })
  await writeFile(join(dir, 'node_modules', name, 'package.json'), '{}')
}

describe('missingDependencies', () => {
  it('sem node_modules → precisa instalar', async () => {
    expect(await missingDependencies(dir)).toBe(true)
  })

  it('node_modules sem o plugin local → precisa instalar', async () => {
    await installed('jsqr')
    expect(await missingDependencies(dir)).toBe(true)
  })

  it('todas as dependências presentes → não reinstala', async () => {
    await installed('jsqr')
    await installed('parakeet-stt')
    expect(await missingDependencies(dir)).toBe(false)
  })
})
