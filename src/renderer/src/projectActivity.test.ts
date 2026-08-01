import { describe, it, expect } from 'vitest'
import {
  ACTION_COLORS,
  actionColor,
  actionKind,
  describeCall,
  editStats,
  fileTouches,
  fileType,
  PRE_TURN,
  toRelative,
  turnsOf
} from './projectActivity'
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

const user = (id: string, text: string): UIMessage => ({ kind: 'user', id, text }) as UIMessage

describe('turno de cada chamada — filtrar o mapa pela mensagem enviada', () => {
  const msgs: UIMessage[] = [
    user('u1', 'arruma o login'),
    toolUse('t1', 'Read', { file_path: `${CWD}\\src\\a.ts` }),
    toolUse('t2', 'Edit', { file_path: `${CWD}\\src\\a.ts`, old_string: 'x', new_string: 'y' }),
    user('u2', 'agora o css'),
    toolUse('t3', 'Edit', { file_path: `${CWD}\\src\\b.css`, old_string: 'x', new_string: 'y' })
  ]

  it('cada chamada leva o id da mensagem que a originou', () => {
    expect(fileTouches(msgs, CWD).map((t) => [t.id, t.turnId])).toEqual([
      ['t1', 'u1'],
      ['t2', 'u1'],
      ['t3', 'u2']
    ])
  })

  it('chamada antes de qualquer mensagem (sessão retomada) cai num turno próprio', () => {
    const t = fileTouches([toolUse('t0', 'Bash', { command: 'ls' }), user('u1', 'oi')], CWD)
    expect(t[0].turnId).toBe(PRE_TURN)
  })

  it('turnsOf resume cada mensagem: nº de chamadas e de arquivos distintos', () => {
    const turns = turnsOf(msgs, fileTouches(msgs, CWD))
    expect(turns).toEqual([
      { id: 'u1', index: 1, label: 'arruma o login', calls: 2, files: 1 },
      { id: 'u2', index: 2, label: 'agora o css', calls: 1, files: 1 }
    ])
  })

  it('mensagem que não gerou nenhuma ação não vira filtro', () => {
    const only = [user('u1', 'oi'), user('u2', 'faz algo'), toolUse('t1', 'Bash', { command: 'ls' })]
    expect(turnsOf(only, fileTouches(only, CWD)).map((t) => t.id)).toEqual(['u2'])
  })

  it('o índice mostrado conta TODAS as mensagens, não só as que agiram', () => {
    const list = [user('u1', 'oi'), user('u2', 'faz algo'), toolUse('t1', 'Bash', { command: 'ls' })]
    expect(turnsOf(list, fileTouches(list, CWD))[0].index).toBe(2)
  })

  it('texto longo vira uma linha cortada', () => {
    const long = user('u1', `${'a'.repeat(200)}\n\nsegunda linha`)
    const list = [long, toolUse('t1', 'Bash', { command: 'ls' })]
    const label = turnsOf(list, fileTouches(list, CWD))[0].label
    expect(label.length).toBe(90)
    expect(label.endsWith('…')).toBe(true)
  })
})

describe('cor por tipo de ação', () => {
  it('cada família tem a sua cor', () => {
    expect(actionColor('Read')).toBe(ACTION_COLORS.read)
    expect(actionColor('Edit')).toBe(ACTION_COLORS.edit)
    expect(actionColor('Write')).toBe(ACTION_COLORS.write)
    expect(actionColor('Bash')).toBe(ACTION_COLORS.run)
    expect(actionColor('Grep')).toBe(ACTION_COLORS.search)
    expect(actionColor('WebFetch')).toBe(ACTION_COLORS.web)
    expect(actionColor('Task')).toBe(ACTION_COLORS.agent)
  })

  it('erro sobrepõe a cor da ferramenta', () => {
    expect(actionColor('Edit', true)).toBe(ACTION_COLORS.error)
  })

  it('ferramenta de MCP cai no genérico, menos a do navegador', () => {
    expect(actionKind('mcp__browser__browser_navigate')).toBe('web')
    expect(actionKind('mcp__android__android_tap')).toBe('other')
    expect(actionKind('FerramentaNova')).toBe('other')
  })
})

describe('fileType — o que o filtro de tipo desliga', () => {
  it('usa a extensão em minúscula', () => {
    expect(fileType('src/App.TSX')).toBe('tsx')
    expect(fileType('C:\\p\\docs\\LEIA.md')).toBe('md')
  })

  it('arquivo sem extensão vira o próprio nome (Dockerfile é um tipo)', () => {
    expect(fileType('build/Dockerfile')).toBe('dockerfile')
    expect(fileType('.gitignore')).toBe('.gitignore')
  })
})
