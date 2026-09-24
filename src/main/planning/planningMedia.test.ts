// @vitest-environment node
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_MEDIA_BYTES, MAX_MEDIA_PREVIEW_BYTES } from '../../shared/planningMedia'
import { importMedia, listMedia, readMedia } from './planningMedia'
import { PlanningValidationError } from './planningModel'
import { createPlan, planDirPath, PlanNotFoundError } from './planningStore'
import { isOwnWrite, resetOwnWrites } from './planningWrites'

let cwd: string
let outside: string

const mediaDir = (): string => path.join(planDirPath(cwd, 'p'), 'midia')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-media-'))
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-media-out-'))
  resetOwnWrites()
  await createPlan(cwd, 'p', 'P')
})

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true })
  await fs.rm(outside, { recursive: true, force: true })
})

describe('importMedia', () => {
  it('por bytes: nome saneado, grava em midia/ e devolve o DTO', async () => {
    const dto = await importMedia(cwd, 'p', { name: 'Tela de Login.PNG', data: PNG })
    expect(dto.name).toMatch(/^[0-9a-f]{6}-tela-de-login\.png$/)
    expect(dto).toMatchObject({ kind: 'imagem', mediaType: 'image/png', size: PNG.length })
    expect(dto.path).toBe(path.join(mediaDir(), dto.name))
    expect(path.isAbsolute(dto.path)).toBe(true)
    expect(await fs.readFile(dto.path)).toEqual(PNG)
    // Sem sobra do tmp.
    expect(await fs.readdir(mediaDir())).toEqual([dto.name])
  })

  it('registra a gravação como própria: o vigia não recarrega a tela por eco', async () => {
    const dto = await importMedia(cwd, 'p', { name: 'a.png', data: PNG })
    expect(isOwnWrite(dto.path, await fs.readFile(dto.path))).toBe(true)
    const src = path.join(outside, 'Relatório Final.pdf')
    await fs.writeFile(src, 'pdf de verdade')
    const copied = await importMedia(cwd, 'p', { path: src })
    expect(isOwnWrite(copied.path, await fs.readFile(copied.path))).toBe(true)
    // Mudança por fora depois disso não é eco.
    await fs.writeFile(copied.path, 'editado fora')
    expect(isOwnWrite(copied.path, await fs.readFile(copied.path))).toBe(false)
  })

  it('por caminho: copia o arquivo, nome pelo arquivo ou pelo `name` dado', async () => {
    const src = path.join(outside, 'Relatório Final (v2).pdf')
    await fs.writeFile(src, 'conteudo')
    const dto = await importMedia(cwd, 'p', { path: src })
    expect(dto.name).toMatch(/^[0-9a-f]{6}-relatorio-final-v2\.pdf$/)
    expect(dto).toMatchObject({ kind: 'pdf', mediaType: 'application/pdf', size: 8 })
    expect(await fs.readFile(dto.path, 'utf8')).toBe('conteudo')
    expect(await fs.readFile(src, 'utf8')).toBe('conteudo')
    const renamed = await importMedia(cwd, 'p', { path: src, name: 'Demo.mp4' })
    expect(renamed).toMatchObject({ kind: 'video', mediaType: 'video/mp4' })
    expect(renamed.name).toMatch(/-demo\.mp4$/)
  })

  it('colisão de nome: sorteia outro prefixo e não sobrescreve', async () => {
    const prefixes = ['aaaaaa', 'aaaaaa', 'bbbbbb']
    const randomPrefix = (): string => prefixes.shift() ?? 'cccccc'
    const first = await importMedia(cwd, 'p', { name: 'x.png', data: PNG }, { randomPrefix })
    const second = await importMedia(cwd, 'p', { name: 'x.png', data: Buffer.from('outro') }, { randomPrefix })
    expect(first.name).toBe('aaaaaa-x.png')
    expect(second.name).toBe('bbbbbb-x.png')
    expect(await fs.readFile(first.path)).toEqual(PNG)
  })

  it('recusa origem que não é arquivo comum, caminho relativo e origem que não existe', async () => {
    await expect(importMedia(cwd, 'p', { path: outside })).rejects.toThrow(/arquivo comum/)
    await expect(importMedia(cwd, 'p', { path: 'relativo.png' })).rejects.toThrow(PlanningValidationError)
    await expect(importMedia(cwd, 'p', { path: path.join(outside, 'nao-existe.png') })).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('recusa acima de MAX_MEDIA_BYTES sem copiar nada', async () => {
    const big = path.join(outside, 'grande.mp4')
    const fh = await fs.open(big, 'w')
    await fh.truncate(MAX_MEDIA_BYTES + 1)
    await fh.close()
    await expect(importMedia(cwd, 'p', { path: big })).rejects.toThrow(/grande/)
    await expect(importMedia(cwd, 'p', { name: 'a.png', data: PNG }, { maxBytes: PNG.length - 1 })).rejects.toThrow(
      /grande/
    )
    expect(await fs.readdir(mediaDir()).catch(() => [])).toEqual([])
  })

  it('plano inexistente ou slug inválido são recusados', async () => {
    await expect(importMedia(cwd, 'nao-existe', { name: 'a.png', data: PNG })).rejects.toThrow(PlanNotFoundError)
    await expect(importMedia(cwd, '../x', { name: 'a.png', data: PNG })).rejects.toThrow(/slug/)
  })

  it('midia/ que escapa por symlink é recusada (importar, listar e ler)', async () => {
    await fs.symlink(outside, mediaDir(), 'junction')
    await expect(importMedia(cwd, 'p', { name: 'a.png', data: PNG })).rejects.toThrow(/symlink/)
    await fs.writeFile(path.join(outside, 'a1b2c3-x.png'), PNG)
    await expect(listMedia(cwd, 'p')).rejects.toThrow(/symlink/)
    await expect(readMedia(cwd, 'p', 'a1b2c3-x.png')).rejects.toThrow(/symlink/)
    expect(await fs.readdir(outside)).toEqual(['a1b2c3-x.png'])
  })
})

describe('listMedia', () => {
  it('sem midia/: lista vazia', async () => {
    expect(await listMedia(cwd, 'p')).toEqual([])
  })

  it('só arquivos comuns com nome válido, em ordem de nome', async () => {
    const b = await importMedia(cwd, 'p', { name: 'b.pdf', data: Buffer.from('b') }, { randomPrefix: () => 'bbbbbb' })
    const a = await importMedia(cwd, 'p', { name: 'a.png', data: PNG }, { randomPrefix: () => 'aaaaaa' })
    await fs.writeFile(path.join(mediaDir(), 'Maiuscula.png'), 'x')
    await fs.writeFile(path.join(mediaDir(), 'x.png.123.tmp'), 'x')
    await fs.mkdir(path.join(mediaDir(), 'subpasta'))
    expect(await listMedia(cwd, 'p')).toEqual([a, b])
  })
})

describe('readMedia', () => {
  it('devolve base64, tipo e tamanho', async () => {
    const dto = await importMedia(cwd, 'p', { name: 'a.png', data: PNG })
    expect(await readMedia(cwd, 'p', dto.name)).toEqual({
      mediaType: 'image/png',
      base64: PNG.toString('base64'),
      size: PNG.length
    })
  })

  it('recusa nome inválido, inexistente e acima de MAX_MEDIA_PREVIEW_BYTES', async () => {
    for (const bad of ['../x.png', 'A.png', 'a/b.png', '']) {
      await expect(readMedia(cwd, 'p', bad), bad).rejects.toThrow(PlanningValidationError)
    }
    await expect(readMedia(cwd, 'p', 'nao-existe.png')).rejects.toMatchObject({ code: 'ENOENT' })
    await fs.mkdir(mediaDir(), { recursive: true })
    const fh = await fs.open(path.join(mediaDir(), 'grande.mp4'), 'w')
    await fh.truncate(MAX_MEDIA_PREVIEW_BYTES + 1)
    await fh.close()
    await expect(readMedia(cwd, 'p', 'grande.mp4')).rejects.toThrow(/grande/)
  })
})
