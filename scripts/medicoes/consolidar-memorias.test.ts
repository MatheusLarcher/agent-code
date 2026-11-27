import { describe, expect, it } from 'vitest'
import {
  aplicarDecisoes,
  arestasCandidatas,
  caminhoSeguro,
  campo,
  comCamposExtras,
  formarGrupos,
  lerDecisao,
  promptDoGrupo,
  renderRelatorio,
  type Memoria
} from './consolidar-memorias-nucleo'
import { traduzirCaso, traduzirCasos } from './traduzir-casos'

const mem = (caminho: string, corpo: string, criada: string, atualizada = criada, extra = ''): Memoria => ({
  caminho,
  conteudo: `---\nname: ${caminho.replace(/.*\//, '').replace('.md', '')}\ndescription: ${corpo}\nmetadata:\n  type: instrucao\n${extra}---\n# ${corpo}\n\nTexto de ${caminho}.\n`,
  criada,
  atualizada
})

describe('frontmatter', () => {
  it('lê campos de 1º nível e aninhados, sem aspas', () => {
    const c = '---\nname: x\ndescription: "Quando publicar"\nmetadata:\n  type: feedback\n  sempre: true\n---\ncorpo'
    expect(campo(c, 'description')).toBe('Quando publicar')
    expect(campo(c, 'type')).toBe('feedback')
    expect(campo('sem cabeçalho', 'name')).toBe('')
  })

  it('acrescenta só os campos que faltam', () => {
    const c = '---\nname: x\ncreated: 2026-01-01\n---\ncorpo\n'
    const r = comCamposExtras(c, [['created', '2026-05-05'], ['updated', '2026-06-06'], ['supersedes', ['a/b.md']]])
    expect(r).toBe('---\nname: x\ncreated: 2026-01-01\nupdated: 2026-06-06\nsupersedes:\n  - a/b.md\n---\ncorpo\n')
    expect(comCamposExtras('sem cabeçalho', [['updated', '2026-01-01']])).toBe('sem cabeçalho')
  })
})

describe('grupos de candidatas', () => {
  it('liga vizinhos acima do limiar (mais baixo na mesma pasta) e respeita o teto do grupo', () => {
    const v = [
      [1, 0],
      [0.9, Math.sqrt(1 - 0.81)],
      [0.7, Math.sqrt(1 - 0.49)],
      [0, 1]
    ]
    const pastas = ['a', 'a', 'b', 'a']
    const arestas = arestasCandidatas(v, pastas, { vizinhos: 5, limiar: 0.75, limiarPasta: 0.65, maxGrupo: 10 })
    const pares = arestas.map((e) => `${e.a}-${e.b}`).sort()
    // cos: 0-1 = 0.9, 1-2 ≈ 0.94, 0-2 = 0.7 (pastas diferentes: abaixo de 0.75), 2-3 ≈ 0.71
    expect(pares).toEqual(['0-1', '1-2'])
    expect(formarGrupos(4, arestas, 10)).toEqual([[0, 1, 2]])
    // Na mesma pasta, 0.7 passa do limiar de 0.65.
    const mesmaPasta = arestasCandidatas(v, ['a', 'a', 'a', 'x'], { vizinhos: 5, limiar: 0.75, limiarPasta: 0.65, maxGrupo: 10 })
    expect(mesmaPasta.map((e) => `${e.a}-${e.b}`).sort()).toEqual(['0-1', '0-2', '1-2'])
    const corrente = [
      { a: 0, b: 1, cos: 0.95 },
      { a: 1, b: 2, cos: 0.9 },
      { a: 2, b: 3, cos: 0.85 }
    ]
    expect(formarGrupos(4, corrente, 2)).toEqual([[0, 1], [2, 3]])
  })
})

describe('pedido e resposta do modelo', () => {
  it('corta cada memória em 3000 caracteres e marca o texto como dado', () => {
    const grande = { ...mem('a/x.md', 'x', '2026-01-01'), conteudo: 'y'.repeat(5000) }
    const p = promptDoGrupo([grande, mem('a/z.md', 'z', '2026-02-02')])
    expect(p).toContain('M1 · a/x.md · criada 2026-01-01')
    expect(p).toContain('[...cortado]')
    expect(p).not.toContain('y'.repeat(3001))
  })

  it('valida as ações: ids, membros repetidos e tipos', () => {
    const texto = `ok: {"acoes": [
      {"tipo": "fundir", "membros": ["M1", "M2"], "caminho": "r/t.md", "name": "t", "description": "d", "type": "instrucao", "corpo": "# T", "motivo": "iguais"},
      {"tipo": "contradicao", "vale": "M2", "supersedidas": ["M3"]},
      {"tipo": "contradicao", "vale": "M3", "supersedidas": ["M9"]},
      {"tipo": "outra"}
    ]}`
    const d = lerDecisao(texto, 3)
    expect(d?.acoes).toHaveLength(1)
    expect(d?.acoes[0]).toMatchObject({ tipo: 'fundir', membros: [0, 1] })
    expect(d?.avisos).toHaveLength(3)
    expect(lerDecisao('sem json', 2)).toBeNull()
    expect(lerDecisao('{"acoes": []}', 2)?.acoes).toEqual([])
  })

  it('só aceita caminho relativo seguro terminado em .md', () => {
    expect(caminhoSeguro('regras\\testes.md')).toBe('regras/testes.md')
    expect(caminhoSeguro('../fora.md')).toBeNull()
    expect(caminhoSeguro('C:/x.md')).toBeNull()
    expect(caminhoSeguro('/x.md')).toBeNull()
    expect(caminhoSeguro('x.txt')).toBeNull()
    expect(caminhoSeguro('MEMORY.md')).toBeNull()
  })
})

describe('aplicar decisões', () => {
  const a = mem('regras/conferir-testes.md', 'Conferir testes', '2026-01-10', '2026-02-01')
  const b = mem('regras/rodar-testes.md', 'Rodar testes', '2026-03-01', '2026-03-05', '  sempre: true\n')
  const c = mem('regras/commit.md', 'Commit de tudo', '2026-01-01')
  const d = mem('regras/commit-so-meu.md', 'Commit só do meu trabalho', '2026-04-01')
  const e = mem('pessoal/cafe.md', 'Café', '2026-01-01')

  const r = aplicarDecisoes(
    [a, b, c, d, e],
    [
      {
        membros: [a, b],
        acoes: [{ tipo: 'fundir', membros: [0, 1], caminho: 'regras/testes-antes.md', name: 'testes-antes', description: 'Ao entregar: rode os testes', type: 'instrucao', corpo: '# Testes antes', motivo: 'repetidas' }]
      },
      { membros: [c, d], acoes: [{ tipo: 'contradicao', vale: 1, supersedidas: [0], motivo: 'a mais nova vale' }] }
    ]
  )

  it('funde com datas, supersedes e fixação herdada', () => {
    const f = r.arquivos.get('regras/testes-antes.md') ?? ''
    expect(f).toContain('created: 2026-01-10\nupdated: 2026-03-05\nsupersedes:\n  - regras/conferir-testes.md\n  - regras/rodar-testes.md')
    expect(f).toContain('  sempre: true')
    expect(f).toContain('description: "Ao entregar: rode os testes"')
    expect(r.arquivos.has(a.caminho)).toBe(false)
    expect(r.arquivos.has(b.caminho)).toBe(false)
  })

  it('na contradição a velha sai e a que vale ganha supersedes', () => {
    expect(r.arquivos.has(c.caminho)).toBe(false)
    expect(r.arquivos.get(d.caminho)).toContain('supersedes:\n  - regras/commit.md')
    expect(r.contradicoes[0]).toMatchObject({ vale: d.caminho, valeMaisAntiga: false })
  })

  it('o mapa cobre todas as memórias de origem', () => {
    expect(r.mapa).toEqual({
      'regras/conferir-testes.md': 'regras/testes-antes.md',
      'regras/rodar-testes.md': 'regras/testes-antes.md',
      'regras/commit.md': 'regras/commit-so-meu.md',
      'regras/commit-so-meu.md': 'regras/commit-so-meu.md',
      'pessoal/cafe.md': 'pessoal/cafe.md'
    })
    expect(r.arquivos.get(e.caminho)).toContain('created: 2026-01-01\nupdated: 2026-01-01\n---')
    expect(r.arquivos.size).toBe(3)
  })

  it('não deixa uma fusão sobrescrever outra memória', () => {
    const r2 = aplicarDecisoes(
      [a, b, e],
      [{ membros: [a, b], acoes: [{ tipo: 'fundir', membros: [0, 1], caminho: 'pessoal/cafe.md', name: '', description: '', type: '', corpo: '# X', motivo: '' }] }]
    )
    expect(r2.arquivos.get('pessoal/cafe.md')).toBe(comCamposExtras(e.conteudo, [['created', e.criada], ['updated', e.atualizada]]))
    expect(r2.mapa[a.caminho]).toBe('pessoal/cafe-consolidada.md')
    expect(r2.avisos.join(' ')).toContain('já usado')
  })

  it('o relatório traz antes → depois, porcentagem e custo', () => {
    const txt = renderRelatorio({
      origem: 'o',
      saida: 's',
      modelo: 'claude-sonnet-5-5',
      opcoes: { vizinhos: 5, limiar: 0.75, limiarPasta: 0.65, maxGrupo: 10 },
      total: 5,
      grupos: 2,
      memoriasEmGrupos: 4,
      falhas: [],
      custoUsd: 0.0123,
      chamadas: 2,
      doCache: 0,
      segundos: 3,
      resultado: r
    })
    expect(txt).toContain('| Antes | 5 |')
    expect(txt).toContain('| Depois | 3 |')
    expect(txt).toContain('| Saíram | 2 (40.0% do total) |')
    expect(txt).toContain('**Custo total:** US$ 0.0123 nesta rodada')
  })
})

describe('traduzir casos', () => {
  const mapa = {
    'p/instalador.md': 'p/instalador.md',
    'r/conferir.md': 'r/testes.md',
    'r/rodar.md': 'r/testes.md',
    'p/banco.md': 'p/banco.md',
    'r/x.md': 'r/xy.md',
    'r/y.md': 'r/xy.md',
    'r/z.md': 'r/z.md'
  }

  it('grupo que virou uma memória só vira string; esperadas iguais colapsam', () => {
    const c = traduzirCaso({ id: 'a', esperadas: ['p/instalador.md', { umaDe: ['r/conferir.md', 'r/rodar.md'] }], aceitaveis: ['p/banco.md'] }, mapa)
    expect(c).toEqual({ id: 'a', esperadas: ['p/instalador.md', 'r/testes.md'], aceitaveis: ['p/banco.md'] })
    expect(traduzirCaso({ id: 'b', esperadas: ['r/x.md', 'r/y.md'] }, mapa).esperadas).toEqual(['r/xy.md'])
  })

  it('solto dentro de um grupo fica só o solto; aceitável que virou esperada sai', () => {
    const c = traduzirCaso({ id: 'c', esperadas: ['r/x.md', { umaDe: ['r/y.md', 'r/z.md'] }], aceitaveis: ['r/y.md', 'p/banco.md'] }, mapa)
    expect(c).toEqual({ id: 'c', esperadas: ['r/xy.md'], aceitaveis: ['p/banco.md'] })
  })

  it('grupos que se cruzam viram a união, com aviso; caminho fora do mapa fica igual', () => {
    const avisos: string[] = []
    const c = traduzirCaso({ id: 'd', esperadas: [{ umaDe: ['r/x.md', 'p/banco.md'] }, { umaDe: ['r/y.md', 'r/z.md'] }, 'novo.md'] }, mapa, avisos)
    expect(c.esperadas).toEqual([{ umaDe: ['r/xy.md', 'p/banco.md', 'r/z.md'] }, 'novo.md'])
    expect(avisos).toHaveLength(2)
  })

  it('aceita { casos: [...] } e recusa item inválido', () => {
    const r = traduzirCasos({ versao: 1, casos: [{ id: 'e', esperadas: [] }] }, mapa)
    expect(r.dados).toEqual({ versao: 1, casos: [{ id: 'e', esperadas: [] }] })
    expect(() => traduzirCasos({ casos: [{ id: 'f', esperadas: [{ umaDe: [] }] }] }, mapa)).toThrow(/inválido/)
    expect(() => traduzirCasos({ nada: 1 }, mapa)).toThrow()
  })
})
