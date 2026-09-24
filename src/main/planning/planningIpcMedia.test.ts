// @vitest-environment node
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Channels, type PlanningCardDto } from '../../shared/ipc'
import { registerPlanningIpc, type PlanningIpcListener, type PlanningMediaApi } from './planningIpc'
import * as realMedia from './planningMedia'

/** Mídia pelo IPC: planning:importMedia, planning:readMedia, media no open e anexos no card. */

let cwd: string
let outside: string
let handlers: Map<string, PlanningIpcListener>

const noopWatcher = (): { watch(): void; unwatch(): void; closeAll(): void } => ({
  watch: () => {},
  unwatch: () => {},
  closeAll: () => {}
})

function setup(media?: PlanningMediaApi): void {
  registerPlanningIpc({
    handle: (channel, listener) => void handlers.set(channel, listener),
    send: () => {},
    createWatcher: noopWatcher,
    ...(media ? { media } : {})
  })
}

async function call(channel: string, payload: unknown): Promise<any> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`sem handler: ${channel}`)
  return fn({ sender: { id: 1 } }, payload)
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9])
const ref = (): { projectCwd: string; slug: string } => ({ projectCwd: cwd, slug: 'p' })
const mediaDir = (): string => path.join(cwd, 'docs', 'spec', 'p', 'midia')

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-ipc-media-'))
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-ipc-media-out-'))
  handlers = new Map()
  setup()
  await call(Channels.planningCreate, { ...ref(), titulo: 'P' })
})

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true })
  await fs.rm(outside, { recursive: true, force: true })
})

describe('planning:importMedia / planning:readMedia', () => {
  it('importa por base64 e por caminho, o open lista, o readMedia devolve os bytes', async () => {
    const src = path.join(outside, 'Especificação.pdf')
    await fs.writeFile(src, 'pdf')
    const res = await call(Channels.planningImportMedia, {
      ...ref(),
      files: [{ name: 'Captura de Tela.png', data: PNG.toString('base64') }, { path: src }]
    })
    expect(res.ok).toBe(true)
    expect(res.media).toHaveLength(2)
    const [img, pdf] = res.media
    expect(img).toMatchObject({ kind: 'imagem', mediaType: 'image/png', size: PNG.length })
    expect(img.name).toMatch(/^[0-9a-f]{6}-captura-de-tela\.png$/)
    expect(pdf).toMatchObject({ kind: 'pdf', size: 3 })
    expect(pdf.name).toMatch(/-especificacao\.pdf$/)

    const opened = await call(Channels.planningOpen, ref())
    expect(opened.plan.media.map((m: { name: string }) => m.name).sort()).toEqual([img.name, pdf.name].sort())

    expect(await call(Channels.planningReadMedia, { ...ref(), name: img.name })).toEqual({
      ok: true,
      mediaType: 'image/png',
      base64: PNG.toString('base64'),
      size: PNG.length
    })
  })

  it('planning:create devolve media vazia', async () => {
    const res = await call(Channels.planningCreate, { projectCwd: cwd, slug: 'novo', titulo: 'N' })
    expect(res).toMatchObject({ ok: true, plan: { media: [] } })
  })

  it('payload inválido vira invalid, sem gravar nada', async () => {
    const bad: [string, unknown][] = [
      [Channels.planningImportMedia, { ...ref() }],
      [Channels.planningImportMedia, { ...ref(), files: [] }],
      [Channels.planningImportMedia, { ...ref(), files: 'x' }],
      [Channels.planningImportMedia, { ...ref(), files: [{ path: 'relativo/a.png' }] }],
      [Channels.planningImportMedia, { ...ref(), files: [{ name: 'a.png', data: 'não é base64!' }] }],
      [Channels.planningImportMedia, { ...ref(), files: [{ name: '', data: '' }] }],
      [Channels.planningImportMedia, { ...ref(), files: [{ name: 'a.png', data: 'AA==', path: '/x' }] }],
      [Channels.planningImportMedia, { ...ref(), files: [{ data: 'AA==' }] }],
      [Channels.planningImportMedia, { ...ref(), files: Array.from({ length: 21 }, () => ({ name: 'a.png', data: '' })) }],
      [Channels.planningImportMedia, { projectCwd: cwd, slug: '../fora', files: [{ name: 'a.png', data: '' }] }],
      [Channels.planningReadMedia, { ...ref() }],
      [Channels.planningReadMedia, { ...ref(), name: '../x.png' }],
      [Channels.planningReadMedia, { ...ref(), name: 'A.png' }],
      [Channels.planningReadMedia, { ...ref(), name: 'a/b.png' }],
      [Channels.planningReadMedia, { ...ref(), name: 42 }],
      [Channels.planningReadMedia, { ...ref(), name: 'a.png', extra: 1 }]
    ]
    for (const [channel, payload] of bad) {
      const res = await call(channel, payload)
      expect(res, `${channel} ${JSON.stringify(payload).slice(0, 120)}`).toMatchObject({ ok: false, code: 'invalid' })
      expect(typeof res.message).toBe('string')
    }
    expect(await fs.readdir(mediaDir()).catch(() => [])).toEqual([])
  })

  it('origem que não é arquivo vira invalid; que não existe, not_found; plano inexistente, not_found', async () => {
    expect(await call(Channels.planningImportMedia, { ...ref(), files: [{ path: outside }] })).toMatchObject({
      ok: false,
      code: 'invalid'
    })
    const missing = path.join(outside, 'sumiu.png')
    expect(await call(Channels.planningImportMedia, { ...ref(), files: [{ path: missing }] })).toMatchObject({
      ok: false,
      code: 'not_found'
    })
    const semPlano = { projectCwd: cwd, slug: 'nao-existe', files: [{ name: 'a.png', data: '' }] }
    expect(await call(Channels.planningImportMedia, semPlano)).toMatchObject({ ok: false, code: 'not_found' })
    expect(await call(Channels.planningReadMedia, { ...ref(), name: 'nao-existe.png' })).toMatchObject({
      ok: false,
      code: 'not_found'
    })
  })

  it('exceção do módulo de mídia não atravessa o IPC', async () => {
    handlers = new Map()
    const boom = vi.fn(async () => {
      throw Object.assign(new Error('EACCES: negado'), { code: 'EACCES' })
    })
    setup({ ...realMedia, importMedia: boom, readMedia: boom, listMedia: boom })
    expect(await call(Channels.planningImportMedia, { ...ref(), files: [{ name: 'a.png', data: '' }] })).toEqual({
      ok: false,
      code: 'io',
      message: 'EACCES: negado'
    })
    expect(await call(Channels.planningReadMedia, { ...ref(), name: 'a.png' })).toMatchObject({ ok: false, code: 'io' })
    expect(await call(Channels.planningOpen, ref())).toMatchObject({ ok: false, code: 'io' })
  })
})

describe('anexos e tipo midia no planning:saveCard', () => {
  const card = (over: Partial<PlanningCardDto> = {}): PlanningCardDto => ({
    id: 'm1',
    tipo: 'midia',
    titulo: 'Tela',
    links: [],
    anexos: ['a1b2c3-tela.png'],
    rev: 0,
    corpo: '',
    ...over
  })

  it('aceita card midia com anexos e o devolve no open', async () => {
    expect(await call(Channels.planningSaveCard, { ...ref(), card: card(), expectedRev: 0 })).toEqual({
      ok: true,
      card: { ...card(), rev: 1 }
    })
    const opened = await call(Channels.planningOpen, ref())
    expect(opened.plan.cards).toEqual([{ ...card(), rev: 1 }])
  })

  it('recusa anexo inválido, repetido, em excesso e midia sem anexo', async () => {
    const bad: PlanningCardDto[] = [
      card({ anexos: ['../x.png'] }),
      card({ anexos: ['A.png'] }),
      card({ anexos: Array.from({ length: 21 }, (_, i) => `f${i}.png`) }),
      card({ anexos: ['a.png', 'a.png'] }),
      card({ anexos: [] }),
      card({ anexos: undefined })
    ]
    for (const c of bad) {
      const res = await call(Channels.planningSaveCard, { ...ref(), card: c, expectedRev: 0 })
      expect(res, JSON.stringify(c.anexos)).toMatchObject({ ok: false, code: 'invalid' })
    }
    expect(await fs.readdir(path.join(cwd, 'docs', 'spec', 'p', 'cards'))).toEqual([])
  })
})
