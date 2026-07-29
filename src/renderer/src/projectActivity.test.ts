import { describe, it, expect } from 'vitest'
import { describeCall, editStats, fileTouches, toRelative } from './projectActivity'
import type { UIMessage } from './types'

const CWD = 'C:\\Users\\Matheus\\Documents\\GitHub\\agent-code'

function toolUse(id: string, name: string, input: unknown, result?: { isError: boolean; text: string }): UIMessage {
  return { kind: 'tool-use', id, name, input, parentToolUseId: null, ...(result ? { result } : {}) } as UIMessage
}

describe('toRelative — casar o caminho do agente com o da árvore', () => {
  it('corta o cwd e normaliza a barra do Windows', () => {
    expect(toRelative(`${CWD}\\src\\main\\index.ts`, CWD)).toBe('src/main/index.ts')
  })

  it('ignora diferença de maiúscula (caminho do Windows não diferencia)', () => {
    expect(toRelative(`c:\\users\\matheus\\documents\\github\\agent-code\\src\\App.tsx`, CWD)).toBe(
      'src/App.tsx'
    )
  })

  it('caminho já relativo passa direto', () => {
    expect(toRelative('src/shared/ipc.ts', CWD)).toBe('src/shared/ipc.ts')
    expect(toRelative('./docs/ARQUITETURA.md', CWD)).toBe('docs/ARQUITETURA.md')
  })

  it('arquivo fora do projeto continua absoluto (o grafo só não acha nó)', () => {
    expect(toRelative('C:\\Windows\\system32\\drivers\\etc\\hosts', CWD)).toBe(
      'C:/Windows/system32/drivers/etc/hosts'
    )
  })
})

describe('describeCall — o texto do balãozinho por ferramenta', () => {
  it('Edit mostra só o arquivo — a contagem sai à parte, pra ser colorida', () => {
    expect(describeCall('Edit', { file_path: 'a/MEMORY.md', old_string: 'x', new_string: 'y\nz' })).toBe(
      'MEMORY.md'
    )
  })

  it('Bash mostra o comando', () => {
    expect(describeCall('Bash', { command: 'npx vitest run' })).toBe('npx vitest run')
  })

  it('Grep mostra o padrão, Glob idem, WebSearch a query', () => {
    expect(describeCall('Grep', { pattern: 'tool-use' })).toBe('tool-use')
    expect(describeCall('Glob', { pattern: '**/*.tsx' })).toBe('**/*.tsx')
    expect(describeCall('WebSearch', { query: 'kimi k3' })).toBe('kimi k3')
  })

  it('Read parcial avisa que é trecho', () => {
    expect(describeCall('Read', { file_path: 'x/big.ts', offset: 10, limit: 20 })).toBe('big.ts (trecho)')
    expect(describeCall('Read', { file_path: 'x/big.ts' })).toBe('big.ts')
  })

  it('ferramenta desconhecida ainda tira algo legível do input', () => {
    expect(describeCall('FerramentaNova', { command: 'algo' })).toBe('algo')
    expect(describeCall('FerramentaNova', {})).toBe('')
  })
})

describe('editStats — o +N/−M que o balão pinta como no chat', () => {
  it('conta as linhas dos dois lados', () => {
    expect(editStats({ old_string: 'x', new_string: 'y\nz' })).toEqual({ added: 2, removed: 1 })
  })

  it('inserção pura tem 0 removidas (e o balão nem desenha o zero)', () => {
    expect(editStats({ old_string: '', new_string: 'nova' })).toEqual({ added: 1, removed: 0 })
  })

  it('sem os campos de Edit, não há contagem', () => {
    expect(editStats({ command: 'ls' })).toBeNull()
    expect(editStats(undefined)).toBeNull()
  })
})

describe('fileTouches — ler as MESMAS mensagens do chat', () => {
  it('Edit leva os números junto do toque, prontos pra colorir', () => {
    const t = fileTouches(
      [toolUse('t1', 'Edit', { file_path: `${CWD}\\a.ts`, old_string: 'x', new_string: 'y\nz' })],
      CWD
    )[0]
    expect(t.detail).toBe('a.ts')
    expect([t.added, t.removed]).toEqual([2, 1])
  })

  it('ferramenta que não é Edit não carrega contagem nenhuma', () => {
    const t = fileTouches([toolUse('t1', 'Bash', { command: 'ls' })], CWD)[0]
    expect(t.added).toBeUndefined()
    expect(t.removed).toBeUndefined()
  })

  it('resolve cada tool-use num ponto da árvore, na ordem', () => {
    const msgs: UIMessage[] = [
      { kind: 'user', id: 'u1', text: 'oi' } as UIMessage,
      toolUse('t1', 'Read', { file_path: `${CWD}\\src\\shared\\ipc.ts` }),
      toolUse('t2', 'Edit', { file_path: `${CWD}\\src\\App.tsx`, old_string: 'a', new_string: 'b' })
    ]
    const touches = fileTouches(msgs, CWD)
    expect(touches.map((t) => [t.tool, t.path])).toEqual([
      ['Read', 'src/shared/ipc.ts'],
      ['Edit', 'src/App.tsx']
    ])
  })

  it('chamada sem arquivo (Bash puro) fica sem caminho — vai pra raiz no grafo', () => {
    const touches = fileTouches([toolUse('t1', 'Bash', { command: 'ls' })], CWD)
    expect(touches[0].path).toBeNull()
    expect(touches[0].detail).toBe('ls')
  })

  it('Grep com pasta usa a pasta como alvo', () => {
    const touches = fileTouches([toolUse('t1', 'Grep', { pattern: 'x', path: 'src/main' })], CWD)
    expect(touches[0].path).toBe('src/main')
  })

  it('erro da chamada chega marcado', () => {
    const touches = fileTouches(
      [toolUse('t1', 'Bash', { command: 'falha' }, { isError: true, text: 'boom' })],
      CWD
    )
    expect(touches[0].isError).toBe(true)
  })

  it('mensagens que não são tool-use são ignoradas', () => {
    const msgs = [
      { kind: 'user', id: 'u1', text: 'oi' },
      { kind: 'assistant-text', id: 'a1', text: 'ok' }
    ] as UIMessage[]
    expect(fileTouches(msgs, CWD)).toEqual([])
  })
})
