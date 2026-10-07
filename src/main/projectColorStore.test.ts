// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { SANDBOX_PROJECT_COLOR, reserveProjectColor, type ProjectColor } from '../shared/projectColor'
import {
  PROJECT_COLOR_KV_PREFIX,
  createProjectColorService,
  parseProjectColorCwds,
  type ProjectColorDeps,
  type ProjectColorKv
} from './projectColorStore'
import type { KvWrite, VersionedKv } from './persistence/types'

/** KV em memória com a regra de revisão dos repositórios reais. */
function fakeKv(): ProjectColorKv & { rows: Map<string, VersionedKv> } {
  const rows = new Map<string, VersionedKv>()
  return {
    rows,
    getKv: vi.fn(async ({ key }) => rows.get(key) ?? null),
    setKv: vi.fn(async (write: KvWrite) => {
      const current = rows.get(write.key)
      const expected = write.expectedRevision
      const ok = current ? expected === current.revision : expected === undefined || expected === 0
      if (!ok) throw Object.assign(new Error('conflito'), { code: 'REVISION_CONFLICT' })
      const row: VersionedKv = {
        scope: write.scope,
        key: write.key,
        value: write.value,
        revision: (current?.revision ?? 0) + 1,
        contentHash: '',
        updatedAt: ''
      }
      rows.set(write.key, row)
      return row
    })
  }
}

const CWD = 'C:\\GitHub\\proj'
const ID = 'id-proj'
const KEY = `${PROJECT_COLOR_KV_PREFIX}${ID}`
const LOGO: ProjectColor = { hex: '#2563eb', source: 'logo', file: 'public/logo.svg' }
const TEMA: ProjectColor = { hex: '#059669', source: 'tema', file: 'src/index.css' }

function service(over: Partial<ProjectColorDeps> & { kv?: ProjectColorKv | null }) {
  const kv = over.kv === undefined ? fakeKv() : over.kv
  const detect = over.detect ?? vi.fn(async () => LOGO)
  const svc = createProjectColorService({
    repository: over.repository ?? (() => kv),
    projectId: over.projectId ?? (async () => ID),
    detect,
    isSandbox: over.isSandbox ?? (() => false),
    now: () => new Date('2026-10-07T00:00:00Z')
  })
  return { svc, kv, detect }
}

const stored = (kv: ProjectColorKv & { rows: Map<string, VersionedKv> }) => JSON.parse(kv.rows.get(KEY)!.value)

describe('fixação no KV global', () => {
  it('sem cor gravada: detecta, grava (scope global) e devolve', async () => {
    const kv = fakeKv()
    const { svc } = service({ kv })
    expect(await svc.colorsFor([CWD])).toEqual({ [CWD]: LOGO })
    expect(kv.setKv).toHaveBeenCalledWith(expect.objectContaining({ scope: 'global', key: KEY, expectedRevision: 0 }))
    expect(stored(kv)).toMatchObject({ ...LOGO, at: '2026-10-07T00:00:00.000Z' })
  })

  it('com cor gravada (logo/marca/tema): nem detecta, e nunca muda', async () => {
    const kv = fakeKv()
    await kv.setKv({ scope: 'global', key: KEY, value: JSON.stringify({ ...TEMA, at: 'x' }) })
    const { svc, detect } = service({ kv, detect: vi.fn(async () => LOGO) })
    expect(await svc.colorsFor([CWD])).toEqual({ [CWD]: TEMA })
    expect(detect).not.toHaveBeenCalled()
  })

  it('sem nenhuma fonte: grava a reserva pela identidade', async () => {
    const kv = fakeKv()
    const { svc } = service({ kv, detect: vi.fn(async () => null) })
    const color = { hex: reserveProjectColor(ID), source: 'reserva' }
    expect(await svc.colorsFor([CWD])).toEqual({ [CWD]: color })
    expect(stored(kv)).toMatchObject(color)
  })

  it('reserva é trocada UMA vez quando o projeto ganha logo/tema; depois não muda mais', async () => {
    const kv = fakeKv()
    await kv.setKv({ scope: 'global', key: KEY, value: JSON.stringify({ hex: reserveProjectColor(ID), source: 'reserva', at: 'x' }) })
    const first = service({ kv, detect: vi.fn(async () => TEMA) })
    expect(await first.svc.colorsFor([CWD])).toEqual({ [CWD]: TEMA })
    expect(stored(kv)).toMatchObject({ ...TEMA, replacedReserve: true })
    // Nova sessão, o projeto trocou de logo: a cor fixada fica.
    const second = service({ kv, detect: vi.fn(async () => LOGO) })
    expect(await second.svc.colorsFor([CWD])).toEqual({ [CWD]: TEMA })
    expect(second.detect).not.toHaveBeenCalled()
  })

  it('reserva gravada e ainda sem logo/tema: continua a reserva, sem regravar', async () => {
    const kv = fakeKv()
    const reserve = { hex: reserveProjectColor(ID), source: 'reserva' as const }
    await kv.setKv({ scope: 'global', key: KEY, value: JSON.stringify({ ...reserve, at: 'x' }) })
    const { svc } = service({ kv, detect: vi.fn(async () => null) })
    expect(await svc.colorsFor([CWD])).toEqual({ [CWD]: reserve })
    expect(kv.setKv).toHaveBeenCalledTimes(1)
  })

  it('outro PC fixou primeiro (conflito de revisão): vale a dele', async () => {
    const kv = fakeKv()
    const { svc } = service({
      kv,
      detect: vi.fn(async () => {
        await kv.setKv({ scope: 'global', key: KEY, value: JSON.stringify({ ...TEMA, at: 'x' }) })
        return LOGO
      })
    })
    expect(await svc.colorsFor([CWD])).toEqual({ [CWD]: TEMA })
  })

  it('persistência indisponível: devolve a detectada sem gravar e grava no próximo pedido sem varrer de novo', async () => {
    const kv = fakeKv()
    let up = false
    const detect = vi.fn(async () => LOGO)
    const { svc } = service({
      detect,
      repository: () => {
        if (!up) throw new Error('offline')
        return kv
      }
    })
    expect(await svc.colorsFor([CWD])).toEqual({ [CWD]: LOGO })
    expect(kv.rows.size).toBe(0)
    up = true
    expect(await svc.colorsFor([CWD])).toEqual({ [CWD]: LOGO })
    expect(kv.rows.size).toBe(1)
    expect(detect).toHaveBeenCalledTimes(1)
  })

  it('pasta sem identidade: chave pelo caminho', async () => {
    const kv = fakeKv()
    const { svc } = service({ kv, projectId: async () => Promise.reject(new Error('sem pasta')) })
    await svc.colorsFor([CWD])
    expect([...kv.rows.keys()][0]).toMatch(new RegExp(`^${PROJECT_COLOR_KV_PREFIX}path:[0-9a-f]{32}$`))
  })

  it('sandbox: cor constante, sem KV nem detecção', async () => {
    const kv = fakeKv()
    const { svc, detect } = service({ kv, isSandbox: () => true })
    expect(await svc.colorsFor(['C:\\x\\sandbox\\2026-10-06_09-03_f38b'])).toEqual({
      'C:\\x\\sandbox\\2026-10-06_09-03_f38b': SANDBOX_PROJECT_COLOR
    })
    expect(detect).not.toHaveBeenCalled()
    expect(kv.getKv).not.toHaveBeenCalled()
  })

  it('peek devolve só o já resolvido e dispara o resto', async () => {
    const { svc, detect } = service({})
    expect(svc.peek([CWD])).toEqual({})
    await vi.waitFor(() => expect(svc.peek([CWD])).toEqual({ [CWD]: LOGO }))
    expect(detect).toHaveBeenCalledTimes(1)
  })
})

describe('parseProjectColorCwds (borda do IPC)', () => {
  it('aceita caminhos absolutos e tira repetidos', () => {
    expect(parseProjectColorCwds(['C:\\GitHub\\a', '/home/x/b', 'C:\\GitHub\\a'])).toEqual(['C:\\GitHub\\a', '/home/x/b'])
    expect(parseProjectColorCwds([])).toEqual([])
  })

  it.each([
    ['não array', 'C:\\a'],
    ['item não string', [1]],
    ['relativo', ['src/x']],
    ['vazio', ['']],
    ['NUL', ['C:\\a\0b']],
    ['caminho enorme', ['C:\\' + 'a'.repeat(2000)]],
    ['muitos', Array.from({ length: 201 }, (_, i) => `C:\\p${i}`)]
  ])('rejeita %s', (_name, input) => {
    expect(() => parseProjectColorCwds(input)).toThrow(TypeError)
  })
})
