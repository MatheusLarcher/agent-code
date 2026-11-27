import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  caminhosDoCaso,
  extrasDe,
  lerCasos,
  pontuar,
  resumir,
  resumoMarkdown,
  semConceitosSempre,
  type Caso,
  type Esperado,
  type Execucao
} from './avaliar-escolha-memorias-metricas'

const grupo: Esperado = { umaDe: ['a.md', 'b.md'] }
/** Só precisão e cobertura (a nota e as extras têm testes próprios). */
const pc = (...args: Parameters<typeof pontuar>) => {
  const { precisao, cobertura } = pontuar(...args)
  return { precisao, cobertura }
}

describe('pontuar com grupos umaDe', () => {
  it('um grupo conta como 1 esperado: coberto se qualquer membro foi escolhido', () => {
    expect(pc(['a.md', 'c.md'], [grupo, 'c.md'])).toEqual({ precisao: 1, cobertura: 1 })
    expect(pc(['b.md', 'c.md'], [grupo, 'c.md'])).toEqual({ precisao: 1, cobertura: 1 })
    expect(pc(['c.md'], [grupo, 'c.md'])).toEqual({ precisao: 1, cobertura: 0.5 })
  })

  it('membros extras do mesmo grupo não derrubam a precisão', () => {
    expect(pc(['a.md', 'b.md', 'c.md'], [grupo, 'c.md'])).toEqual({ precisao: 1, cobertura: 1 })
    expect(pc(['a.md', 'b.md'], [grupo, 'c.md'])).toEqual({ precisao: 1, cobertura: 0.5 })
  })

  it('escolha fora de qualquer conceito, sem juiz, é erro', () => {
    expect(pc(['a.md', 'z.md'], [grupo])).toEqual({ precisao: 0.5, cobertura: 1 })
    expect(pc(['a.md', 'b.md', 'z.md'], [grupo])).toEqual({ precisao: 0.5, cobertura: 1 })
  })
})

describe('pontuar com aceitaveis', () => {
  it('aceitável escolhido conta como acerto na precisão, mas não na cobertura', () => {
    expect(pc(['c.md', 'x.md'], ['c.md'], ['x.md'])).toEqual({ precisao: 1, cobertura: 1 })
    expect(pc(['c.md', 'x.md', 'z.md'], ['c.md'], ['x.md'])).toEqual({ precisao: 2 / 3, cobertura: 1 })
  })

  it('só aceitável escolhido: precisão cheia, cobertura zero, nota zero', () => {
    expect(pontuar(['x.md'], ['c.md'], ['x.md'])).toMatchObject({ precisao: 1, cobertura: 0, nota: 0 })
    expect(pontuar(['x.md'], [], ['x.md'])).toMatchObject({ precisao: 1, cobertura: 1, nota: 1 })
  })
})

describe('nota (F1) por pedido', () => {
  it('esperado vazio e nada escolhido = 1; esperado cheio e nada escolhido = 0', () => {
    expect(pontuar([], [])).toMatchObject({ precisao: 1, cobertura: 1, nota: 1 })
    expect(pontuar([], ['a.md'])).toMatchObject({ precisao: null, cobertura: 0, nota: 0 })
  })

  it('é a média harmônica de precisão e cobertura', () => {
    expect(pontuar(['a.md', 'z.md'], ['a.md', 'b.md']).nota).toBeCloseTo(0.5)
    // P = 1, R = 0.5 → 2·1·0.5 / 1.5
    expect(pontuar(['a.md'], ['a.md', 'b.md']).nota).toBeCloseTo(2 / 3)
    expect(pontuar(['z.md'], []).nota).toBe(0)
  })

  it('extra útil vira acerto, neutra fica fora, atrapalha e sem juiz são erro', () => {
    const v = { 'u.md': 'util', 'n.md': 'neutra', 't.md': 'atrapalha' } as const
    expect(pontuar(['a.md', 'u.md'], ['a.md'], [], v)).toMatchObject({ precisao: 1, nota: 1, extras: { util: 1, neutra: 0, atrapalha: 0, semJuiz: 0 } })
    expect(pontuar(['a.md', 'n.md'], ['a.md'], [], v)).toMatchObject({ precisao: 1, nota: 1, extras: { util: 0, neutra: 1, atrapalha: 0, semJuiz: 0 } })
    expect(pontuar(['a.md', 't.md'], ['a.md'], [], v)).toMatchObject({ precisao: 0.5, extras: { util: 0, neutra: 0, atrapalha: 1, semJuiz: 0 } })
    expect(pontuar(['a.md', 's.md'], ['a.md'], [], v)).toMatchObject({ precisao: 0.5, extras: { util: 0, neutra: 0, atrapalha: 0, semJuiz: 1 } })
    expect(pontuar(['a.md', 't.md'], ['a.md'], [], v).nota).toBeCloseTo(2 / 3)
  })

  it('extra útil não cobre esperada que faltou', () => {
    expect(pontuar(['u.md'], ['a.md'], [], { 'u.md': 'util' })).toMatchObject({ precisao: 1, cobertura: 0, nota: 0 })
  })

  it('esperado vazio com só neutras escolhidas continua 1', () => {
    expect(pontuar(['n.md'], [], [], { 'n.md': 'neutra' })).toMatchObject({ precisao: 1, cobertura: 1, nota: 1 })
    expect(pontuar(['t.md'], [], [], { 't.md': 'atrapalha' })).toMatchObject({ precisao: 0, nota: 0 })
  })
})

describe('extrasDe', () => {
  it('tira esperadas, membros de grupo e aceitáveis; sem repetir', () => {
    expect(extrasDe(['a.md', 'b.md', 'c.md', 'x.md', 'z.md', 'z.md', 'y.md'], [grupo, 'c.md'], ['x.md'])).toEqual(['z.md', 'y.md'])
    expect(extrasDe([], ['a.md'])).toEqual([])
  })
})

describe('lerCasos', () => {
  it('aceita umaDe e aceitaveis, normalizando os caminhos', () => {
    const [c] = lerCasos({
      casos: [{ id: 'x', pedido: 'oi', esperadas: ['p\\a.md', { umaDe: ['b.md', './c.md'] }, { umaDe: ['d.md'] }], aceitaveis: ['e.md'] }]
    })
    expect(c.esperadas).toEqual(['p/a.md', { umaDe: ['b.md', 'c.md'] }, 'd.md'])
    expect(c.aceitaveis).toEqual(['e.md'])
  })

  it('formato antigo (só strings, sem aceitaveis) segue valendo', () => {
    const [c] = lerCasos([{ id: 'x', pedido: 'oi', esperadas: ['a.md', 'a.md'] }])
    expect(c.esperadas).toEqual(['a.md'])
    expect(c.aceitaveis).toEqual([])
  })

  it('casos-exemplo.json é válido e só cita memórias fictícias que existem', () => {
    const base = join(dirname(fileURLToPath(import.meta.url)), 'ambiente-memorias')
    const casos = lerCasos(JSON.parse(readFileSync(join(base, 'casos-exemplo.json'), 'utf8')))
    expect(casos.some((c) => c.esperadas.some((e) => typeof e !== 'string') && c.aceitaveis.length > 0)).toBe(true)
    for (const p of casos.flatMap(caminhosDoCaso)) expect(existsSync(join(base, 'memorias-ficticias', p)), p).toBe(true)
  })

  it('recusa grupo vazio, item inválido e caminho em dois lugares', () => {
    const ler = (esperadas: unknown, aceitaveis?: unknown) => () => lerCasos([{ id: 'x', pedido: 'oi', esperadas, aceitaveis }])
    expect(ler([{ umaDe: [] }])).toThrow(/umaDe/)
    expect(ler([{ outra: ['a.md'] }])).toThrow(/esperadas/)
    expect(ler([3])).toThrow(/esperadas/)
    expect(ler(['a.md', { umaDe: ['a.md', 'b.md'] }])).toThrow(/a\.md/)
    expect(ler([{ umaDe: ['a.md', 'b.md'] }, { umaDe: ['b.md', 'c.md'] }])).toThrow(/b\.md/)
    expect(ler(['a.md'], ['a.md'])).toThrow(/a\.md/)
    expect(ler(['a.md'], 'b.md')).toThrow(/aceitaveis/)
  })
})

describe('apoio', () => {
  const caso: Caso = { id: 'x', pedido: 'oi', esperadas: [grupo, 'c.md'], aceitaveis: ['x.md'] }

  it('caminhosDoCaso achata grupos e aceitáveis', () => {
    expect(caminhosDoCaso(caso)).toEqual(['a.md', 'b.md', 'c.md', 'x.md'])
  })

  it('semConceitosSempre tira o conceito inteiro quando um membro é "sempre"', () => {
    expect(semConceitosSempre([grupo, 'c.md'], new Set(['b.md']))).toEqual(['c.md'])
    expect(semConceitosSempre([grupo, 'c.md'], new Set(['c.md']))).toEqual([grupo])
  })

  it('o resumo mostra o grupo e os aceitáveis', () => {
    const md = resumoMarkdown({ quando: 'agora', pasta: 'p', totalMemorias: 3, sempre: [], repeticoes: 1, modelos: {} }, [], [], [caso])
    expect(md).toContain('uma de (`a.md`, `b.md`)')
    expect(md).toContain('Aceitáveis: `x.md`')
  })
})

describe('resumo com nota, extras e custo do juiz à parte', () => {
  const caso: Caso = { id: 'c1', pedido: 'oi', esperadas: ['a.md'], aceitaveis: [] }
  const exec = (over: Partial<Execucao>): Execucao => ({
    caso: 'c1',
    seletor: 'sonnet',
    repeticao: 1,
    ms: 1000,
    falhou: false,
    escolhidas: ['a.md'],
    entregues: ['a.md'],
    precisao: 1,
    cobertura: 1,
    nota: 1,
    extras: { util: 0, neutra: 0, atrapalha: 0, semJuiz: 0 },
    ...over
  })
  const execucoes = [
    exec({ custoUsd: 0.01, caracteres: 300, tokensEntrada: 60_000, msOrdenador: 100, msModelo: 900 }),
    exec({
      repeticao: 2,
      escolhidas: ['a.md', 't.md'],
      precisao: 0.5,
      nota: 2 / 3,
      extras: { util: 0, neutra: 0, atrapalha: 1, semJuiz: 0 },
      vereditos: { 't.md': { veredito: 'atrapalha', motivo: 'outro projeto', doCache: false } },
      custoUsd: 0.02,
      custoJuizUsd: 0.005,
      msJuiz: 2000,
      caracteres: 500,
      tokensEntrada: 50_000,
      msOrdenador: 300,
      msModelo: 700
    }),
    exec({ repeticao: 3, falhou: true, erro: 'tempo', escolhidas: [], entregues: [], precisao: null, cobertura: null, nota: null, custoUsd: 0.03, tokensEntrada: 40_000 })
  ]

  it('resumir: média da nota e das extras só nas válidas; custo do seletor e do juiz separados', () => {
    const [l] = resumir(execucoes, ['sonnet'])
    expect(l.nota).toBeCloseTo(5 / 6)
    expect(l.falhas).toBe(1)
    expect(l.extras).toEqual({ util: 0, neutra: 0, atrapalha: 0.5, semJuiz: 0 })
    expect(l.mediaCaracteres).toBe(400)
    expect(l.custoUsd).toBeCloseTo(0.06)
    expect(l.custoJuizUsd).toBeCloseTo(0.005)
    expect(l.msJuizMediano).toBe(2000)
    // Tokens contam as falhas (o pedido foi pago); tempos do ordenador e do modelo à parte.
    expect(l.tokensEntradaMedio).toBe(50_000)
    expect(l.msOrdenadorMediano).toBe(200)
    expect(l.msModeloMediano).toBe(800)
  })

  it('sem tokens nem ordenador (busca por palavras antiga), as colunas ficam vazias', () => {
    const [l] = resumir([exec({ seletor: 'lexical' })], ['lexical'])
    expect(l.tokensEntradaMedio).toBeNull()
    expect(l.msOrdenadorMediano).toBeNull()
    expect(l.msModeloMediano).toBeNull()
  })

  it('resumoMarkdown mostra nota, extras, caracteres e os dois custos', () => {
    const md = resumoMarkdown(
      { quando: 'agora', pasta: 'p', totalMemorias: 3, sempre: [], repeticoes: 3, modelos: { sonnet: 'claude-sonnet-5-5' }, juiz: 'claude-sonnet-5-5' },
      resumir(execucoes, ['sonnet']),
      execucoes,
      [caso]
    )
    expect(md).toContain('Juiz das extras: claude-sonnet-5-5')
    expect(md).toContain('| Seletor | Nota (F1) | Cobertura |')
    expect(md).toContain('| sonnet | 83% | 100% | 75% | 1.5 | 0.0 | 0.0 | 0.5 | 0.0 | 400 |')
    // Tokens de entrada vêm primeiro (medida principal de custo); US$ depois.
    expect(md).toContain('| Seletor | Tokens de entrada por pedido | Tempo mediano | Faixa | Tempo do ordenador | Tempo do modelo | Custo do seletor (US$) |')
    expect(md).toContain('| sonnet | 50.000 | 1.0 s | 1.0 s – 1.0 s | 200 ms | 0.8 s | US$ 0.0600 | 2.0 s | US$ 0.0050 |')
    expect(md).toContain('Custo do juiz')
  })

  it('sem juiz, o cabeçalho avisa que extras contam como erro', () => {
    const md = resumoMarkdown({ quando: 'agora', pasta: 'p', totalMemorias: 3, sempre: [], repeticoes: 1, modelos: {}, juiz: null }, [], [], [])
    expect(md).toContain('desligado (extras contam como erro)')
  })
})
