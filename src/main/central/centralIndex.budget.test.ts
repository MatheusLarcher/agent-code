// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  CENTRAL_STATE_BUDGET_TOKENS,
  MAX_CHOICE_OPTIONS,
  MAX_PROJECTS,
  MAX_PROJECT_CONVERSATIONS,
  buildCentralIndex,
  estimateTokens,
  fitIndexToBudget,
  fitToBudget,
  projectHeaderTokens,
  summaryTokens,
  type CentralConversationSummary,
  type CentralIndex
} from './centralIndex'
import { SANDBOX_ROOT, exists, sbx, sum } from './centralTestKit'

/** Tokens do que vai ao TypeSafe: cabeçalhos + resumos. */
const stateTokens = (index: CentralIndex): number =>
  index.projects.reduce(
    (n, p) => n + projectHeaderTokens(p) + p.conversations.reduce((m, c) => m + summaryTokens(c), 0),
    0
  )

describe('constantes do orçamento', () => {
  it('valores fixados pelo plano', () => {
    expect(CENTRAL_STATE_BUDGET_TOKENS).toBe(24_000)
    expect(MAX_CHOICE_OPTIONS).toBe(255)
    // Uma das 255 opções do choice é reservada para "nova conversa".
    expect(MAX_PROJECT_CONVERSATIONS).toBe(254)
    // ...e, no choice `projeto`, para "sem_projeto".
    expect(MAX_PROJECTS).toBe(254)
  })
})

describe('estimateTokens', () => {
  it('chars / 3,5, arredondado para cima', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('a'.repeat(7))).toBe(2)
    expect(estimateTokens('a'.repeat(8))).toBe(3)
    expect(estimateTokens('a'.repeat(3500))).toBe(1000)
  })

  it('summaryTokens estima o JSON do resumo', () => {
    const s = sum('x', { firstRequest: 'pedido' })
    expect(summaryTokens(s)).toBe(estimateTokens(JSON.stringify(s)))
    expect(summaryTokens(sum('x', { firstRequest: 'a'.repeat(200) }))).toBeGreaterThan(summaryTokens(s))
  })
})

describe('fitToBudget', () => {
  const sizes = (n: number): number => n

  it('fica com os mais recentes (o começo da lista) até o orçamento', () => {
    expect(fitToBudget([10, 20, 30, 40], 60, sizes)).toEqual([10, 20, 30])
    expect(fitToBudget([10, 20, 30, 40], 100, sizes)).toEqual([10, 20, 30, 40])
    expect(fitToBudget([10, 20, 30, 40], 1_000, sizes)).toEqual([10, 20, 30, 40])
  })

  it('o orçamento exato cabe', () => {
    expect(fitToBudget([10, 20, 30], 60, sizes)).toEqual([10, 20, 30])
    expect(fitToBudget([10, 20, 30], 59, sizes)).toEqual([10, 20])
  })

  it('para no primeiro que não cabe: nunca pula um recente para guardar um antigo menor', () => {
    expect(fitToBudget([10, 50, 5, 5], 30, sizes)).toEqual([10])
  })

  it('orçamento zero, negativo ou item maior que tudo: nada', () => {
    expect(fitToBudget([1, 2], 0, sizes)).toEqual([])
    expect(fitToBudget([1, 2], -5, sizes)).toEqual([])
    expect(fitToBudget([100], 99, sizes)).toEqual([])
    expect(fitToBudget([], 100, sizes)).toEqual([])
  })

  it('tamanho inválido (NaN) não deixa passar', () => {
    expect(fitToBudget([1, Number.NaN, 1], 100, sizes)).toEqual([1])
  })

  it('o teto de itens (254 por projeto) vale mesmo com orçamento de sobra', () => {
    const items = Array.from({ length: 300 }, (_, i) => i)
    const cut = fitToBudget(items, Infinity, () => 1, MAX_PROJECT_CONVERSATIONS)
    expect(cut).toHaveLength(254)
    expect(cut[0]).toBe(0)
    expect(cut[253]).toBe(253)
    expect(fitToBudget(items, 10, () => 1, MAX_PROJECT_CONVERSATIONS)).toHaveLength(10)
  })

  it('chama size uma vez por item avaliado e não mexe na lista de entrada', () => {
    const input = [5, 5, 5, 5]
    const probe = vi.fn((n: number) => n)
    const out = fitToBudget(input, 10, probe)
    expect(out).toEqual([5, 5])
    expect(input).toEqual([5, 5, 5, 5])
    expect(out).not.toBe(input)
    expect(probe.mock.calls.length).toBeLessThanOrEqual(3)
  })
})

describe('fitIndexToBudget', () => {
  const mk = (n: number, base: number, over: Partial<CentralConversationSummary> = {}): CentralConversationSummary[] =>
    Array.from({ length: n }, (_, i) => sum(`${over.project ?? 'alpha'}-${i}`, { updatedAt: base - i, ...over }))
  const opts = { sandboxRoot: SANDBOX_ROOT, exists }

  it('índice pequeno cabe no orçamento padrão sem perder nada', () => {
    const index = buildCentralIndex([...mk(3, 100), ...mk(2, 90, { cwd: 'C:\\work\\beta', project: 'beta' })], opts)
    const cut = fitIndexToBudget(index)
    expect(cut.projects.map((p) => p.conversations.length)).toEqual([3, 2])
    expect(cut.byId.size).toBe(5)
  })

  it('corta as conversas mais antigas de todos os projetos primeiro (recência global)', () => {
    const items = [
      ...mk(6, 1000), // alpha: 1000..995
      ...mk(6, 998, { cwd: 'C:\\work\\beta', project: 'beta' }) // beta: 998..993
    ]
    const index = buildCentralIndex(items, opts)
    const headers = index.projects.reduce((n, p) => n + projectHeaderTokens(p), 0)
    const each = summaryTokens(items[0])
    // Cabem exatamente 5 resumos além dos cabeçalhos.
    const cut = fitIndexToBudget(index, headers + each * 5 + 1)
    const kept = [...cut.byId.values()].map((c) => c.updatedAt).sort((a, b) => b - a)
    expect(kept).toEqual([1000, 999, 998, 998, 997])
    expect(cut.projects.map((p) => p.name)).toEqual(['alpha', 'beta'])
    expect(cut.projects[0].conversations.map((c) => c.updatedAt)).toEqual([1000, 999, 998, 997])
    expect(cut.projects[1].conversations.map((c) => c.updatedAt)).toEqual([998])
  })

  it('no máximo 254 conversas por projeto, as mais recentes', () => {
    const index = buildCentralIndex(mk(300, 10_000), opts)
    const cut = fitIndexToBudget(index, 10_000_000)
    expect(cut.projects[0].conversations).toHaveLength(254)
    expect(cut.projects[0].conversations[0].convId).toBe('alpha-0')
    expect(cut.projects[0].conversations[253].convId).toBe('alpha-253')
    expect(cut.byId.size).toBe(254)
  })

  it('o projeto continua na lista (para "nova conversa") mesmo sem conversas no orçamento; byId só tem as mantidas', () => {
    const index = buildCentralIndex([...mk(3, 100), ...mk(2, 50, { cwd: 'C:\\work\\beta', project: 'beta' })], opts)
    // Só os cabeçalhos cabem.
    const cut = fitIndexToBudget(index, index.projects.reduce((n, p) => n + projectHeaderTokens(p), 0))
    expect(cut.projects.map((p) => p.name)).toEqual(['alpha', 'beta'])
    expect(cut.projects.every((p) => p.conversations.length === 0)).toBe(true)
    expect(cut.projects[0].recentTitles).toEqual(index.projects[0].recentTitles)
    expect(cut.byId.size).toBe(0)
  })

  it('byId e as listas dos projetos têm os mesmos objetos; o índice original não muda', () => {
    const index = buildCentralIndex(mk(10, 100), opts)
    const before = JSON.stringify(index.projects)
    const cut = fitIndexToBudget(index, 10_000_000)
    for (const p of cut.projects) for (const c of p.conversations) expect(cut.byId.get(c.convId)).toBe(c)
    expect(JSON.stringify(index.projects)).toBe(before)
    expect(index.byId.size).toBe(10)
  })

  it('o estado cortado cabe no orçamento (cabeçalhos + resumos)', () => {
    const items = [
      ...mk(40, 5000, { firstRequest: 'p'.repeat(200), answerStart: 'r'.repeat(200) }),
      ...mk(40, 4000, { cwd: 'C:\\work\\beta', project: 'beta', firstRequest: 'q'.repeat(200) })
    ]
    const index = buildCentralIndex(items, opts)
    const budget = 3_000
    const cut = fitIndexToBudget(index, budget)
    expect(stateTokens(cut)).toBeLessThanOrEqual(budget)
    expect(cut.byId.size).toBeGreaterThan(0)
    expect(cut.byId.size).toBeLessThan(80)
  })
})

describe('fitIndexToBudget — a lista de projetos', () => {
  const opts = { sandboxRoot: SANDBOX_ROOT, exists }
  /** `count` projetos (p0 o mais recente), `per` conversas cada, títulos de `titleChars` caracteres. */
  const manyProjects = (count: number, per = 1, titleChars = 10): CentralConversationSummary[] =>
    Array.from({ length: count }, (_, p) =>
      Array.from({ length: per }, (_, i) =>
        sum(`p${p}-${i}`, {
          cwd: `C:\\work\\p${p}`,
          project: `p${p}`,
          title: `${p}-${i}-`.padEnd(titleChars, 't'),
          updatedAt: 1_000_000 - p * 100 - i
        })
      )
    ).flat()

  it('no máximo 254 projetos (o choice `projeto` guarda uma opção para sem_projeto): ficam os mais recentes', () => {
    const index = buildCentralIndex(manyProjects(300), opts)
    expect(index.projects).toHaveLength(300)
    const cut = fitIndexToBudget(index, 10_000_000)
    expect(cut.projects).toHaveLength(254)
    expect(cut.projects.length + 1).toBeLessThanOrEqual(MAX_CHOICE_OPTIONS)
    expect(cut.projects.map((p) => p.name)).toEqual(index.projects.slice(0, 254).map((p) => p.name))
    expect(cut.projects[253].name).toBe('p253')
    // As conversas dos projetos cortados saem junto: sem o projeto não há como oferecê-las.
    expect(cut.byId.size).toBe(254)
    expect(cut.byId.has('p253-0')).toBe(true)
    expect(cut.byId.has('p254-0')).toBe(false)
  })

  it('o grupo do sandbox entra na conta dos 254 como qualquer projeto (pela recência)', () => {
    const items = [...manyProjects(254), sbx('s1', 'x1', { updatedAt: 2_000_000 })]
    const cut = fitIndexToBudget(buildCentralIndex(items, opts), 10_000_000)
    expect(cut.projects).toHaveLength(254)
    expect(cut.projects[0]).toMatchObject({ sandbox: true, name: 'sandbox' })
    expect(cut.projects.some((p) => p.name === 'p253')).toBe(false)
  })

  it('os cabeçalhos contam no orçamento: o que não cabe tira os projetos menos recentes (e as conversas deles)', () => {
    const index = buildCentralIndex(manyProjects(10, 2), opts)
    const header = (i: number): number => projectHeaderTokens(index.projects[i])
    const three = header(0) + header(1) + header(2)
    const cut = fitIndexToBudget(index, three)
    expect(cut.projects.map((p) => p.name)).toEqual(['p0', 'p1', 'p2'])
    expect(cut.projects.every((p) => p.conversations.length === 0)).toBe(true)
    expect(cut.byId.size).toBe(0)
    // Um token a menos e o 3º já não cabe.
    expect(fitIndexToBudget(index, three - 1).projects.map((p) => p.name)).toEqual(['p0', 'p1'])
    expect(fitIndexToBudget(index, 0).projects).toEqual([])
  })

  it('as conversas dos projetos cortados não gastam o orçamento das que ficam', () => {
    const items = [
      sum('a-new', { updatedAt: 100 }),
      sum('a-old1', { updatedAt: 10 }),
      sum('a-old2', { updatedAt: 5 }),
      // Projeto menos recente e de cabeçalho grande, com conversas mais novas que as antigas de alpha.
      ...[50, 40, 30, 20, 15].map((at, i) =>
        sum(`b-${i}`, { cwd: 'C:\\work\\beta', project: 'beta', title: 'b'.repeat(200), updatedAt: at })
      )
    ]
    const index = buildCentralIndex(items, opts)
    const [alpha, beta] = index.projects
    const budget = projectHeaderTokens(alpha) + alpha.conversations.reduce((n, c) => n + summaryTokens(c), 0)
    expect(projectHeaderTokens(alpha) + projectHeaderTokens(beta)).toBeGreaterThan(budget)
    const cut = fitIndexToBudget(index, budget)
    expect(cut.projects.map((p) => p.name)).toEqual(['alpha'])
    expect(cut.projects[0].conversations.map((c) => c.convId)).toEqual(['a-new', 'a-old1', 'a-old2'])
  })

  it('o estado cortado cabe no orçamento mesmo quando só os cabeçalhos já passariam dele', () => {
    const index = buildCentralIndex(manyProjects(254, 5, 200), opts)
    expect(index.projects.reduce((n, p) => n + projectHeaderTokens(p), 0)).toBeGreaterThan(CENTRAL_STATE_BUDGET_TOKENS)
    const cut = fitIndexToBudget(index)
    expect(stateTokens(cut)).toBeLessThanOrEqual(CENTRAL_STATE_BUDGET_TOKENS)
    expect(cut.projects.length).toBeGreaterThan(0)
    expect(cut.projects.length).toBeLessThan(254)
    // Ficam os mais recentes, na ordem.
    expect(cut.projects.map((p) => p.cwd)).toEqual(index.projects.slice(0, cut.projects.length).map((p) => p.cwd))
    for (const conversation of cut.byId.values()) {
      expect(cut.projects.some((p) => p.cwd === conversation.cwd)).toBe(true)
    }
  })
})
