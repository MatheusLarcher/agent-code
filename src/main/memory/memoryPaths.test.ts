// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryWriteDenial, pathInside, realPathInside } from './memoryPaths'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(): { memories: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), 'agent-code-memory-paths-'))
  roots.push(root)
  const memories = join(root, 'memories')
  const outside = join(root, 'outside')
  mkdirSync(memories)
  mkdirSync(outside)
  return { memories, outside }
}

describe('containment', () => {
  it('aceita o que está dentro e recusa o que escapa', () => {
    const { memories, outside } = fixture()
    expect(pathInside(memories, join(memories, '2D', 'nota.md'))).toBe(true)
    expect(pathInside(memories, memories)).toBe(true)
    expect(pathInside(memories, outside)).toBe(false)
    expect(pathInside(memories, join(memories, '..', 'outside', 'x.md'))).toBe(false)
    expect(realPathInside(memories, join(memories, 'novo.md'))).toBe(true)
    expect(realPathInside(memories, join(outside, 'novo.md'))).toBe(false)
  })

  it('não deixa um link dentro da pasta redirecionar para fora', () => {
    const { memories, outside } = fixture()
    const target = join(outside, 'alvo.md')
    writeFileSync(target, 'fora')
    let linked = false
    try {
      symlinkSync(target, join(memories, 'link.md'), 'file')
      linked = true
    } catch {
      // Windows sem privilégio de symlink: o resto do teste segue valendo.
    }
    if (linked) expect(realPathInside(memories, join(memories, 'link.md'))).toBe(false)
    expect(realPathInside(memories, join(memories, 'real.md'))).toBe(true)
  })
})

describe('memoryWriteDenial', () => {
  it('bloqueia escrita direta na pasta de memórias e aponta a ferramenta certa', () => {
    const { memories } = fixture()
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      const denial = memoryWriteDenial(memories, tool, { file_path: join(memories, 'nota.md') })
      expect(denial).toContain('memory_propose')
    }
    expect(memoryWriteDenial(memories, 'Write', { file_path: join(memories, 'sub', 'MEMORY.md') })).toBeTruthy()
    // Caminho relativo é resolvido contra a própria pasta antes de comparar.
    expect(memoryWriteDenial(memories, 'Write', { file_path: 'nota.md' })).toBeTruthy()
    expect(memoryWriteDenial(memories, 'MultiEdit', { edits: [{ file_path: join(memories, 'a.md') }] })).toBeTruthy()
  })

  it('não bloqueia leitura nem escrita fora da pasta', () => {
    const { memories, outside } = fixture()
    expect(memoryWriteDenial(memories, 'Read', { file_path: join(memories, 'nota.md') })).toBeNull()
    expect(memoryWriteDenial(memories, 'Glob', { path: memories })).toBeNull()
    expect(memoryWriteDenial(memories, 'Write', { file_path: join(outside, 'nota.md') })).toBeNull()
    expect(memoryWriteDenial(memories, 'Write', {})).toBeNull()
  })

  it('bloqueia comando de shell que cita a pasta, em qualquer separador ou caixa', () => {
    const { memories, outside } = fixture()
    expect(memoryWriteDenial(memories, 'Bash', { command: `echo x > "${memories}/nota.md"` })).toBeTruthy()
    expect(memoryWriteDenial(memories, 'Bash', { command: `rm ${memories.replace(/\\/g, '/')}/a.md` })).toBeTruthy()
    expect(memoryWriteDenial(memories, 'Bash', { command: `type ${memories.toUpperCase()}\\a.md` })).toBeTruthy()
    expect(memoryWriteDenial(memories, 'Bash', { command: `ls ${outside}` })).toBeNull()
    expect(memoryWriteDenial(memories, 'Bash', {})).toBeNull()
  })
})
