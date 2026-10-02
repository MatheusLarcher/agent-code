import { describe, expect, it } from 'vitest'
import type { CentralActivity } from '@shared/central'
import { summarizeActivity, type ToolCallLike } from './activitySummary'

type Res = ToolCallLike['result']
const OK: Res = { isError: false, text: 'ok' }
const ERR: Res = { isError: true, text: 'falhou' }

/** Uma chamada já respondida (ou com o resultado dado). */
const call = (name: string, input: unknown, result: Res = OK): ToolCallLike => ({ name, input, result })
/** Uma chamada ainda sem resultado: a ação em curso. */
const open = (name: string, input: unknown): ToolCallLike => ({ name, input })

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `linha ${i}`).join('\n')
const read = (file: string, result?: Res): ToolCallLike => call('Read', { file_path: `C:\\proj\\src\\${file}` }, result)
const write = (file: string, result?: Res): ToolCallLike => call('Write', { file_path: `C:\\proj\\src\\${file}`, content: lines(30) }, result)
const grep = (pattern: string, result?: Res): ToolCallLike => call('Grep', { pattern, path: 'src/' }, result)
const bash = (command: string, result?: Res): ToolCallLike => call('Bash', { command }, result)
const edit = (file: string, added: number, removed: number, result?: Res): ToolCallLike =>
  call('Edit', { file_path: `C:\\proj\\src\\${file}`, old_string: lines(removed), new_string: lines(added) }, result)

const sum = (tools: ToolCallLike[], running = false, maxChars?: number): CentralActivity =>
  summarizeActivity(tools, { running, ...(maxChars === undefined ? {} : { maxChars }) })
/** O que a tela mostra, sem os tons. */
const shown = (a: CentralActivity): string => a.segments.map((s) => s.text).join('')
const toned = (a: CentralActivity): Array<[string, string | undefined]> =>
  a.segments.filter((s) => s.tone).map((s) => [s.text, s.tone])

/** A lista de 6 cartões do mockup (o exemplo aberto do gerar_darj). */
const MOCKUP_TOOLS = (): ToolCallLike[] => [
  grep('cnpj'), read('filtros.js'), edit('filtros.js', 6, 2), bash('npm test -- filtros'), read('filtros.test.js'), bash('npm run lint')
]

describe('summarizeActivity — a tabela de verbos (ação pronta)', () => {
  const rows: Array<[string, ToolCallLike[], string]> = [
    ['Read', [read('auth.ts')], 'Leu auth.ts'],
    ['WebFetch (o host)', [call('WebFetch', { url: 'https://docs.anthropic.com/en/docs/x?y=1' })], 'Leu docs.anthropic.com'],
    ['Edit', [edit('filtros.js', 6, 2)], 'Editou filtros.js +6 −2'],
    [
      'MultiEdit (soma as edições)',
      [call('MultiEdit', { file_path: 'src/a.ts', edits: [{ old_string: 'a', new_string: lines(2) }, { old_string: lines(2), new_string: 'b' }] })],
      'Editou a.ts +3 −3'
    ],
    ['NotebookEdit', [call('NotebookEdit', { notebook_path: 'C:\\nb\\analise.ipynb', new_source: lines(3) })], 'Editou analise.ipynb +3'],
    ['Write (sem contagem de linhas)', [write('novo.ts')], 'Criou novo.ts'],
    ['Grep', [grep('cnpj')], 'Procurou "cnpj"'],
    ['Glob', [call('Glob', { pattern: '**/*.ts' })], 'Procurou "**/*.ts"'],
    ['Bash de teste', [bash('npm test')], 'Rodou os testes ✓'],
    ['Bash de build', [bash('npm run build')], 'Rodou o build ✓'],
    ['Bash comum', [bash('git status')], 'Rodou git status'],
    ['WebSearch', [call('WebSearch', { query: 'cotação do dólar hoje' })], 'Pesquisou "cotação do dólar hoje" na web'],
    ['navegador embutido', [call('mcp__browser__browser_navigate', { url: 'http://localhost' })], 'Testou no navegador'],
    ['Task', [call('Task', { description: 'x', prompt: 'y' })], 'Chamou um subagente'],
    ['Agent', [call('Agent', { description: 'x', prompt: 'y' })], 'Chamou um subagente'],
    ['outra ferramenta (o verbo do describeTool)', [call('Skill', { skill: 'brainstorming' })], 'Usou Skill'],
    ['outra ferramenta MCP (sem o prefixo mcp__<servidor>__)', [call('mcp__memory__memory_list', {})], 'Usou memory_list']
  ]

  it.each(rows)('%s', (_label, tools, text) => {
    const a = sum(tools)
    expect(a.text).toBe(text)
    expect(shown(a)).toBe(text)
    expect(a.count).toBe(1)
    expect(a.errors).toBe(0)
    expect(a.now).toBeUndefined()
  })
})

describe('summarizeActivity — a ação em curso ("agora")', () => {
  const rows: Array<[string, ToolCallLike, string]> = [
    ['Read', open('Read', { file_path: 'C:\\p\\auth.ts' }), 'lendo auth.ts…'],
    ['WebFetch', open('WebFetch', { url: 'https://docs.anthropic.com/x' }), 'lendo docs.anthropic.com…'],
    ['Edit', open('Edit', { file_path: 'src/filtros.js', old_string: 'a', new_string: 'b' }), 'editando filtros.js…'],
    ['MultiEdit', open('MultiEdit', { file_path: 'src/a.ts', edits: [] }), 'editando a.ts…'],
    ['NotebookEdit', open('NotebookEdit', { notebook_path: 'nb/analise.ipynb', new_source: 'x' }), 'editando analise.ipynb…'],
    ['Write', open('Write', { file_path: 'src/novo.ts', content: 'x' }), 'criando novo.ts…'],
    ['Grep', open('Grep', { pattern: 'cnpj' }), 'procurando "cnpj"…'],
    ['Glob', open('Glob', { pattern: '**/*.ts' }), 'procurando "**/*.ts"…'],
    ['Bash de teste', open('Bash', { command: 'npm test' }), 'rodando os testes…'],
    ['Bash de build', open('Bash', { command: 'npm run build' }), 'rodando o build…'],
    ['Bash comum', open('Bash', { command: 'git status' }), 'rodando git status…'],
    ['WebSearch (um só "…")', open('WebSearch', { query: 'dólar' }), 'pesquisando…'],
    ['navegador embutido', open('mcp__browser__browser_click', {}), 'testando no navegador…'],
    ['Task', open('Task', {}), 'subagente trabalhando…'],
    ['Agent', open('Agent', {}), 'subagente trabalhando…'],
    ['outra ferramenta', open('Skill', { skill: 'x' }), 'usando Skill…']
  ]

  it.each(rows)('%s', (_label, tool, now) => {
    const a = sum([tool], true)
    expect(a.now).toBe(now)
    expect(a.now?.endsWith('…')).toBe(true)
    // A ação em curso não entra no resumo do que já foi feito.
    expect(a.text).toBe('')
    expect(a.segments).toEqual([])
    expect(a.count).toBe(1)
  })

  it('só a última ação SEM resultado é o "agora"; as outras seguem no resumo', () => {
    const a = sum([read('a.ts'), open('Read', { file_path: 'b.ts' }), read('c.ts')], true)
    expect(a.now).toBe('lendo b.ts…')
    expect(a.text).toBe('Leu 2 arquivos')
    expect(sum([open('Read', { file_path: 'a.ts' }), open('Edit', { file_path: 'b.ts' })], true)).toMatchObject({ now: 'editando b.ts…', text: 'Leu a.ts' })
  })

  it('o exemplo do mockup: "Leu 3 arquivos" + agora "lendo auth.ts…"', () => {
    const a = sum([read('a.ts'), read('b.ts'), read('c.ts'), open('Read', { file_path: 'C:\\proj\\src\\auth.ts' })], true)
    expect(a).toMatchObject({ text: 'Leu 3 arquivos', now: 'lendo auth.ts…', count: 4 })
  })

  it('turno parado (running: false): sem "agora", e a ação sem resultado entra no resumo sem marca', () => {
    const a = sum([read('a.ts'), open('Read', { file_path: 'b.ts' })], false)
    expect(a.now).toBeUndefined()
    expect(a.text).toBe('Leu 2 arquivos')
    expect(sum([open('Bash', { command: 'npm test' })]).text).toBe('Rodou os testes')
  })

  it('rodando mas a última ação já tem resultado: não há "agora"', () => {
    const a = sum([read('a.ts'), edit('b.ts', 1, 0)], true)
    expect(a.now).toBeUndefined()
    expect(a.text).toBe('Leu a.ts · editou b.ts +1')
  })

  it('sem nenhuma ação: linha vazia, mesmo rodando', () => {
    expect(sum([], true)).toEqual({ segments: [], text: '', count: 0, errors: 0 })
  })
})

describe('summarizeActivity — junção de ações seguidas do mesmo tipo', () => {
  it('leituras seguidas: "Leu 3 arquivos"', () => {
    expect(sum([read('a.ts'), read('b.ts'), read('c.ts')]).text).toBe('Leu 3 arquivos')
    expect(sum([read('a.ts'), call('WebFetch', { url: 'https://x.dev/a' })]).text).toBe('Leu 2 arquivos')
  })

  it('comandos seguidos: "Rodou 2 comandos"', () => {
    expect(sum([bash('git status'), bash('ls -la')]).text).toBe('Rodou 2 comandos')
  })

  it('outras junções seguidas', () => {
    expect(sum([grep('a'), grep('b')]).text).toBe('Fez 2 buscas')
    expect(sum([call('WebSearch', { query: 'a' }), call('WebSearch', { query: 'b' })]).text).toBe('Fez 2 pesquisas na web')
    expect(sum([call('mcp__browser__a', {}), call('mcp__browser__b', {}), call('mcp__browser__c', {})]).text).toBe('Testou no navegador')
    expect(sum([call('Task', {}), call('Agent', {})]).text).toBe('Chamou 2 subagentes')
    expect(sum([call('Skill', { skill: 'a' }), call('mcp__x__y', {}), call('Skill', { skill: 'b' })]).text).toBe('Usou 3 ferramentas')
  })

  it('só junta o que é seguido: outra ação no meio separa os grupos, em ordem cronológica', () => {
    expect(sum([read('a.ts'), edit('x.js', 1, 0), read('b.ts')]).text).toBe('Leu a.ts · editou x.js +1 · leu b.ts')
  })

  it('ferramenta de plano no meio não conta nem separa', () => {
    expect(sum([read('a.ts'), call('TodoWrite', { todos: [] }), call('TaskUpdate', {}), read('b.ts')])).toMatchObject({ text: 'Leu 2 arquivos', count: 2 })
  })

  it('teste e build ficam em grupos próprios (um não engole o outro)', () => {
    expect(sum([bash('npm test'), bash('npm run build'), bash('git status')]).text).toBe('Rodou os testes ✓ · rodou o build ✓ · rodou git status')
  })
})

describe('summarizeActivity — edições e criações sempre aparecem', () => {
  it('edições repetidas do mesmo arquivo somam o +a −r', () => {
    expect(sum([edit('f.ts', 2, 1), edit('f.ts', 3, 0)]).text).toBe('Editou f.ts +5 −1')
  })

  it('dois arquivos: os dois nomes, cada um com a sua soma', () => {
    expect(sum([edit('a.ts', 2, 1), edit('b.ts', 1, 0), edit('a.ts', 3, 0)]).text).toBe('Editou a.ts +5 −1 e b.ts +1')
  })

  it('mais de dois arquivos: dois nomes e "e mais N"', () => {
    expect(sum([edit('a.ts', 1, 0), edit('b.ts', 1, 0), edit('c.ts', 1, 0), edit('d.ts', 1, 0)])).toMatchObject({ text: 'Editou a.ts +1, b.ts +1 e mais 2', count: 4 })
  })

  it('criações seguem a mesma regra, sem contagem de linhas', () => {
    expect(sum([write('a.ts'), write('b.ts')]).text).toBe('Criou a.ts e b.ts')
    expect(sum([write('a.ts'), write('b.ts'), write('c.ts')]).text).toBe('Criou a.ts, b.ts e mais 1')
  })

  it('zero linhas não aparecem (+0 / −0 nunca)', () => {
    expect(sum([edit('a.ts', 0, 3)]).text).toBe('Editou a.ts −3')
    expect(sum([edit('a.ts', 0, 0)]).text).toBe('Editou a.ts')
  })

  it('edições de arquivos não seguidos ficam em grupos separados', () => {
    expect(sum([edit('a.ts', 1, 0), bash('git status'), edit('a.ts', 2, 0)]).text).toBe('Editou a.ts +1 · rodou git status · editou a.ts +2')
  })
})

describe('summarizeActivity — teste e build mostram o resultado', () => {
  const TESTS = [
    'npm test', 'npm run test', 'vitest', 'jest', 'pytest', 'go test', 'cargo test', 'dotnet test', 'mvn test', 'gradle test', 'pnpm test', 'yarn test',
    // variações do dia a dia
    'npx vitest run src/a.test.ts', 'cd /c/proj && npm test -- filtros', 'npm run test:unit', 'python -m pytest -q', 'go test ./...',
    './gradlew test', 'FOO=1 npm test 2>&1 | tail -20', 'npm run typecheck && npm test'
  ]
  const BUILDS = [
    'npm run build', 'npm run typecheck', 'tsc', 'vite build', 'electron-vite build', 'cargo build', 'go build', 'dotnet build', 'pnpm build',
    'yarn build', 'mvn package', 'gradle build',
    'npx tsc --noEmit -p tsconfig.web.json', 'cd /c/proj && npm run build 2>&1 | tail -5'
  ]

  it.each(TESTS)('é teste: %s', (command) => {
    expect(sum([bash(command)]).text).toBe('Rodou os testes ✓')
    expect(sum([open('Bash', { command })], true).now).toBe('rodando os testes…')
  })

  it.each(BUILDS)('é build: %s', (command) => {
    expect(sum([bash(command)]).text).toBe('Rodou o build ✓')
    expect(sum([open('Bash', { command })], true).now).toBe('rodando o build…')
  })

  it.each([
    ['cat vitest.config.ts', 'Rodou cat'], ['grep -rn vitest src', 'Rodou grep'],
    ['git commit -m "npm test passa"', 'Rodou git commit'], ['echo "npm run build"', 'Rodou echo'],
    ["cat > ci.sh <<'EOF'\nnpm test\nEOF", 'Rodou cat'] // corpo de heredoc é texto, não comando
  ])('não é teste nem build (só cita): %j', (command, text) => {
    expect(sum([bash(command)]).text).toBe(text)
  })

  it('✓ quando há resultado e não falhou; ✗ quando falhou; sem resultado, sem marca', () => {
    expect(sum([bash('npm test', OK)]).text).toBe('Rodou os testes ✓')
    expect(sum([bash('npm test', ERR)]).text).toBe('Rodou os testes ✗ · 1 erro')
    expect(sum([bash('npm run build', ERR)]).text).toBe('Rodou o build ✗ · 1 erro')
    expect(sum([open('Bash', { command: 'npm test' })]).text).toBe('Rodou os testes')
  })

  it('o ✓ e o ✗ levam o tom certo', () => {
    expect(toned(sum([bash('npm test')]))).toEqual([['✓', 'ok']])
    expect(toned(sum([bash('npm test', ERR)]))).toEqual([['✗', 'bad'], ['· 1 erro', 'bad']])
  })

  it('testes seguidos viram um só; basta um falhar para o ✗', () => {
    expect(sum([bash('npm test'), bash('vitest run')]).text).toBe('Rodou os testes ✓')
    expect(sum([bash('npm test'), bash('vitest run')]).count).toBe(2)
    expect(sum([bash('npm test', ERR), bash('vitest run')]).text).toBe('Rodou os testes ✗ · 1 erro')
  })

  it('PowerShell se comporta como o Bash (mesma entrada `command`)', () => {
    expect(sum([call('PowerShell', { command: 'npm test' })]).text).toBe('Rodou os testes ✓')
    expect(sum([call('PowerShell', { command: 'Get-ChildItem -Recurse src | Select-Object -First 3' })]).text).toBe('Rodou Get-ChildItem')
  })
})

describe('summarizeActivity — erros', () => {
  it('conta as ações com erro e acrescenta "· N erro(s)" em tom bad', () => {
    const one = sum([read('a.ts', ERR), edit('b.ts', 1, 0)])
    expect(one.errors).toBe(1)
    expect(one.text).toBe('Leu a.ts · editou b.ts +1 · 1 erro')
    expect(one.segments.at(-1)).toEqual({ text: '· 1 erro', tone: 'bad' })

    const many = sum([read('a.ts', ERR), edit('b.ts', 1, 0, ERR), bash('npm test', ERR)])
    expect(many.errors).toBe(3)
    expect(many.text.endsWith('· 3 erros')).toBe(true)
  })

  it('sem erro, sem o segmento', () => {
    const a = sum([read('a.ts'), bash('npm test')])
    expect(a.errors).toBe(0)
    expect(a.text).not.toMatch(/erro/)
  })

  it('a resposta do AskUserQuestion (volta como is_error) não é erro — e a ferramenta é ignorada', () => {
    expect(sum([call('AskUserQuestion', { questions: [] }, ERR), read('a.ts')])).toMatchObject({ errors: 0, count: 1, text: 'Leu a.ts' })
  })

  it('a ação em curso não conta como erro', () => {
    expect(sum([read('a.ts'), open('Read', { file_path: 'b.ts' })], true).errors).toBe(0)
  })
})

describe('summarizeActivity — contagem e ferramentas de plano', () => {
  it('count = ações contadas; TodoWrite/TaskCreate/TaskUpdate/AskUserQuestion não aparecem nem contam', () => {
    const a = sum([
      call('TodoWrite', { todos: [] }), read('a.ts'), call('TaskCreate', { subject: 'x' }), edit('b.ts', 1, 0),
      call('TaskUpdate', { taskId: '1', status: 'completed' }), call('AskUserQuestion', { questions: [] }), bash('npm test')
    ])
    expect(a.count).toBe(3)
    expect(a.text).toBe('Leu a.ts · editou b.ts +1 · rodou os testes ✓')
  })

  it('só ferramentas de plano: linha vazia e count 0', () => {
    const a = sum([call('TodoWrite', {}), call('TaskCreate', {}), call('TaskUpdate', {}), call('AskUserQuestion', {})], true)
    expect(a).toEqual({ segments: [], text: '', count: 0, errors: 0 })
  })

  it('bastidor também não conta: TaskList, TaskGet, ToolSearch e o registro de tarefas do app (mcp__tasks__*)', () => {
    const noise = [call('TaskList', {}), call('ToolSearch', { query: 'select:Read' }), call('mcp__tasks__task_create', { title: 'x' }, ERR), call('TaskGet', { taskId: '1' })]
    const a = sum([noise[0], read('a.ts'), noise[1], noise[2], edit('b.ts', 1, 0), noise[3], open('mcp__tasks__task_transition', {})], true)
    expect(a).toEqual(sum([read('a.ts'), edit('b.ts', 1, 0)], true))
    expect(a).toMatchObject({ text: 'Leu a.ts · editou b.ts +1', count: 2, errors: 0 })
    // Ignorada pendente nunca vira o "agora", nem esconde a ação contada que está em curso.
    expect(a.now).toBeUndefined()
    expect(sum([open('Read', { file_path: 'c.ts' }), open('TaskGet', {}), open('mcp__tasks__task_get', {})], true).now).toBe('lendo c.ts…')
  })

  it('a ação em curso entra no count', () => {
    expect(sum([read('a.ts'), open('Read', { file_path: 'b.ts' })], true).count).toBe(2)
  })
})

describe('summarizeActivity — o comando nunca vai inteiro', () => {
  it.each([
    ['git log --oneline --graph --decorate -n 20 -- src/renderer/src/central/ | head -50', 'Rodou git log'],
    ['git status', 'Rodou git status'],
    ['npm install', 'Rodou npm install'],
    ['ls -la /um/caminho/qualquer', 'Rodou ls'],
    ['cd /c/proj && ls -la src', 'Rodou ls'],
    ['FOO=bar node scripts/run.mjs --flag', 'Rodou node'],
    ['C:\\Tools\\bin\\mytool.exe --x', 'Rodou mytool'],
    ['/usr/local/bin/rg --files', 'Rodou rg'],
    ['echo "oi" > out.txt', 'Rodou echo'],
    ['cat <<\'EOF\' > x.sh\necho hi\nEOF', 'Rodou cat'],
    ['git add -A\ngit commit -m "msg longa"', 'Rodou git add'],
    ['# só um comentário\nls', 'Rodou ls'],
    ['$(which node) --version', 'Rodou um comando'],
    ['"C:\\Program Files\\x\\y.exe" --z', 'Rodou um comando'],
    ['   ', 'Rodou um comando']
  ])('%j → %s', (command, text) => {
    expect(sum([bash(command)]).text).toBe(text)
  })

  it('nada de flag, aspas, caminho nem segredo na linha', () => {
    const a = sum([bash('curl -s -H "Authorization: Bearer sk-segredo" https://api.exemplo.com/v1/x | jq .')])
    expect(a.text).toBe('Rodou curl')
    expect(a.text).not.toMatch(/segredo|Authorization|https|\||-s/)
  })

  it('comando e termo de busca cortam em 24 caracteres com "…"', () => {
    const long = 'docker-compose-super-long-name subcommandwordthatisverylong'
    const cmd = sum([bash(long)]).text.slice('Rodou '.length)
    expect(cmd.length).toBeLessThanOrEqual(24)
    expect(cmd.endsWith('…')).toBe(true)
    // No "agora", o alvo já cortado não ganha um segundo "…".
    expect(sum([open('Bash', { command: long })], true).now).toBe(`rodando ${cmd}`)

    const term = sum([grep('function\\s+\\w+HandlerParaUmNomeMuitoLongo')]).text
    expect(term).toBe('Procurou "function\\s+\\w+HandlerPa…"')
    expect(term.slice('Procurou "'.length, -1).length).toBe(24)

    expect(sum([call('WebSearch', { query: 'a'.repeat(60) })]).text).toBe(`Pesquisou "${'a'.repeat(23)}…" na web`)
  })

  it('termo com aspas ou quebras de linha vira uma linha só, sem aspas duplas dentro', () => {
    expect(sum([grep('"use client"\nx')]).text).toBe('Procurou "\'use client\' x"')
  })

  it('nunca o conteúdo do arquivo: Write e Edit mostram só o nome', () => {
    const a = sum([call('Write', { file_path: 'src/segredo.env', content: 'SENHA=123' }), call('Edit', { file_path: 'x.ts', old_string: 'SENHA=1', new_string: 'SENHA=2' })])
    expect(a.text).not.toMatch(/SENHA|=123/)
  })
})

describe('summarizeActivity — tons dos segmentos', () => {
  it('nome em strong, +a add, −r rem, ✓ ok; e as pontas coladas ficam num segmento só', () => {
    const a = sum([grep('cnpj'), edit('filtros.js', 6, 2), bash('npm test')])
    expect(a.segments).toEqual([
      { text: 'Procurou "cnpj" · editou ' }, { text: 'filtros.js', tone: 'strong' }, { text: ' ' }, { text: '+6', tone: 'add' },
      { text: ' ' }, { text: '−2', tone: 'rem' }, { text: ' · rodou os testes ' }, { text: '✓', tone: 'ok' }
    ])
  })

  it('arquivo lido e criado também ficam em strong', () => {
    expect(toned(sum([read('auth.ts')]))).toEqual([['auth.ts', 'strong']])
    expect(toned(sum([write('a.ts'), write('b.ts'), write('c.ts')]))).toEqual([['a.ts', 'strong'], ['b.ts', 'strong']])
  })
})

describe('summarizeActivity — o corte em 110 caracteres', () => {
  it('o exemplo do mockup, com a conta fechada (6 ações, 116 caracteres: passa de 110)', () => {
    const a = sum(MOCKUP_TOOLS())
    expect(a.count).toBe(6)
    expect(a.errors).toBe(0)
    // text = a linha INTEIRA, na ordem, sem colapsar.
    expect(a.text).toBe('Procurou "cnpj" · leu filtros.js · editou filtros.js +6 −2 · rodou os testes ✓ · leu filtros.test.js · rodou npm run')
    expect(a.text.length).toBe(116)
    // Na tela: leituras e buscas viram contagens e vão para o FIM; a edição segue inteira.
    expect(shown(a)).toBe('Editou filtros.js +6 −2 · rodou os testes ✓ · rodou npm run · leu 2 arquivos · fez 1 busca')
  })

  it('a linha que cabe em maxChars não colapsa; um caractere a menos colapsa', () => {
    const full = sum(MOCKUP_TOOLS(), false, 1000)
    expect(shown(full)).toBe(full.text)
    expect(shown(sum(MOCKUP_TOOLS(), false, full.text.length))).toBe(full.text)
    const tight = sum(MOCKUP_TOOLS(), false, full.text.length - 1)
    expect(shown(tight)).not.toBe(full.text)
    expect(shown(tight).endsWith('fez 1 busca')).toBe(true)
    expect(tight.text).toBe(full.text)
  })

  it('o padrão é 110', () => {
    expect(sum(MOCKUP_TOOLS())).toEqual(sum(MOCKUP_TOOLS(), false, 110))
    expect(shown(sum(MOCKUP_TOOLS(), false, 116))).toBe(sum(MOCKUP_TOOLS()).text)
  })

  it('no colapso, leituras e buscas vão para o fim (leituras primeiro) e continuam contando tudo', () => {
    const tools = [read('a.ts'), grep('x'), edit('f.ts', 1, 0), read('b.ts'), bash('npm test')]
    const full = sum(tools, false, 1000)
    expect(full.text).toBe('Leu a.ts · procurou "x" · editou f.ts +1 · leu b.ts · rodou os testes ✓')
    const a = sum(tools, false, 70)
    expect(shown(a)).toBe('Editou f.ts +1 · rodou os testes ✓ · leu 2 arquivos · fez 1 busca')
    expect(a.text).toBe(full.text)
    expect(a.count).toBe(5)
  })

  it('no colapso uma leitura só vira "leu 1 arquivo" e várias buscas, "fez N buscas"', () => {
    const tools = [read('a.ts'), grep('x'), edit('f.ts', 1, 0), grep('y'), bash('npm test')]
    expect(shown(sum(tools, false, 70))).toBe('Editou f.ts +1 · rodou os testes ✓ · leu 1 arquivo · fez 2 buscas')
  })

  it('no colapso, o que ficou vizinho sem as leituras se junta de novo', () => {
    const tools = [edit('a.ts', 1, 0), read('x.ts'), edit('b.ts', 1, 0)]
    expect(sum(tools, false, 1000).text).toBe('Editou a.ts +1 · leu x.ts · editou b.ts +1')
    expect(shown(sum(tools, false, 41))).toBe('Editou a.ts +1 e b.ts +1 · leu 1 arquivo')
  })

  it('pesquisa na web não é "busca": fica no lugar no colapso', () => {
    const tools = [call('WebSearch', { query: 'dólar' }), grep('x'), edit('f.ts', 1, 0)]
    expect(sum(tools, false, 1000).text).toBe('Pesquisou "dólar" na web · procurou "x" · editou f.ts +1')
    expect(shown(sum(tools, false, 55))).toBe('Pesquisou "dólar" na web · editou f.ts +1 · fez 1 busca')
  })

  it('ainda comprido depois do colapso: corta em maxChars com "…", e text segue inteiro', () => {
    const tools = [edit('filtros.js', 6, 2), bash('npm test'), bash('npm run build')]
    const full = sum(tools, false, 1000)
    expect(full.text).toBe('Editou filtros.js +6 −2 · rodou os testes ✓ · rodou o build ✓')
    const a = sum(tools, false, 40)
    expect(shown(a)).toBe('Editou filtros.js +6 −2 · rodou os test…')
    expect(shown(a).length).toBe(40)
    expect(a.text).toBe(full.text)
  })

  it('o corte não deixa separador pendurado antes do "…"', () => {
    const tools = [edit('filtros.js', 6, 2), bash('npm test')]
    // "Editou filtros.js +6 −2" tem 23 caracteres; com 27 sobra só " · " + o "…".
    const a = sum(tools, false, 27)
    expect(shown(a)).toBe('Editou filtros.js +6 −2…')
    expect(shown(a).length).toBeLessThanOrEqual(27)
  })

  it('com o padrão de 110, uma linha de ações que não colapsam é cortada e é prefixo do text', () => {
    const tools = [bash('git status'), edit('a.ts', 1, 0), bash('git diff'), edit('b.ts', 1, 0), bash('ls'), write('c.ts'), bash('pwd'), edit('d.ts', 1, 0), call('Task', {})]
    const a = sum(tools)
    expect(a.text.length).toBeGreaterThan(110)
    expect(shown(a).length).toBeLessThanOrEqual(110)
    expect(shown(a).endsWith('…')).toBe(true)
    expect(a.text.startsWith(shown(a).slice(0, -1))).toBe(true)
  })

  it('o erro continua visível quando o resto é cortado', () => {
    const a = sum([edit('filtros.js', 6, 2), bash('npm test', ERR)], false, 40)
    expect(shown(a)).toBe('Editou filtros.js +6 −2 · rodo… · 1 erro')
    expect(shown(a).length).toBe(40)
    expect(a.segments.at(-1)).toEqual({ text: '· 1 erro', tone: 'bad' })
    expect(a.errors).toBe(1)
    expect(a.text).toBe('Editou filtros.js +6 −2 · rodou os testes ✗ · 1 erro')
  })

  it('a linha sempre começa com maiúscula, inclusive colapsada ou cortada', () => {
    for (const max of [1000, 70, 40, 12]) {
      const a = sum([grep('x'), edit('filtros.js', 6, 2), bash('npm test')], false, max)
      expect(shown(a)).toMatch(/^[A-ZÀ-Ý]/)
    }
    expect(sum([read('a.ts')]).text).toBe('Leu a.ts')
  })

  it('maxChars minúsculo não quebra', () => {
    expect(shown(sum([edit('a.ts', 1, 0)], false, 1))).toBe('…')
    expect(shown(sum([edit('a.ts', 1, 0)], false, 0)).length).toBeLessThanOrEqual(110)
  })
})

describe('summarizeActivity — o exemplo do mockup, em 6 ações', () => {
  it('"Procurou "cnpj" · editou filtros.js +6 −2 · rodou os testes ✓" com 6 ações', () => {
    // Uma busca, três edições do mesmo arquivo (+3 −1, +2 −1, +1) e duas rodadas de teste seguidas.
    const a = sum([
      grep('cnpj'), edit('filtros.js', 3, 1), edit('filtros.js', 2, 1), edit('filtros.js', 1, 0), bash('npm test -- filtros'), bash('npm test')
    ])
    expect(a).toMatchObject({ text: 'Procurou "cnpj" · editou filtros.js +6 −2 · rodou os testes ✓', count: 6, errors: 0 })
    expect(shown(a)).toBe(a.text)
    expect(a.now).toBeUndefined()
  })
})

describe('summarizeActivity — entradas estranhas', () => {
  it('input nulo, ausente ou de tipo errado não quebra', () => {
    const a = sum([
      { name: 'Read', input: null }, { name: 'Bash', input: undefined }, { name: 'Grep', input: 'texto' }, { name: 'Edit', input: { file_path: 42 } },
      { name: 'WebFetch', input: { url: 'não é url' } }, { name: 'WebSearch', input: {} }, { name: 'Skill', input: [] }
    ])
    expect(a.count).toBe(7)
    // Sem alvo legível, cada verbo cai na forma genérica (nunca "undefined" nem aspas vazias).
    expect(a.text).toBe('Leu um arquivo · rodou um comando · fez uma busca · editou um arquivo · leu uma página · pesquisou na web · usou Skill')
  })

  it('resultado null conta como "sem resultado"', () => {
    const a = summarizeActivity([{ name: 'Bash', input: { command: 'npm test' }, result: null }], { running: true })
    expect(a.now).toBe('rodando os testes…')
  })
})
