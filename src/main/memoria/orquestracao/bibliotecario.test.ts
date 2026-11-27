// @vitest-environment node
// Bibliotecário (spec §7, checklist E2/E4/E5/E7/E10/E11) sobre um acervo de mentira montado
// numa pasta temporária. Sentido de mentira e determinístico (palavras em comum).
import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { comCampos, lerCampos } from '../cabecalho'
import type { MemoryProposeInput } from '../../memory/memoryModel'
import { normalizarTermo } from './catalogo'
import { aplicarPassada, datasConfiaveis, lerLayoutIA, PASTAS_GENERICAS, planejarPassada, type EntradaBibliotecario } from './bibliotecario'
import { AgendaBibliotecario } from './bibliotecarioAgenda'
import { prepararBusca } from './preparar'

const HOJE = Date.parse('2026-11-27T12:00:00Z')
const DIM = 256
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

const raiz = mkdtempSync(join(tmpdir(), 'bibliotecario-'))
afterAll(() => rmSync(raiz, { recursive: true, force: true }))
const memorias = join(raiz, 'memorias')
const md = (titulo: string, gancho: string, corpo: string, extra = ''): string =>
  `---\nname: x\ndescription: ${gancho}\n${extra}---\n# ${titulo}\n${corpo}\n`
const ARQUIVOS: Record<string, string> = {
  'padaria/cardapio.md': md('Cardápio da padaria', 'preços do cardápio', 'Pão francês, sonho e bolo de fubá no cardápio da padaria do bairro.'),
  'padaria/forno.md': md('Forno da padaria', 'horário do forno', 'O forno da padaria liga às cinco; pão francês sai às seis da padaria.'),
  'horta/rega.md': md('Rega da horta', 'irrigação', 'A rega da horta acontece cedo; tomate e alface pedem irrigação diária na horta.'),
  'horta/adubo.md': md('Adubo da horta', 'adubação', 'Adubo orgânico na horta a cada mês; tomate e alface crescem melhor na horta.'),
  // solta na raiz, claramente da padaria
  'sonho-recheio.md': md('Recheio do sonho', 'sonho da padaria', 'O sonho da padaria leva creme; pão francês e sonho são os mais vendidos da padaria.'),
  // repetida quase idêntica dentro da horta
  'horta/rega-copia.md': md('Rega da horta', 'irrigação', 'A rega da horta acontece cedo; tomate e alface pedem irrigação diária na horta.', 'modificada: 2026-11-26\n'),
  // memória "sempre" nunca é tocada
  'idioma.md': md('Idioma', 'sempre', 'Responder em português.', 'sempre: true\n')
}
for (const [rel, conteudo] of Object.entries(ARQUIVOS)) {
  mkdirSync(join(memorias, rel, '..'), { recursive: true })
  writeFileSync(join(memorias, rel), conteudo)
}
const entries: EntradaBibliotecario[] = Object.entries(ARQUIVOS).map(([relPath, body]) => ({
  relPath, title: /# (.+)/.exec(body)![1], hook: /description: (.+)/.exec(body)![1], body, revision: 1, status: 'active',
  createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-11-01T10:00:00Z'
}))
const preparar = () => prepararBusca(memorias, { hoje: HOJE, embed: embedFalso, cacheDir: join(raiz, 'vetores'), bibliotecario: {} })

function portaFalsa() {
  const propostas: MemoryProposeInput[] = []
  return { propostas, memory: { propose: vi.fn(async (i: MemoryProposeInput) => { propostas.push(i) }), applyPending: vi.fn(async () => undefined) } }
}

describe('planejar a passada', () => {
  it('solta vai para o tema certo, repetida é achada e "sempre" fica de fora', async () => {
    const plano = planejarPassada(entries, await preparar())
    expect(plano.temas).toContainEqual(expect.objectContaining({ relPath: 'sonho-recheio.md', para: 'padaria' }))
    expect(plano.repetidas).toEqual([expect.objectContaining({ fica: 'horta/rega-copia.md', sai: 'horta/rega.md' })])
    expect(plano.temas.some((t) => t.relPath === 'idioma.md')).toBe(false)
    expect(plano.completar.some((c) => c.relPath === 'idioma.md')).toBe(false)
    expect(plano.completar.find((c) => c.relPath === 'padaria/forno.md')).toEqual({ relPath: 'padaria/forno.md', tema: true, datas: true, gatilhos: true })
  })
})

describe('aplicar a passada (modo ligado)', () => {
  it('grava pelo serviço, nunca apaga, junta a repetida e completa datas e gatilhos', async () => {
    const plano = planejarPassada(entries, await preparar())
    const { propostas, memory } = portaFalsa()
    const perguntar = vi.fn(async (prompt: string) => {
      const caminhos = [...prompt.matchAll(/^### (.+)$/gm)].map((m) => m[1])
      return JSON.stringify(Object.fromEntries(caminhos.map((c) => [c, { tema: 'padaria', gatilhos: ['ta caro o pao', 'ta caro o pao', 'muda o preco'], termos: ['pão'] }])))
    })
    const r = await aplicarPassada(plano, entries, { memory, perguntar, sanitize: async (i) => i, temasExistentes: ['horta', 'padaria'], now: HOJE }, { loteIA: 2 })

    expect(propostas.every((p) => p.op === 'update' || p.op === 'retire')).toBe(true)
    expect(propostas.filter((p) => p.op === 'retire').map((p) => p.relPath)).toEqual(['horta/rega.md'])
    const fica = propostas.find((p) => p.relPath === 'horta/rega-copia.md')!
    expect(lerCampos(fica.body!).substitui).toEqual(['horta/rega.md'])
    const solta = propostas.find((p) => p.relPath === 'sonho-recheio.md')!
    expect(lerCampos(solta.body!).tema).toBe('padaria')
    // datas vêm do banco (D42); corpo original preservado (D49)
    const forno = propostas.find((p) => p.relPath === 'padaria/forno.md')!
    expect(lerCampos(forno.body!)).toMatchObject({ criada: '2026-10-01', modificada: '2026-11-01' })
    expect(forno.body).toContain('O forno da padaria liga às cinco')
    expect(propostas.every((p) => p.relPath !== 'idioma.md')).toBe(true)
    // um lote só (teto), de 2; o resto fica para a próxima passada
    expect(perguntar).toHaveBeenCalledTimes(1)
    expect(r.mudancas.filter((m) => m.acao === 'gatilhos')).toHaveLength(2)
    expect(r.pendentesIA).toBeGreaterThan(0)
    expect(propostas.every((p) => p.proposedBy === 'bibliotecario')).toBe(true)
    expect(memory.applyPending).toHaveBeenCalledTimes(1)
  })

  it('tema já declarado não é trocado nem pela IA', async () => {
    const declarada = entries.map((e) => (e.relPath === 'padaria/forno.md' ? { ...e, body: comCampos(e.body, { tema: 'cozinha' }) } : e))
    const plano = { ...planejarPassada(declarada, await preparar()), repetidas: [], temas: [] }
    const { propostas, memory } = portaFalsa()
    const perguntar = async () => JSON.stringify({ 'padaria/forno.md': { tema: 'padaria', gatilhos: ['liga o forno'] } })
    await aplicarPassada(plano, declarada, { memory, perguntar, sanitize: async (i) => i, temasExistentes: [], now: HOJE })
    expect(lerCampos(propostas.find((p) => p.relPath === 'padaria/forno.md')!.body!).tema).toBe('cozinha')
  })
})

describe('datas e pastas genéricas', () => {
  it('memória importada e nunca editada usa a data do arquivo; sem ela, não inventa', () => {
    const imp = { ...entries[0], originAgent: 'import', revision: 1, createdAt: '2026-11-27T09:00:00Z' }
    expect(datasConfiaveis(imp, Date.parse('2025-03-10T00:00:00Z'))).toEqual({ criada: Date.parse('2025-03-10T00:00:00Z'), modificada: Date.parse('2025-03-10T00:00:00Z') })
    expect(datasConfiaveis(imp, null)).toBeNull()
    // editada pelo app depois da importação: o banco vale
    expect(datasConfiaveis({ ...imp, revision: 2 }, null)).toEqual({ criada: Date.parse(imp.createdAt), modificada: Date.parse(imp.updatedAt) })
  })

  it('aplicar não escreve data quando não há data confiável', async () => {
    const importadas = entries.map((e) => ({ ...e, originAgent: 'import' as const }))
    const plano = { ...planejarPassada(importadas, await preparar()), temas: [], repetidas: [] }
    const { propostas, memory } = portaFalsa()
    await aplicarPassada(plano, importadas, { memory, sanitize: async (i) => i, temasExistentes: [], now: HOJE, mtime: () => null })
    expect(propostas).toHaveLength(0)
  })

  it('pasta genérica nunca vira destino de tema', async () => {
    mkdirSync(join(memorias, 'projetos'), { recursive: true })
    for (const n of ['a', 'b']) writeFileSync(join(memorias, 'projetos', `${n}.md`), md('Sonho', 'padaria', 'O sonho da padaria e o pão francês da padaria.'))
    try {
      const prep = await prepararBusca(memorias, { hoje: HOJE, embed: embedFalso, cacheDir: join(raiz, 'vetores2'), bibliotecario: { pastasGenericas: PASTAS_GENERICAS } })
      expect(prep.sugestoes.some((s) => s.para === 'projetos')).toBe(false)
      expect(prep.sugestoes).toContainEqual(expect.objectContaining({ id: 'projetos/a.md', para: 'padaria' }))
    } finally {
      rmSync(join(memorias, 'projetos'), { recursive: true, force: true })
    }
  })
})

describe('juiz da resposta da IA', () => {
  it('descarta caminho não pedido, lixo e tema fora do formato', () => {
    const r = lerLayoutIA('ok: {"a.md": {"tema": "Opti Web", "gatilhos": ["x", 3, "x"]}, "b.md": {"gatilhos": []}, "c.md": {"gatilhos": ["y"]}}', new Set(['a.md', 'b.md']))
    expect([...r]).toEqual([['a.md', { gatilhos: ['x'], termos: [] }]])
    expect(lerLayoutIA('não sei', new Set(['a.md'])).size).toBe(0)
  })
})

describe('agenda (regulador com zona morta)', () => {
  const deps = (modo: 'simulacao' | 'ligado' | 'desligado', memory = portaFalsa().memory) => ({
    modo: () => modo,
    memory: () => ({ ...memory, listEntries: async () => entries }),
    memoriesDir: () => memorias,
    relatorioDir: () => join(raiz, 'relatorio'),
    sanitize: async (i: MemoryProposeInput) => i,
    preparar
  })

  it('simulação escreve o relatório e não grava nada; sem mudança, a 2ª passada nem trabalha', async () => {
    const { propostas, memory } = portaFalsa()
    const agenda = new AgendaBibliotecario(deps('simulacao', memory))
    expect((await agenda.passada()).status).toBe('feita')
    expect(propostas).toHaveLength(0)
    expect(readFileSync(join(raiz, 'relatorio', 'ultima-passada.md'), 'utf8')).toContain('nada foi gravado')
    expect(readdirSync(join(raiz, 'relatorio', 'historico')).filter((n) => n.endsWith('.md'))).toHaveLength(1)
    expect((await agenda.passada()).status).toBe('sem-mudanca')
  })

  it('desligado não faz nada', async () => {
    expect((await new AgendaBibliotecario(deps('desligado')).passada()).status).toBe('desligado')
  })
})
