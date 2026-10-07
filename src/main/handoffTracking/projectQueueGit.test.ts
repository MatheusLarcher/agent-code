// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatConversationHistory, HISTORY_MAX_CHARS } from './conversationHistory'
import { changedBetween, createProjectGit, porcelainPath } from './projectQueueGit'

/**
 * O git da fila do projeto (sem rodar git: o runner é simulado) e o histórico
 * exportado para o PO.
 */

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('porcelainPath e changedBetween', () => {
  it('o caminho de cada linha do --porcelain (renomeado: o destino; com aspas: decodificado)', () => {
    expect(porcelainPath(' M src/App.tsx')).toBe('src/App.tsx')
    expect(porcelainPath('?? docs/novo.md')).toBe('docs/novo.md')
    expect(porcelainPath('R  velho.ts -> novo.ts')).toBe('novo.ts')
    expect(porcelainPath('?? "com espa\\303\\247o.md"')).toBe('com espaço.md')
  })

  it('mudou = novo, sumido ou com mtime/tamanho diferente', () => {
    const before = new Map([['a.ts', ' M|1|10'], ['b.ts', ' M|1|10'], ['c.ts', '??|1|1']])
    const after = new Map([['a.ts', ' M|1|10'], ['b.ts', ' M|2|11'], ['d.ts', '??|3|3']])
    expect(changedBetween(before, after)).toEqual(['b.ts', 'c.ts', 'd.ts'])
  })
})

describe('createProjectGit', () => {
  it('a pasta suja e a foto com mtime; sem git (ou fora de repositório) devolve null', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-code-git-'))
    dirs.push(dir)
    await writeFile(join(dir, 'a.ts'), 'x')
    const git = createProjectGit(async (_cwd, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n'
      if (args[0] === 'rev-parse') return 'abc123\n'
      if (args[0] === 'status') return ' M a.ts\n?? sumiu.ts\n'
      throw new Error('inesperado')
    })
    expect(await git.dirty(dir)).toEqual(['a.ts', 'sumiu.ts'])
    expect(await git.head(dir)).toBe('abc123')
    const snapshot = await git.snapshot(dir)
    expect(snapshot?.get('a.ts')).toMatch(/^ M\|\d+(\.\d+)?\|1$/)
    expect(snapshot?.get('sumiu.ts')).toBe('??|sumiu')

    const noRepo = createProjectGit(async () => 'false\n')
    expect(await noRepo.dirty(dir)).toBeNull()
    const broken = createProjectGit(async () => {
      throw new Error('git não instalado')
    })
    expect(await broken.dirty(dir)).toBeNull()
    expect(await broken.head(dir)).toBeNull()
  })
})

describe('formatConversationHistory', () => {
  it('o trilho principal: usuário, agente, ferramentas, erros e fins de turno — sem subagentes', () => {
    const text = formatConversationHistory({
      title: 'Implementação: Plano A',
      messages: [
        { kind: 'user', text: 'Prompt 1' },
        { kind: 'assistant-text', text: 'Vou começar.' },
        { kind: 'tool-use', name: 'Bash', input: { command: 'npm test' }, parentToolUseId: null },
        { kind: 'tool-use', name: 'Read', input: { file: 'x' }, parentToolUseId: 'task-1' },
        { kind: 'tool-result', isError: true, text: 'falhou o teste' },
        { kind: 'result', isError: false, text: 'ok' },
        { kind: 'error', text: 'limite de uso' }
      ]
    })
    expect(text).toContain('# Implementação: Plano A')
    expect(text).toContain('## Usuário\nPrompt 1')
    expect(text).toContain('## Agente\nVou começar.')
    expect(text).toContain('- ferramenta Bash: {"command":"npm test"}')
    expect(text).not.toContain('ferramenta Read')
    expect(text).toContain('- erro da ferramenta: falhou o teste')
    expect(text).toContain('--- fim do turno ---')
    expect(text).toContain('## Erro\nlimite de uso')
    expect(formatConversationHistory(null)).toBe('')
  })

  it('comprido demais: fica o FIM (é onde está o porquê da parada)', () => {
    const messages = Array.from({ length: 3_000 }, (_, i) => ({ kind: 'assistant-text', text: `${i} ${'x'.repeat(200)}` }))
    messages.push({ kind: 'assistant-text', text: 'PAREI AQUI' })
    const text = formatConversationHistory({ messages })
    expect(text.length).toBeLessThan(HISTORY_MAX_CHARS + 200)
    expect(text.startsWith('(o começo foi cortado')).toBe(true)
    expect(text.endsWith('PAREI AQUI\n')).toBe(true)
  })
})
