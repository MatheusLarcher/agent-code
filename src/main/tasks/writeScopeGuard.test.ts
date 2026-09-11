// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { globToRegExp, writeScopeDenial, type ScopedTask } from './writeScopeGuard'

const CWD = process.platform === 'win32' ? 'C:\\repo' : '/repo'
const inRepo = (rel: string): string => (process.platform === 'win32' ? `${CWD}\\${rel.replace(/\//g, '\\')}` : `${CWD}/${rel}`)

function task(allow: string[], deny: string[] = [], overrides: Partial<ScopedTask> = {}): ScopedTask {
  return { id: 't1', title: 'Tarefa', projectCwd: CWD, writeScope: { allow, deny }, ...overrides }
}

describe('globToRegExp', () => {
  it.each([
    ['src/tasks/**', 'src/tasks/a.ts', true],
    ['src/tasks/**', 'src/tasks/deep/b.ts', true],
    ['src/tasks/**', 'src/memory/a.ts', false],
    ['src/tasks', 'src/tasks/a.ts', true], // pasta nomeada cobre os filhos
    ['*.test.ts', 'src/x/y.test.ts', true], // sem barra = qualquer pasta
    ['*.test.ts', 'src/x/y.ts', false],
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/sub/a.ts', false],
    ['**/*.md', 'README.md', true],
    ['docs/**/*.md', 'docs/a/b/c.md', true]
  ])('%s vs %s → %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected)
  })
})

describe('writeScopeDenial', () => {
  it('sem tarefa com escopo, não interfere', () => {
    expect(writeScopeDenial([], 'Write', { file_path: inRepo('qualquer.ts') })).toBeNull()
    expect(writeScopeDenial([task([], [])], 'Write', { file_path: inRepo('qualquer.ts') })).toBeNull()
  })

  it('só olha ferramentas que gravam arquivo', () => {
    expect(writeScopeDenial([task(['src/tasks/**'])], 'Read', { file_path: inRepo('src/memory/a.ts') })).toBeNull()
    expect(writeScopeDenial([task(['src/tasks/**'])], 'Bash', { command: 'echo' })).toBeNull()
  })

  it('permite dentro do allow e recusa fora, com instrução para o modelo', () => {
    const tasks = [task(['src/tasks/**'])]
    expect(writeScopeDenial(tasks, 'Edit', { file_path: inRepo('src/tasks/taskTools.ts') })).toBeNull()
    const denial = writeScopeDenial(tasks, 'Edit', { file_path: inRepo('src/memory/memoryTools.ts') })
    expect(denial).toContain('não casa o allow')
    expect(denial).toContain('task_event')
  })

  it('deny vence o allow', () => {
    const tasks = [task(['src/**'], ['src/persistence/**'])]
    expect(writeScopeDenial(tasks, 'Write', { file_path: inRepo('src/tasks/a.ts') })).toBeNull()
    expect(writeScopeDenial(tasks, 'Write', { file_path: inRepo('src/persistence/types.ts') })).toContain('deny')
  })

  it('só deny: tudo do projeto menos o deny', () => {
    const tasks = [task([], ['docs/**'])]
    expect(writeScopeDenial(tasks, 'Write', { file_path: inRepo('src/a.ts') })).toBeNull()
    expect(writeScopeDenial(tasks, 'Write', { file_path: inRepo('docs/a.md') })).toContain('deny')
  })

  it('fora do projeto da tarefa é recusado', () => {
    const outside = process.platform === 'win32' ? 'D:\\outro\\a.ts' : '/outro/a.ts'
    expect(writeScopeDenial([task(['**'])], 'Write', { file_path: outside })).toContain('fora do projeto')
  })

  it('caminho relativo é resolvido contra o projeto', () => {
    expect(writeScopeDenial([task(['src/tasks/**'])], 'Write', { file_path: 'src/tasks/novo.ts' })).toBeNull()
    expect(writeScopeDenial([task(['src/tasks/**'])], 'Write', { file_path: 'src/outro.ts' })).not.toBeNull()
  })

  it('basta UMA tarefa ativa autorizar', () => {
    const tasks = [task(['src/tasks/**'], [], { id: 'a', title: 'A' }), task(['docs/**'], [], { id: 'b', title: 'B' })]
    expect(writeScopeDenial(tasks, 'Write', { file_path: inRepo('docs/x.md') })).toBeNull()
    expect(writeScopeDenial(tasks, 'Write', { file_path: inRepo('src/memory/x.ts') })).toContain('A')
  })

  it.runIf(process.platform === 'win32')('no Windows, maiúscula não recusa o arquivo certo', () => {
    expect(writeScopeDenial([task(['src/tasks/**'])], 'Write', { file_path: 'C:\\REPO\\SRC\\Tasks\\A.ts' })).toBeNull()
  })

  it('NotebookEdit usa notebook_path', () => {
    expect(writeScopeDenial([task(['notebooks/**'])], 'NotebookEdit', { notebook_path: inRepo('src/a.ipynb') })).not.toBeNull()
  })
})
