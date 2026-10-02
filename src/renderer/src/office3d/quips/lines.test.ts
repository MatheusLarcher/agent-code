import { describe, expect, it } from 'vitest'
import {
  bashFlavor,
  browserAction,
  clipPath,
  clipText,
  clockTime,
  duration,
  extLabel,
  fill,
  QUIP_MAX,
  shortenPaths,
  tidyError,
  toolLabel,
  whoLabel,
  type SlotName
} from './format'
import { LINES, type Situation } from './lines'

const SLOT = /\{(\w+)\}/g
const KNOWN = new Set<string>(['text', 'file', 'diff', 'ext', 'pattern', 'dir', 'cmd', 'q', 'host', 'action', 'who', 'desc', 'tool', 'what', 'err', 'n', 's', 'total', 'more', 'pct', 'dur', 'time', 'ago'])
const slotsOf = (template: string): string[] => [...template.matchAll(SLOT)].map((m) => m[1])
const situations = Object.keys(LINES) as Situation[]

/** O dado que a situação mostra em TODA variação. */
const DATA: Partial<Record<Situation, SlotName>> = {
  request: 'text', edit: 'file', write: 'file', read: 'file', search: 'pattern',
  'bash-test': 'cmd', 'bash-install': 'cmd', 'bash-build': 'cmd', 'bash-check': 'cmd', 'bash-git': 'cmd', 'bash-serve': 'cmd', 'bash-run': 'cmd',
  'web-search': 'q', 'web-fetch': 'host', 'web-browse': 'action', task: 'who', delegate: 'who', other: 'tool',
  'perm-cmd': 'cmd', 'perm-file': 'file', 'perm-question': 'q', 'perm-tool': 'tool', error: 'err',
  'done-files': 'n', 'done-file': 'file', 'done-cmds': 'cmd', 'done-chat': 'text', 'test-pass': 'n', 'test-fail': 'n',
  'return-ok': 'who', 'return-fail': 'who', 'context-low': 'pct', stalled: 'dur', 'stalled-cmd': 'dur', 'usage-time': 'time',
  think: 'text', idle: 'ago', 'perm-done': 'what'
}
/** Sem dado variável por natureza: o próprio fato é a informação. */
const NO_DATA = new Set<Situation>(['bash-peek', 'test-none', 'usage-notime', 'usage-back', 'speak-on', 'speak-off', 'thought'])

// Valores enormes, para provar que tudo cabe em 72 sem perder o dado.
const HUGE: Record<SlotName, string | number> = {
  text: 'Refatora o fluxo inteiro de autenticação do aplicativo e cobre tudo com testes de ponta a ponta',
  file: 'useAuthenticationProviderWithRefresh.test.tsx',
  diff: '+120 −87',
  ext: 'TSX',
  pattern: 'export function useAuthenticationProviderWithRefresh',
  dir: 'authentication-providers-legacy',
  cmd: 'npx vitest run C:\\GitHub\\agent-code\\src\\renderer\\src\\office3d\\quips --reporter=verbose --coverage',
  q: 'Prefere manter a API antiga em paralelo durante a migração ou cortar tudo de uma vez?',
  host: 'developer.mozilla.org.very-long-subdomain.example.com',
  action: 'preenchendo formulário de cadastro completo',
  who: 'navegador de código',
  desc: 'revisar o checkout inteiro e apontar cada regressão de desempenho',
  tool: 'super_long_tool_name_used_only_in_tests',
  what: 'npm run build && node scripts/build-installer.mjs --sign',
  err: "ENOENT: no such file or directory, open 'C:\\GitHub\\agent-code\\config.json'",
  n: 1234, s: 's', total: 5678, more: 12, pct: 15, dur: '1 h 5 min', time: '05/10 23:40', ago: '3 dias'
}

describe('lines: a biblioteca de falas', () => {
  it('toda situação tem ícone e ≥ 4 variações; pensamentos ≥ 15', () => {
    for (const sit of situations) {
      expect(LINES[sit].icon, sit).not.toBe('')
      expect(LINES[sit].lines.length, sit).toBeGreaterThanOrEqual(4)
      expect(new Set(LINES[sit].lines).size, `${sit} sem repetidas`).toBe(LINES[sit].lines.length)
    }
    expect(LINES.thought.lines.length).toBeGreaterThanOrEqual(15)
  })

  it('moldes só usam slots conhecidos, {s} nunca é opcional e toda variação traz o dado da situação', () => {
    for (const sit of situations) {
      for (const line of LINES[sit].lines) {
        for (const slot of slotsOf(line)) expect(KNOWN.has(slot), `${sit}: {${slot}}`).toBe(true)
        for (const opt of line.match(/\[[^\]]*\]/g) ?? []) expect(opt, `${sit}: {s} opcional`).not.toContain('{s}')
        const data = DATA[sit]
        if (data) expect(slotsOf(line), `${sit}: "${line}" sem {${data}}`).toContain(data)
        else expect(NO_DATA.has(sit), `${sit} sem dado declarado`).toBe(true)
      }
    }
  })

  it('com dados enormes, toda fala cabe em 72 e mantém um pedaço reconhecível de cada dado', () => {
    for (const sit of situations) {
      for (const line of LINES[sit].lines) {
        const out = fill(line, HUGE)
        expect(out.length, `${sit}: ${out}`).toBeLessThanOrEqual(QUIP_MAX)
        expect(out, `${sit}: slot sem preencher`).not.toMatch(/\{\w+\}|\[|\]/)
        for (const slot of slotsOf(line) as SlotName[]) {
          const v = String(HUGE[slot])
          // Comando com caminho absoluto encolhe para o nome do último segmento.
          const piece = slot === 'cmd' ? 'npx vitest' : slot === 'err' ? 'ENOENT' : v.slice(0, 6)
          expect(out, `${sit}: perdeu {${slot}} em "${out}"`).toContain(piece)
        }
      }
    }
  })
})

describe('format: preencher e cortar', () => {
  it('fill: opcional some sem o dado, aparece com ele; plural pelo {s}', () => {
    expect(fill("Matutando[ sobre '{text}']… 🤔", { text: '' })).toBe('Matutando… 🤔')
    expect(fill("Matutando[ sobre '{text}']… 🤔", { text: 'arruma o login' })).toBe("Matutando sobre 'arruma o login'… 🤔")
    expect(fill('Mexendo no {file}[ ({diff})]. Respira, {ext}.', { file: 'card.css', diff: '+6 −4', ext: 'CSS' })).toBe('Mexendo no card.css (+6 −4). Respira, CSS.')
    expect(fill('{n} teste{s} verde{s}!', { n: 1, s: '' })).toBe('1 teste verde!')
    expect(fill('{n} teste{s} verde{s}!', { n: 42, s: 's' })).toBe('42 testes verdes!')
  })

  it('fill: corta o dado mais comprido, nunca o número, e não parte emoji', () => {
    const out = fill("Opa, pedido novo: '{text}' — bora! {n}", { text: 'palavra '.repeat(30), n: 123456 })
    expect(out.length).toBeLessThanOrEqual(QUIP_MAX)
    expect(out).toMatch(/…' — bora! 123456$/)
    const emoji = fill('{text} 🎉', { text: '😀'.repeat(60) }, 21)
    expect(emoji.length).toBeLessThanOrEqual(21)
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  it('clipPath guarda a extensão; clipText corta na palavra e encurta caminhos antes', () => {
    const p = clipPath('useAuthenticationProviderWithRefresh.test.tsx', 24)
    expect(p.length).toBeLessThanOrEqual(24)
    expect(p).toMatch(/^useAuth.*….test\.tsx$/)
    expect(clipPath('C:\\proj\\src\\very\\deep\\folder\\file.ts', 12)).toBe('file.ts')
    expect(clipText('corrige o bug em C:\\GitHub\\agent-code\\src\\renderer\\src\\App.tsx agora', 40)).toBe('corrige o bug em App.tsx agora')
    const long = 'Refatora o carrinho de compras e cobre tudo com teste'
    expect(clipText(long, 30)).toBe('Refatora o carrinho de…')
    expect(clipText(long, 31)).toBe('Refatora o carrinho de compras…')
    expect(clipText('supercalifragilisticexpialidocious demais', 12)).toBe('supercalifr…')
  })

  it('shortenPaths e tidyError: caminho vira nome do arquivo, erro vira código + arquivo', () => {
    expect(shortenPaths('node C:\\GitHub\\agent-code\\scripts\\build.mjs --x')).toBe('node build.mjs --x')
    expect(shortenPaths('cat ./a.txt https://x.dev/a/b/c')).toBe('cat ./a.txt https://x.dev/a/b/c')
    expect(tidyError("Error: ENOENT: no such file or directory, open 'C:\\proj\\config.json'")).toBe('ENOENT config.json')
    expect(tidyError('TypeError: x is not a function')).toBe('TypeError: x is not a function')
    expect(tidyError('falhou ao ler /home/me/proj/src/app.ts')).toBe('falhou ao ler app.ts')
  })

  it('duração, hora do reset, extensão, tipo de comando e nomes', () => {
    expect([45_000, 4 * 60_000, 65 * 60_000, 2 * 3_600_000, 3 * 86_400_000].map(duration)).toEqual(['45 s', '4 min', '1 h 5 min', '2 h', '3 dias'])
    const now = new Date(2026, 9, 2, 14, 0).getTime()
    expect(clockTime(new Date(2026, 9, 2, 23, 40).getTime(), now)).toBe('23:40')
    expect(clockTime(new Date(2026, 9, 5, 9, 5).getTime(), now)).toBe('05/10 09:05')
    expect([extLabel('card.css'), extLabel('Dockerfile'), extLabel('a.test.tsx')]).toEqual(['CSS', 'Dockerfile', 'TSX'])
    const flavors = ['npm test', 'npx vitest run', 'npm install', 'npm i -D x', 'npm run build', 'npm run typecheck', 'git commit -m "fix test"', 'npm run dev', 'ls -la']
    expect(flavors.map(bashFlavor)).toEqual(['test', 'test', 'install', 'install', 'build', 'check', 'git', 'serve', 'run'])
    expect([browserAction('mcp__browser__browser_click'), browserAction('mcp__chrome__chrome_navigate'), browserAction('mcp__browser__browser_zoom_in')]).toEqual([
      'clicando',
      'abrindo página',
      'zoom in'
    ])
    expect([toolLabel('mcp__tasks__task_claim'), toolLabel('TodoWrite')]).toEqual(['task_claim', 'TodoWrite'])
    expect([whoLabel('critico'), whoLabel('general-purpose'), whoLabel('Custom'), whoLabel('')]).toEqual(['crítico', 'faz-tudo', 'Custom', 'subagente'])
  })
})
