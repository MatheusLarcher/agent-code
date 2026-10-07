import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { absolutePathProblem, memoryFilePath, revealFile, type RevealFileDeps } from './revealFile'

let base: string
let mem: string
let proj: string
let other: string
let deps: RevealFileDeps & { showItemInFolder: ReturnType<typeof vi.fn<(path: string) => void>>; openPath: ReturnType<typeof vi.fn<(path: string) => Promise<string>>> }

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'reveal-'))
  mem = join(base, 'memories')
  proj = join(base, 'loja')
  other = join(base, 'outro')
  for (const d of [join(mem, '2D'), join(proj, 'src'), other]) mkdirSync(d, { recursive: true })
  writeFileSync(join(mem, '2D', 'vps.md'), '# vps')
  writeFileSync(join(proj, 'src', 'a.ts'), 'x')
  writeFileSync(join(proj, 'run.bat'), 'echo')
  writeFileSync(join(other, 'b.ts'), 'y')
  deps = {
    memoriesDir: () => mem,
    knownProjects: async () => [proj, other],
    showItemInFolder: vi.fn(),
    openPath: vi.fn(async () => '')
  }
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('revealFile — a borda do IPC', () => {
  it('memória dentro da pasta: o Explorador com o .md selecionado', async () => {
    const r = await revealFile({ mode: 'folder', memory: '2D/vps.md' }, deps)
    expect(r.ok).toBe(true)
    expect(deps.showItemInFolder).toHaveBeenCalledWith(join(mem, '2D', 'vps.md'))
  })

  it('memória: recusa `..`, absoluto, não-.md e "abrir" (só leitura); inexistente vem como missing', async () => {
    for (const memory of ['../loja/src/a.ts', '2D/../../x.md', join(mem, '2D', 'vps.md'), '/etc/x.md', '2D/vps.txt', 'a.md:x', '', 42]) {
      expect((await revealFile({ mode: 'folder', memory }, deps)).ok).toBe(false)
    }
    expect((await revealFile({ mode: 'open', memory: '2D/vps.md' }, deps)).ok).toBe(false)
    expect(await revealFile({ mode: 'folder', memory: '2D/sumiu.md' }, deps)).toMatchObject({ ok: false, missing: true })
    expect(deps.showItemInFolder).not.toHaveBeenCalled()
  })

  it('arquivo do projeto da conversa: mostrar na pasta e abrir no programa padrão', async () => {
    const file = join(proj, 'src', 'a.ts')
    expect((await revealFile({ mode: 'folder', path: file, cwd: proj }, deps)).ok).toBe(true)
    expect(deps.showItemInFolder).toHaveBeenCalledWith(file)
    expect((await revealFile({ mode: 'open', path: file, cwd: proj }, deps)).ok).toBe(true)
    expect(deps.openPath).toHaveBeenCalledWith(file)
  })

  it('fora do projeto da conversa, projeto desconhecido, relativo e `..`: recusa sem abrir nada', async () => {
    const cases: unknown[] = [
      { mode: 'open', path: join(other, 'b.ts'), cwd: proj },
      { mode: 'open', path: join(proj, 'src', 'a.ts'), cwd: join(base, 'desconhecido') },
      { mode: 'open', path: 'src/a.ts', cwd: proj },
      { mode: 'open', path: `${proj}/src/../src/a.ts`, cwd: proj },
      { mode: 'open', path: `${proj}/../outro/b.ts`, cwd: proj },
      { mode: 'open', path: join(proj, 'src', 'a.ts'), cwd: 'loja' },
      { mode: 'apagar', path: join(proj, 'src', 'a.ts'), cwd: proj },
      null,
      'C:\\x'
    ]
    for (const c of cases) expect((await revealFile(c, deps)).ok).toBe(false)
    expect(deps.showItemInFolder).not.toHaveBeenCalled()
    expect(deps.openPath).not.toHaveBeenCalled()
  })

  it('inexistente: missing; pasta não é arquivo; executável abre a pasta em vez de executar', async () => {
    expect(await revealFile({ mode: 'open', path: join(proj, 'src', 'sumiu.ts'), cwd: proj }, deps)).toMatchObject({ ok: false, missing: true })
    expect((await revealFile({ mode: 'folder', path: join(proj, 'src'), cwd: proj }, deps)).ok).toBe(false)
    const bat = await revealFile({ mode: 'open', path: join(proj, 'run.bat'), cwd: proj }, deps)
    expect(bat.ok).toBe(true)
    expect(deps.openPath).not.toHaveBeenCalled()
    expect(deps.showItemInFolder).toHaveBeenCalledWith(join(proj, 'run.bat'))
  })

  it('o erro do shell.openPath volta como falha', async () => {
    deps.openPath.mockResolvedValueOnce('sem programa associado')
    const r = await revealFile({ mode: 'open', path: join(proj, 'src', 'a.ts'), cwd: proj }, deps)
    expect(r).toMatchObject({ ok: false })
    expect(r.message).toContain('sem programa associado')
  })
})

describe('absolutePathProblem / memoryFilePath', () => {
  it('aceita absoluto limpo; recusa relativo, `..`, dispositivo, fluxo alternativo e controle', () => {
    expect(absolutePathProblem('C:\\proj\\a.ts')).toBeNull()
    expect(absolutePathProblem('\\\\servidor\\pasta\\a.ts')).toBeNull()
    for (const p of ['a.ts', 'C:a.ts', 'C:\\proj\\..\\a.ts', 'C:\\proj\\.\\a.ts', '\\\\?\\C:\\a.ts', '\\\\.\\COM1', 'C:\\a.ts:zone', 'C:\\a\u0000.ts', '', 1]) {
      expect(absolutePathProblem(p)).not.toBeNull()
    }
  })

  it('memória: junta na pasta de memórias', () => {
    expect(memoryFilePath('C:\\mem', 'a/b.md')).toEqual({ file: join('C:\\mem', 'a', 'b.md') })
    expect(memoryFilePath('C:\\mem', 'a//b.md')).toHaveProperty('problem')
  })
})
