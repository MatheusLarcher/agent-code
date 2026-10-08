// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRemoteApk, isStaleAndroidProject, missingDependencies, phoneBuildCommand, resolveRemoteRoot } from './buildApk'

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

async function installed(name: string, version = '1.4.0'): Promise<void> {
  await mkdir(join(dir, 'node_modules', name), { recursive: true })
  await writeFile(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ version }))
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

  it('major instalada diferente da pedida (Capacitor 6 de antes do 8) → reinstala', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { '@capacitor/android': '^8.5.2' }, devDependencies: { '@capacitor/cli': '^8.5.2' } })
    )
    await installed('@capacitor/android', '8.5.2')
    await installed('@capacitor/cli', '6.2.1')
    expect(await missingDependencies(dir)).toBe(true)
    await installed('@capacitor/cli', '8.5.2')
    expect(await missingDependencies(dir)).toBe(false)
  })
})

// O android/ é gitignorado e gerado pelo `cap add android`: um gerado pelo
// template do Capacitor 6 (compileSdk 34) não compila com o @capacitor/android 8.
describe('isStaleAndroidProject', () => {
  const vars = (sdk: number): string =>
    `ext {\n    minSdkVersion = 24\n    compileSdkVersion = ${sdk}\n    targetSdkVersion = ${sdk}\n}\n`

  it('template do Capacitor 6 (compileSdk 34) → recriar', async () => {
    await writeFile(join(dir, 'variables.gradle'), vars(34))
    expect(await isStaleAndroidProject(dir)).toBe(true)
  })

  it('template do Capacitor 8 (compileSdk 36) → manter', async () => {
    await writeFile(join(dir, 'variables.gradle'), vars(36))
    expect(await isStaleAndroidProject(dir)).toBe(false)
  })

  it('layout bridge_layout_main (pré-8) no app → recriar', async () => {
    await writeFile(join(dir, 'variables.gradle'), vars(36))
    const layout = join(dir, 'app', 'src', 'main', 'res', 'layout')
    await mkdir(layout, { recursive: true })
    await writeFile(join(layout, 'bridge_layout_main.xml'), '<x/>')
    expect(await isStaleAndroidProject(dir)).toBe(true)
  })

  it('sem variables.gradle (projeto quebrado) → recriar', async () => {
    expect(await isStaleAndroidProject(dir)).toBe(true)
  })
})

describe('phoneBuildCommand', () => {
  it('roda npm run phone:build na raiz do repositório (pai de smartfone-remote)', () => {
    const root = join(dir, 'smartfone-remote')
    expect(phoneBuildCommand(root)).toEqual({ cmd: 'npm', args: ['run', 'phone:build'], cwd: join(root, '..') })
  })
})

// O app instalado (resources/app) não leva o smartfone-remote: sem cair no
// repositório, o npm install rodava numa pasta inexistente e o Windows dizia
// "spawn C:\WINDOWS\system32\cmd.exe ENOENT".
describe('resolveRemoteRoot', () => {
  it('pula o candidato sem package.json e usa o repositório', () => {
    expect(resolveRemoteRoot([join(dir, 'nao-existe'), undefined, dir])).toBe(dir)
  })

  it('nenhum existe → o primeiro, para o erro mostrar o caminho esperado', () => {
    const first = join(dir, 'a')
    expect(resolveRemoteRoot([first, join(dir, 'b')])).toBe(first)
  })
})

describe('buildRemoteApk sem o projeto', () => {
  it('para antes de qualquer spawn, com mensagem clara', async () => {
    const lines: string[] = []
    const missing = join(dir, 'nao-existe')
    const r = await buildRemoteApk(missing, (l) => lines.push(l))
    expect(r.ok).toBe(false)
    expect(r.message).toContain(missing)
    expect(lines).toEqual([])
  })
})
