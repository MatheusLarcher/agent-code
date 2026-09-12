// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { activeScopesFor, globToRegExp, writeScopeDenial, type ScopedTask } from './writeScopeGuard'

const CWD = process.platform === 'win32' ? 'C:\\repo' : '/repo'
const inRepo = (rel: string): string => (process.platform === 'win32' ? `${CWD}\\${rel.replace(/\//g, '\\')}` : `${CWD}/${rel}`)
const FUTURE = new Date(Date.now() + 60_000).toISOString()

function task(allow: string[], deny: string[] = [], overrides: Partial<ScopedTask> = {}): ScopedTask {
  return {
    id: 't1',
    title: 'Tarefa',
    projectCwd: CWD,
    writeScope: { allow, deny },
    leaseExpiresAt: FUTURE,
    holder: null,
    ...overrides
  }
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

  it('só olha ferramentas que gravam', () => {
    expect(writeScopeDenial([task(['src/tasks/**'])], 'Read', { file_path: inRepo('src/memory/a.ts') })).toBeNull()
    // Bash entra no gate, mas um comando que não grava nada continua passando.
    expect(writeScopeDenial([task(['src/tasks/**'])], 'Bash', { command: 'echo' })).toBeNull()
    expect(writeScopeDenial([task(['src/tasks/**'])], 'Bash', { command: 'npm test' })).toBeNull()
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

  it('escopo com lease expirado não prende mais ninguém', () => {
    // Um subagente que morre sem transicionar deixaria a sessão restrita para
    // sempre; a posse morta é o que solta o gate.
    const dead = task(['src/tasks/**'], [], { leaseExpiresAt: new Date(Date.now() - 1).toISOString() })
    expect(activeScopesFor([dead], null)).toEqual([])
    expect(writeScopeDenial(activeScopesFor([dead], null), 'Write', { file_path: inRepo('src/outro.ts') })).toBeNull()
    // Ainda vivo, continua recusando.
    expect(activeScopesFor([task(['src/tasks/**'])], null)).toHaveLength(1)
  })

  it('escopo de um subagente não prende o supervisor nem outro subagente', () => {
    const held = task(['src/tasks/**'], [], { holder: 'sub-a' })
    expect(activeScopesFor([held], null)).toEqual([]) // supervisor segue livre
    expect(activeScopesFor([held], 'sub-b')).toEqual([]) // outro executor também
    expect(activeScopesFor([held], 'sub-a')).toHaveLength(1) // o dono, não
  })

  it('escopo do supervisor vale para todo mundo, inclusive subagentes', () => {
    const held = task(['src/tasks/**'], [], { holder: null })
    expect(activeScopesFor([held], null)).toHaveLength(1)
    expect(activeScopesFor([held], 'sub-a')).toHaveLength(1)
  })

  it('NotebookEdit usa notebook_path', () => {
    expect(writeScopeDenial([task(['notebooks/**'])], 'NotebookEdit', { notebook_path: inRepo('src/a.ipynb') })).not.toBeNull()
  })
})

/**
 * O buraco que o gate tinha: o escopo valia para `Write`/`Edit` e o `Bash`
 * gravava em qualquer lugar, com só o hint pedindo para não contornar.
 */
describe('writeScopeDenial com Bash', () => {
  const tasks = [task(['src/tasks/**'])]

  it('grava dentro do escopo: passa', () => {
    expect(writeScopeDenial(tasks, 'Bash', { command: 'echo x > src/tasks/nota.txt' })).toBeNull()
  })

  it('grava fora do escopo: recusa com o caminho e a instrução', () => {
    const denial = writeScopeDenial(tasks, 'Bash', { command: 'echo x > src/memory/nota.txt' })
    expect(denial).toContain('não casa o allow')
    expect(denial).toContain('src/memory/nota.txt')
    expect(denial).toContain('task_event')
  })

  it('basta UM destino fora para o comando inteiro ser recusado', () => {
    const command = 'cp a.ts src/tasks/a.ts && cp b.ts src/renderer/b.ts'
    expect(writeScopeDenial(tasks, 'Bash', { command })).not.toBeNull()
  })

  it('apagar também é gravar', () => {
    expect(writeScopeDenial(tasks, 'Bash', { command: 'rm -rf src/renderer' })).not.toBeNull()
    expect(writeScopeDenial(tasks, 'Bash', { command: 'rm -rf src/tasks/tmp' })).toBeNull()
  })

  it('destino que o scanner não consegue fixar é recusado, com o porquê', () => {
    const denial = writeScopeDenial(tasks, 'Bash', { command: 'echo x > "$DEST/a.txt"' })
    expect(denial).toContain('não dá para conferir o destino')
    expect(denial).toContain('caminho absoluto')
  })

  it('sem tarefa com escopo, Bash segue livre como sempre', () => {
    expect(writeScopeDenial([], 'Bash', { command: 'rm -rf /' })).toBeNull()
  })

  it('gravar fora do projeto da tarefa é recusado', () => {
    const outside = process.platform === 'win32' ? 'D:/outro/a.txt' : '/outro/a.txt'
    expect(writeScopeDenial(tasks, 'Bash', { command: `echo x > ${outside}` })).toContain('fora do projeto')
  })
})
