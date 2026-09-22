import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createPlan, deleteCard, planDirPath, saveCard, saveLayout, saveRoteiro, writeHandoff } from './planningStore'
import { isIgnoredPlanPath, PlanningWatcher, type PlanningChange, type WatchFactory } from './planningWatcher'
import { recordOwnWrite, resetOwnWrites } from './planningWrites'

interface FakeHandle {
  dir: string
  emit: (rel: string | null) => void
  fail: (err: unknown) => void
  closed: boolean
  close(): void
}

function fakeFs(): {
  factory: WatchFactory
  handles: FakeHandle[]
  files: Map<string, string | 'dir'>
  readFile: (file: string) => Promise<Uint8Array | null | 'dir'>
  reads: string[]
} {
  const handles: FakeHandle[] = []
  const files = new Map<string, string | 'dir'>()
  const reads: string[] = []
  const factory: WatchFactory = (dir, onEvent, onError) => {
    const h: FakeHandle = {
      dir,
      emit: onEvent,
      fail: onError,
      closed: false,
      close() {
        h.closed = true
      }
    }
    handles.push(h)
    return h
  }
  const readFile = async (file: string): Promise<Uint8Array | null | 'dir'> => {
    reads.push(file)
    const v = files.get(file)
    if (v === undefined) return null
    return v === 'dir' ? 'dir' : Buffer.from(v, 'utf8')
  }
  return { factory, handles, files, readFile, reads }
}

const CWD = path.resolve('/projeto-falso')
const DIR = planDirPath(CWD, 'p')
const at = (...parts: string[]): string => path.join(DIR, ...parts)

describe('isIgnoredPlanPath', () => {
  it('ignora _sandbox/**, _handoff/** e *.tmp; aceita o resto', () => {
    for (const rel of ['_sandbox', '_sandbox\\a.txt', '_sandbox/x/y.md', '_handoff/2026-09-22-01.md', 'cards\\a.md.123.tmp', 'x.TMP']) {
      expect(isIgnoredPlanPath(rel)).toBe(true)
    }
    for (const rel of ['cards\\a.md', 'cards', '_roteiro.md', '_canvas.json', 'sandbox/a.md']) {
      expect(isIgnoredPlanPath(rel)).toBe(false)
    }
  })
})

describe('PlanningWatcher (emissor falso)', () => {
  let changes: PlanningChange[]
  let warn: Mock<(...args: unknown[]) => void>
  let f: ReturnType<typeof fakeFs>
  let watcher: PlanningWatcher

  beforeEach(() => {
    vi.useFakeTimers()
    resetOwnWrites()
    changes = []
    warn = vi.fn<(...args: unknown[]) => void>()
    f = fakeFs()
    watcher = new PlanningWatcher({
      onChange: (c) => changes.push(c),
      watchFactory: f.factory,
      readFile: f.readFile,
      warn
    })
  })

  afterEach(() => {
    watcher.closeAll()
    vi.useRealTimers()
  })

  it('agrupa uma rajada num único evento após o debounce', async () => {
    watcher.watch(CWD, 'p')
    expect(f.handles).toHaveLength(1)
    expect(f.handles[0].dir).toBe(DIR)
    f.files.set(at('cards', 'a.md'), 'externo')
    for (let i = 0; i < 5; i++) {
      f.handles[0].emit(path.join('cards', 'a.md'))
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(changes).toEqual([])
    await vi.advanceTimersByTimeAsync(150)
    expect(changes).toEqual([{ projectCwd: CWD, slug: 'p' }])
  })

  it('rajada contínua não adia o aviso além do maxWait', async () => {
    watcher.watch(CWD, 'p')
    f.files.set(at('_roteiro.md'), 'externo')
    for (let i = 0; i < 15; i++) {
      f.handles[0].emit('_roteiro.md')
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(changes.length).toBeGreaterThanOrEqual(1)
  })

  it('não dispara para o eco da gravação própria; dispara quando diverge, inclusive ao voltar', async () => {
    watcher.watch(CWD, 'p')
    const file = at('cards', 'a.md')
    recordOwnWrite(file, 'meu')
    f.files.set(file, 'meu')
    f.handles[0].emit(path.join('cards', 'a.md'))
    await vi.advanceTimersByTimeAsync(200)
    expect(changes).toHaveLength(0)

    f.files.set(file, 'editado por fora')
    f.handles[0].emit(path.join('cards', 'a.md'))
    await vi.advanceTimersByTimeAsync(200)
    expect(changes).toHaveLength(1)

    // Edição externa desfeita: o conteúdo volta ao que o app gravou, e isso é mudança.
    f.files.set(file, 'meu')
    f.handles[0].emit(path.join('cards', 'a.md'))
    await vi.advanceTimersByTimeAsync(200)
    expect(changes).toHaveLength(2)
  })

  it('remoção feita pelo app não dispara; remoção externa dispara', async () => {
    watcher.watch(CWD, 'p')
    recordOwnWrite(at('cards', 'a.md'), null)
    f.handles[0].emit(path.join('cards', 'a.md'))
    await vi.advanceTimersByTimeAsync(200)
    expect(changes).toHaveLength(0)
    f.handles[0].emit(path.join('cards', 'b.md'))
    await vi.advanceTimersByTimeAsync(200)
    expect(changes).toHaveLength(1)
  })

  it('ignora _sandbox, _handoff e .tmp sem nem ler o arquivo', async () => {
    watcher.watch(CWD, 'p')
    for (const rel of ['_sandbox', path.join('_sandbox', 'x.txt'), path.join('_handoff', 'h.md'), path.join('cards', 'a.md.1.tmp')]) {
      f.handles[0].emit(rel)
    }
    await vi.advanceTimersByTimeAsync(500)
    expect(changes).toHaveLength(0)
    expect(f.reads).toEqual([])
  })

  it('eco e mudança externa na mesma rajada: um evento', async () => {
    watcher.watch(CWD, 'p')
    recordOwnWrite(at('_canvas.json'), '{}')
    f.files.set(at('_canvas.json'), '{}')
    f.files.set(at('_roteiro.md'), 'externo')
    f.handles[0].emit('_canvas.json')
    f.handles[0].emit('_roteiro.md')
    await vi.advanceTimersByTimeAsync(200)
    expect(changes).toHaveLength(1)
  })

  it('evento só da pasta não dispara; evento sem nome de arquivo dispara', async () => {
    watcher.watch(CWD, 'p')
    f.files.set(at('cards'), 'dir')
    f.handles[0].emit('cards')
    await vi.advanceTimersByTimeAsync(200)
    expect(changes).toHaveLength(0)
    f.handles[0].emit(null)
    await vi.advanceTimersByTimeAsync(200)
    expect(changes).toHaveLength(1)
  })

  it('contagem de referências: só a última saída fecha; nada dispara depois', async () => {
    watcher.watch(CWD, 'p')
    watcher.watch(CWD, 'p')
    expect(f.handles).toHaveLength(1)
    watcher.unwatch(CWD, 'p')
    expect(f.handles[0].closed).toBe(false)
    f.files.set(at('_roteiro.md'), 'externo')
    f.handles[0].emit('_roteiro.md')
    // Sai antes do debounce vencer: o aviso pendente morre junto.
    watcher.unwatch(CWD, 'p')
    expect(f.handles[0].closed).toBe(true)
    expect(watcher.size).toBe(0)
    f.handles[0].emit('_roteiro.md')
    await vi.advanceTimersByTimeAsync(500)
    expect(changes).toHaveLength(0)
    watcher.unwatch(CWD, 'p') // sobra não quebra
  })

  it('planejamentos diferentes têm vigias e avisos separados', async () => {
    watcher.watch(CWD, 'p')
    watcher.watch(CWD, 'q')
    expect(f.handles).toHaveLength(2)
    f.handles[1].emit('_roteiro.md')
    await vi.advanceTimersByTimeAsync(200)
    expect(changes).toEqual([{ projectCwd: CWD, slug: 'q' }])
    watcher.closeAll()
    expect(f.handles.every((h) => h.closed)).toBe(true)
  })

  it('fs.watch que lança ou falha depois não derruba: avisa e fica mudo até reviver', async () => {
    const broken = new PlanningWatcher({
      onChange: (c) => changes.push(c),
      watchFactory: () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
      warn
    })
    expect(() => broken.watch(CWD, 'p')).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    broken.unwatch(CWD, 'p')

    watcher.watch(CWD, 'p')
    f.handles[0].fail(new Error('EPERM'))
    expect(warn).toHaveBeenCalledTimes(2)
    expect(f.handles[0].closed).toBe(true)
    watcher.revive(CWD, 'p')
    expect(f.handles).toHaveLength(2)
    expect(f.handles[1].closed).toBe(false)
  })

  it('recusa slug inválido (o chamador valida antes)', () => {
    expect(() => watcher.watch(CWD, '../x')).toThrow(/slug/)
    expect(() => watcher.watch('relativo', 'p')).toThrow(/absoluto/)
  })
})

describe('PlanningWatcher (fs.watch real, pasta temporária)', () => {
  let cwd: string
  let changes: PlanningChange[]
  let watcher: PlanningWatcher
  const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const cardsDir = (): string => path.join(cwd, 'docs', 'spec', 'p', 'cards')
  /** Controle positivo: prova que a vigia está viva depois de um "não disparou". */
  const expectExternalFires = async (): Promise<void> => {
    await fs.writeFile(path.join(cardsDir(), 'controle.md'), `externo ${Date.now()}`)
    await vi.waitFor(() => expect(changes).toHaveLength(1), { timeout: 4000, interval: 25 })
  }

  beforeEach(async () => {
    resetOwnWrites()
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-watch-'))
    await createPlan(cwd, 'p', 'P')
    changes = []
    watcher = new PlanningWatcher({ onChange: (c) => changes.push(c), warn: () => {} })
    watcher.watch(cwd, 'p')
    await settle(100)
  })

  afterEach(async () => {
    watcher.closeAll()
    await fs.rm(cwd, { recursive: true, force: true })
  })

  it('edição externa dispara exatamente um evento', async () => {
    await fs.writeFile(path.join(cardsDir(), 'externo.md'), '---\nid: "externo"\n---\n')
    await fs.appendFile(path.join(cardsDir(), 'externo.md'), 'mais uma linha\n')
    await vi.waitFor(() => expect(changes).toHaveLength(1), { timeout: 4000, interval: 25 })
    await settle(500)
    expect(changes).toEqual([{ projectCwd: cwd, slug: 'p' }])
  })

  it('gravações pelo store não disparam', async () => {
    const card = { id: 'req-1', tipo: 'requisito' as const, titulo: 'R', links: [], rev: 0, corpo: 'x\n' }
    await saveCard(cwd, 'p', card, 0)
    await saveCard(cwd, 'p', { ...card, titulo: 'R2' }, 1)
    await saveRoteiro(cwd, 'p', { titulo: 'P', etapas: [{ id: 'e1', titulo: 'E', status: 'pendente' }] }, 1)
    await saveLayout(cwd, 'p', { positions: { 'req-1': { x: 1, y: 2 } } })
    await saveCard(cwd, 'p', { ...card, id: 'req-2' }, 0)
    await deleteCard(cwd, 'p', 'req-2', 1)
    await settle(700)
    expect(changes).toEqual([])
    await expectExternalFires()
  })

  it('sensibilidade: sem o registro de eco, a mesma gravação do store dispararia', async () => {
    const blind = new PlanningWatcher({ onChange: (c) => changes.push(c), isOwnWrite: () => false, warn: () => {} })
    watcher.unwatch(cwd, 'p')
    blind.watch(cwd, 'p')
    try {
      await settle(100)
      await saveCard(cwd, 'p', { id: 'req-1', tipo: 'requisito', titulo: 'R', links: [], rev: 0, corpo: '' }, 0)
      await vi.waitFor(() => expect(changes).toHaveLength(1), { timeout: 4000, interval: 25 })
    } finally {
      blind.closeAll()
    }
  })

  it('mudanças em _sandbox, _handoff e *.tmp não disparam', async () => {
    const sandbox = path.join(cwd, 'docs', 'spec', 'p', '_sandbox')
    await fs.writeFile(path.join(sandbox, 'rascunho.txt'), 'x')
    await fs.mkdir(path.join(sandbox, 'sub'), { recursive: true })
    await fs.writeFile(path.join(sandbox, 'sub', 'a.md'), 'y')
    await writeHandoff(cwd, 'p', 'prompt')
    await fs.writeFile(path.join(cardsDir(), 'meio.md.tmp'), 'z')
    await settle(700)
    expect(changes).toEqual([])
    await expectExternalFires()
  })

  it('depois de unwatch, edição externa não dispara', async () => {
    watcher.unwatch(cwd, 'p')
    expect(watcher.size).toBe(0)
    await fs.writeFile(path.join(cardsDir(), 'tarde.md'), 'x')
    await settle(700)
    expect(changes).toEqual([])
  })

  it('pasta inexistente não derruba: só avisa', () => {
    const warn = vi.fn<(...args: unknown[]) => void>()
    const w = new PlanningWatcher({ onChange: () => {}, warn })
    expect(() => w.watch(cwd, 'nao-existe')).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    w.closeAll()
  })
})
