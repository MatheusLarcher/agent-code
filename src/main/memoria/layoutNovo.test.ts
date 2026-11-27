import { describe, expect, it } from 'vitest'
import { comCampos, faltaLayoutNovo, lerCampos, separar } from './cabecalho'
import { appendFact, buildMemoryBody, parseMemoristaVerdict } from './memoristaPrompt'
import { memoriasParecidas, temasDoAcervo } from './parecidas'
import { fichaDe, ligacoesDasFichas } from './orquestracao/fichas'

const NOW = Date.parse('2026-11-27T12:00:00Z')

describe('cabeçalho do layout novo (D43, D48, D49)', () => {
  const antiga = '---\nname: push\ndescription: quando subir\nmetadata:\n  type: instrucao\n---\n# Push\nUsar a conta erickxc.\n'

  it('grava e lê os campos sem mexer no corpo nem no resto do cabeçalho', () => {
    const nova = comCampos(antiga, { tema: 'agent-code', criada: '2026-11-20', gatilhos: ['manda pro github', 'faz o push'], termos: ['erickxc'] })
    expect(separar(nova).corpo).toBe(separar(antiga).corpo)
    expect(nova).toContain('metadata:\n  type: instrucao')
    expect(lerCampos(nova)).toMatchObject({ tema: 'agent-code', criada: '2026-11-20', gatilhos: ['manda pro github', 'faz o push'], termos: ['erickxc'] })
  })

  it('troca uma lista que já existia em vez de duplicar', () => {
    const uma = comCampos(antiga, { gatilhos: ['a', 'b'] })
    const duas = comCampos(uma, { gatilhos: ['c'] })
    expect(lerCampos(duas).gatilhos).toEqual(['c'])
    expect(duas.match(/gatilhos:/g)).toHaveLength(1)
  })

  it('valor com quebra de linha não abre outra chave', () => {
    const c = comCampos(antiga, { contexto: 'agent-code\nsempre: true' })
    expect(lerCampos(c).contexto).toBe('agent-code sempre: true')
    expect(c).not.toMatch(/^sempre:/m)
  })

  it('diz o que falta numa memória antiga', () => {
    expect(faltaLayoutNovo(antiga)).toEqual({ tema: true, datas: true, gatilhos: true })
    expect(faltaLayoutNovo(comCampos(antiga, { tema: 'x', criada: '2026-01-01', modificada: '2026-01-02', gatilhos: ['g'] }))).toEqual({ tema: false, datas: false, gatilhos: false })
  })
})

describe('memorista: resposta em JSON', () => {
  const known = ['agent-code/push.md', 'opti/darj.md']

  it('lê NOVA com os campos novos e descarta ligação para caminho que não viu', () => {
    const raw = JSON.stringify({ operacoes: [{
      op: 'NOVA', categoria: 'decisao', caminho: 'agent-code/vitest-ram.md', tema: 'Agent Code', titulo: 'Testes com 2 processos',
      gancho: 'ao rodar a suíte', fato: 'A suíte completa trava o PC; rodar com --maxWorkers=2.', importancia: 4,
      gatilhos: ['roda os testes', 'roda os testes'], termos: ['vitest'], contexto: 'otimizando a RAM',
      contradiz: ['opti/darj.md', 'inventado.md'], relacionadas: ['agent-code/push.md']
    }] })
    const [op] = parseMemoristaVerdict(`aqui está:\n${raw}`, known)
    expect(op).toMatchObject({ kind: 'create', tema: 'agent-code', importancia: 4, gatilhos: ['roda os testes'], contradiz: ['opti/darj.md'], relacionadas: ['agent-code/push.md'] })
  })

  it('COMPLEMENTA só em caminho conhecido; NOVA sobre caminho existente é recusada', () => {
    const raw = JSON.stringify({ operacoes: [
      { op: 'COMPLEMENTA', caminho: 'nao-vi.md', fato: 'x' },
      { op: 'NOVA', categoria: 'infra', caminho: 'agent-code/push.md', titulo: 't', gancho: 'g', fato: 'f' },
      { op: 'COMPLEMENTA', caminho: 'Agent-Code/Push.md', fato: 'Também vale para o fork.', gatilhos: ['sobe isso'] }
    ] })
    expect(parseMemoristaVerdict(raw, known)).toEqual([{ kind: 'update', relPath: 'agent-code/push.md', fact: 'Também vale para o fork.', gatilhos: ['sobe isso'] }])
  })

  it('OK e o formato antigo em linhas continuam valendo', () => {
    expect(parseMemoristaVerdict('OK', known)).toEqual([])
    expect(parseMemoristaVerdict('COMPLEMENTA | opti/darj.md | Fato novo.', known)).toEqual([{ kind: 'update', relPath: 'opti/darj.md', fact: 'Fato novo.' }])
  })

  it('a memória nova sai com o cabeçalho completo e o fato inteiro no corpo', () => {
    const fato = 'Fato longo. '.repeat(40).trim()
    const body = buildMemoryBody({ kind: 'create', relPath: 'opti/tela.md', type: 'conhecimento', title: 'Tela', hook: 'quando a tela ficar lenta', fact: fato, gatilhos: ['ta lenta'], contexto: 'otimizando' }, { now: NOW, project: 'opti-web' })
    expect(lerCampos(body)).toMatchObject({ tema: 'opti', criada: '2026-11-27', modificada: '2026-11-27', contexto: 'opti-web — otimizando', gatilhos: ['ta lenta'] })
    expect(separar(body).corpo).toContain(fato)
  })

  it('complementar marca a modificação e soma gatilhos sem repetir', () => {
    const atual = comCampos('---\nname: x\n---\n# X\nPrimeiro.\n', { criada: '2026-01-01', modificada: '2026-01-01', gatilhos: ['a'] })
    const nova = appendFact(atual, 'Segundo.', { now: NOW, gatilhos: ['A', 'b'] })!
    expect(lerCampos(nova)).toMatchObject({ criada: '2026-01-01', modificada: '2026-11-27', gatilhos: ['a', 'b'] })
    expect(separar(nova).corpo).toContain('Primeiro.\nSegundo.')
    // memória antiga sem `criada`: não inventa "hoje" (a data vem do banco pelo bibliotecário)
    expect(lerCampos(appendFact('# Y\nUm.\n', 'Dois.', { now: NOW })!).criada).toBeUndefined()
  })
})

describe('parecidas para o memorista (D26)', () => {
  const acervo = Array.from({ length: 30 }, (_, i) => ({ relPath: `geral/m${i}.md`, title: `Assunto ${i}`, hook: 'qualquer', body: 'nada', updatedAt: `2026-01-${String(i + 1).padStart(2, '0')}` }))
  acervo.push({ relPath: 'agent-code/push.md', title: 'Push no GitHub', hook: 'ao subir alterações', body: comCampos('# Push', { tema: 'agent-code', gatilhos: ['manda pro github'] }), updatedAt: '2025-01-01' })

  it('acha a parecida mesmo fora das 40 primeiras e com erro de digitação', () => {
    expect(memoriasParecidas(acervo, 'manda pro gihtub por favor', 10)[0].relPath).toBe('agent-code/push.md')
  })

  it('sem parecida, completa com as mais recentes', () => {
    const r = memoriasParecidas(acervo, 'xyzzy', 3)
    expect(r.map((m) => m.relPath)).toEqual(['geral/m29.md', 'geral/m28.md', 'geral/m27.md'])
  })

  it('conta os temas pelo cabeçalho ou pela pasta', () => {
    expect(temasDoAcervo(acervo)).toEqual([{ tema: 'geral', memorias: 30 }, { tema: 'agent-code', memorias: 1 }])
  })
})

describe('ligações do cabeçalho viram arestas do grafo', () => {
  it('contradiz, relacionadas e substitui', () => {
    const file = { relPath: 'a.md', title: 'A', hook: 'h', folders: [] } as unknown as Parameters<typeof fichaDe>[0]
    const ficha = fichaDe(file, comCampos('# A', { contradiz: ['b.md'], relacionadas: ['c.md'], substitui: ['d.md'] }), NOW)
    expect(ligacoesDasFichas([ficha])).toEqual([
      { origem: 'a.md', destino: 'b.md', tipo: 'contradiz' },
      { origem: 'a.md', destino: 'c.md', tipo: 'relacionada' },
      { origem: 'a.md', destino: 'd.md', tipo: 'substitui' }
    ])
  })
})
