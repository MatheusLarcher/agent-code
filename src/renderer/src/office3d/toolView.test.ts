import { describe, expect, it } from 'vitest'
import { EMPTY_VIEW, liveView, toolView } from './toolView'

describe('toolView', () => {
  it('Edit vira diff "- / +" com contagem, como o cartão do chat', () => {
    const v = toolView({ id: '1', name: 'Edit', input: { file_path: 'C:\\p\\a.ts', old_string: 'a', new_string: 'b\nc' }, open: true })
    expect(v.kind).toBe('diff')
    expect(v.verb).toBe('Edit')
    expect(v.detail).toBe('a.ts')
    expect(v.language).toBe('diff')
    expect(v.code).toBe('- a\n+ b\n+ c')
    expect(v.stats).toEqual({ added: 2, removed: 1 })
    expect(v.status).toBe('run')
  })

  it('Write com a linguagem pela extensão', () => {
    const v = toolView({ id: '1', name: 'Write', input: { file_path: 'x.tsx', content: 'const a = 1' }, open: true })
    expect(v.language).toBe('typescript')
    expect(v.code).toBe('const a = 1')
  })

  it('Read mostra o conteúdo sem a numeração', () => {
    const v = toolView({ id: '1', name: 'Read', input: { file_path: 'a.py' }, result: '     1→import os\n     2→x = 1', open: false })
    expect(v.code).toBe('import os\nx = 1')
    expect(v.language).toBe('python')
    expect(v.status).toBe('ok')
  })

  it('Bash: comando realçado e saída em "resultado"', () => {
    const v = toolView({ id: '1', name: 'Bash', input: { command: 'npm test', description: 'testes' }, result: 'ok', open: false })
    expect(v.language).toBe('bash')
    expect(v.code).toBe('npm test')
    expect(v.caption).toBe('testes')
    expect(v.result).toBe('ok')
  })

  it('sem ferramenta: vista vazia', () => {
    expect(toolView(null)).toBe(EMPTY_VIEW)
  })
})

describe('liveView', () => {
  it('com trecho antigo é diff; sem, escrita — status ao vivo', () => {
    const base = { kind: 'tool-input-delta' as const, toolUseId: 't', name: 'Edit' as const, filePath: 'a.ts', newText: 'n', totalLines: 1, done: false }
    expect(liveView({ ...base, oldText: 'o' })).toMatchObject({ kind: 'diff', code: '- o\n+ n', status: 'live' })
    expect(liveView(base)).toMatchObject({ kind: 'write', code: 'n', language: 'typescript' })
  })
})
