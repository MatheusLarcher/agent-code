// @vitest-environment node
// Busca nova de memórias (spec 2026-11-26 §6) sobre o acervo de MENTIRA do repositório
// (scripts/medicoes/ambiente-memorias/memorias-ficticias). O "sentido" aqui é de mentira e
// determinístico (palavras em comum), para o teste não baixar o modelo nem variar.
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import Graph from 'graphology'
import { listMemoryFiles } from '../../memoryIndex'
import { buscarMemorias, type EstadoConversa } from './busca'
import { fichaDe, lerFichas, nivelPorData, TEMA_GERAL } from './fichas'
import { pagerankPersonalizado } from './grafo'
import { prepararBusca } from './preparar'
import { normalizarTermo } from './catalogo'

const ACERVO = path.resolve(__dirname, '../../../../scripts/medicoes/ambiente-memorias/memorias-ficticias')
const HOJE = Date.parse('2026-11-26T12:00:00Z')
const DIM = 256

/** Sentido de mentira: saco de palavras com hash, normalizado. */
async function embedFalso(textos: string[]): Promise<number[][]> {
  return textos.map((t) => {
    const v = new Array<number>(DIM).fill(0)
    for (const w of normalizarTermo(t).split(/[^a-z0-9]+/).filter((x) => x.length > 3)) {
      let h = 0
      for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0
      v[h % DIM] += 1
    }
    const n = Math.hypot(...v) || 1
    return v.map((x) => x / n)
  })
}

const preparar = (bibliotecario = true) =>
  prepararBusca(ACERVO, { hoje: HOJE, embed: embedFalso, bibliotecario: bibliotecario ? { pastasGenericas: ['projetos'] } : false })

describe('fichas (D42/D43)', () => {
  const fichas = lerFichas(ACERVO, listMemoryFiles(ACERVO), HOJE)
  const ficha = (id: string) => fichas.find((f) => f.id === id)!

  it('tema: cabeçalho > pasta > geral; nível pela data mais recente; observação pelo cabeçalho', () => {
    expect(ficha('padaria/fonte-titulos.md')).toMatchObject({ tema: 'padaria', temaDeclarado: true })
    expect(ficha('projetos/site-padaria-cores.md')).toMatchObject({ tema: 'projetos', temaDeclarado: false })
    expect(ficha('horta-notificacoes-rega.md')).toMatchObject({ tema: TEMA_GERAL, nivel: 'fast' })
    expect(ficha('horta/observacao-usuarios-idosos.md').nivel).toBe('observacao')
    expect(ficha('regras/responder-curto.md').sempre).toBe(true)
  })

  it('nível por regra: 1 / 7 / 60 dias; sem data = longo', () => {
    const dia = 86_400_000
    expect(nivelPorData(HOJE - dia / 2, HOJE)).toBe('fast')
    expect(nivelPorData(HOJE - 5 * dia, HOJE)).toBe('curto')
    expect(nivelPorData(HOJE - 30 * dia, HOJE)).toBe('medio')
    expect(nivelPorData(HOJE - 90 * dia, HOJE)).toBe('longo')
    expect(nivelPorData(null, HOJE)).toBe('longo')
  })

  it('datas do banco valem antes das do arquivo (D42)', () => {
    const f = fichaDe({ relPath: 'x.md', folders: [], title: 't', hook: 'g' }, '---\ncriada: 2020-01-01\n---\ncorpo', HOJE, { modificadaEm: HOJE })
    expect(f.nivel).toBe('fast')
  })

  it('layout novo: lê gatilhos (lista em bloco) e termos (lista numa linha) do cabeçalho', () => {
    const conteudo = '---\nname: x\ntema: padaria\ngatilhos:\n  - "q hrs abre domingo"\n  - "horario da padaria"\ntermos: ["Pão Quente","7h"]\n---\ncorpo'
    const f = fichaDe({ relPath: 'x.md', folders: [], title: 't', hook: 'g' }, conteudo, HOJE)
    expect(f.gatilhos).toEqual(['q hrs abre domingo', 'horario da padaria'])
    expect(f.termos).toEqual(['Pão Quente', '7h'])
    expect(f.tema).toBe('padaria')
  })

  it('segredo não vai para o texto da ficha (D45)', () => {
    const f = fichaDe({ relPath: 's.md', folders: [], title: 't', hook: 'g' }, '---\nname: s\n---\nsenha {{secret:vpn}}\npassword: hunter2-de-verdade', HOJE)
    expect(f.texto).not.toContain('hunter2-de-verdade')
    expect(f.texto).not.toContain('{{secret:vpn}}')
  })
})

describe('bibliotecário — 1ª passada (simulação)', () => {
  it('põe as soltas de projeto no tema certo e deixa as gerais em geral', async () => {
    const { sugestoes } = await preparar()
    const para = (id: string) => sugestoes.find((s) => s.id === id)?.para
    expect(para('horta-notificacoes-rega.md')).toBe('horta')
    expect(para('padaria-horario-funcionamento.md')).toBe('padaria')
    expect(para('idioma-portugues.md')).toBeNull()
    expect(para('sem-emoji.md')).toBeNull()
    // Memória com `tema:` declarado nunca é mexida.
    expect(sugestoes.some((s) => s.id === 'padaria/fonte-titulos.md')).toBe(false)
  })
})

describe('busca (etapas 0–5)', () => {
  it('acha a memória solta depois da arrumação, no tema certo', async () => {
    const { ctx } = await preparar()
    const r = await buscarMemorias('o aviso de rega do Horta Fácil parou de chegar', ctx, { tema: null })
    expect(r.tema).toBe('horta')
    expect(r.escolhidas).toContain('horta-notificacoes-rega.md')
    expect(r.escolhidas).toContain('regras/responder-curto.md') // `sempre`
    expect(r.escolhidas.length).toBeLessThanOrEqual(8)
  })

  it('observação do tema entra direto', async () => {
    const { ctx } = await preparar()
    const r = await buscarMemorias('cria uma tela nova no Horta Fácil para cadastrar canteiro', ctx, { tema: null })
    expect(r.comoEntrou['horta/observacao-usuarios-idosos.md']).toBe('direto')
  })

  it('cumprimento não traz memória de projeto (só as `sempre`)', async () => {
    const { ctx } = await preparar()
    const r = await buscarMemorias('bom dia!', ctx, { tema: null })
    expect(r.escolhidas.filter((id) => r.comoEntrou[id] !== 'sempre')).toEqual([])
  })

  it('a conversa emenda no tema; troca só com assunto claramente outro', async () => {
    const { ctx } = await preparar()
    const estado: EstadoConversa = { tema: null }
    await buscarMemorias('o login com Google do app da horta dá erro 10', ctx, estado)
    expect(estado.tema).toBe('horta')
    await buscarMemorias('e o que mais falta?', ctx, estado)
    expect(estado.tema).toBe('horta')
    await buscarMemorias('muda a fonte dos títulos do site da Padaria Pão Quente', ctx, estado)
    expect(estado.tema).toBe('padaria')
  })

  it('contradição declarada entra em par; aposentada fica fora', async () => {
    const base = await prepararBusca(ACERVO, {
      hoje: HOJE,
      embed: embedFalso,
      bibliotecario: { pastasGenericas: ['projetos'] },
      ligacoes: [
        { origem: 'padaria/fonte-titulos.md', destino: 'projetos/site-padaria-cores.md', tipo: 'contradiz' },
        { origem: 'horta/banco-postgres.md', destino: 'projetos/horta-facil-banco.md', tipo: 'substitui' }
      ]
    })
    const r1 = await buscarMemorias('muda a fonte dos títulos do site da padaria', base.ctx, { tema: null })
    if (r1.escolhidas.includes('padaria/fonte-titulos.md')) expect(r1.escolhidas).toContain('projetos/site-padaria-cores.md')
    const r2 = await buscarMemorias('o banco do Horta Fácil está lento para listar os canteiros', base.ctx, { tema: null })
    expect(r2.escolhidas).not.toContain('projetos/horta-facil-banco.md')
  })

  it('estável: mesma entrada, mesma escolha', async () => {
    const { ctx } = await preparar()
    const a = await buscarMemorias('prepara o relatório mensal de novembro', ctx, { tema: null })
    const b = await buscarMemorias('prepara o relatório mensal de novembro', ctx, { tema: null })
    expect(b.escolhidas).toEqual(a.escolhidas)
  })
})

describe('PageRank personalizado', () => {
  it('soma 1, perto da semente ganha mais que longe, e quem não liga fica com 0', () => {
    const g = new Graph({ type: 'undirected' })
    for (const n of ['a', 'b', 'c', 'd']) g.addNode(n)
    g.addEdge('a', 'b', { peso: 1 })
    g.addEdge('b', 'c', { peso: 1 })
    const pr = pagerankPersonalizado(g, new Map([['a', 1]]))
    const soma = [...pr.values()].reduce((s, v) => s + v, 0)
    expect(soma).toBeCloseTo(1, 6)
    expect(pr.get('a')!).toBeGreaterThan(pr.get('c')!)
    expect(pr.get('b')!).toBeGreaterThan(pr.get('c')!)
    expect(pr.get('d')).toBe(0)
  })
})
