import { describe, it, expect } from 'vitest'
import { addMark, advancePhases, buildGraph, bounds, ensureNode, markFor, pathToNode, removeNode, stepPhysics, PHASE_MS } from './projectGraph'
import { ACTION_COLORS } from './projectActivity'
import type { ProjectNode } from '@shared/ipc'

const TREE: ProjectNode[] = [
  { path: 'src', name: 'src', isDir: true },
  { path: 'docs', name: 'docs', isDir: true },
  { path: 'src/main', name: 'main', isDir: true },
  { path: 'src/main/index.ts', name: 'index.ts', isDir: false },
  { path: 'src/App.tsx', name: 'App.tsx', isDir: false },
  { path: 'docs/ARQUITETURA.md', name: 'ARQUITETURA.md', isDir: false }
]

describe('buildGraph', () => {
  it('cria a raiz e liga cada nó ao pai certo', () => {
    const g = buildGraph(TREE, 'agent-code')
    expect(g.root.name).toBe('agent-code')
    expect(g.nodes).toHaveLength(TREE.length + 1) // +1 = a raiz
    expect(g.byPath.get('src/main/index.ts')!.parent!.path).toBe('src/main')
    expect(g.byPath.get('src')!.parent).toBe(g.root)
  })

  it('uma aresta por nó (fora a raiz) — nenhuma solta', () => {
    const g = buildGraph(TREE, 'p')
    expect(g.links).toHaveLength(TREE.length)
    for (const l of g.links) expect(l.a).toBe(l.b.parent)
  })

  it('nó órfão (pai cortado pelo teto da varredura) é descartado, não quebra', () => {
    const g = buildGraph([{ path: 'a/b/c.ts', name: 'c.ts', isDir: false }], 'p')
    expect(g.nodes).toHaveLength(1) // só a raiz
    expect(g.links).toHaveLength(0)
  })

  it('filhos não nascem no mesmo ponto (senão a repulsão nunca abre o cluster)', () => {
    const g = buildGraph(TREE, 'p')
    const a = g.byPath.get('src/main/index.ts')!
    const b = g.byPath.get('src/App.tsx')!
    expect(a.x === b.x && a.y === b.y).toBe(false)
  })

  it('o mesmo projeto sempre abre com o mesmo formato (layout determinístico)', () => {
    const a = buildGraph(TREE, 'p')
    const b = buildGraph(TREE, 'p')
    expect(a.nodes.map((n) => [n.x, n.y])).toEqual(b.nodes.map((n) => [n.x, n.y]))
  })
})

describe('pathToNode — a rota que a linha percorre', () => {
  it('vai da raiz até o arquivo, passando por cada pasta', () => {
    const g = buildGraph(TREE, 'agent-code')
    const route = pathToNode(g.byPath.get('src/main/index.ts')!)
    expect(route.map((n) => n.name)).toEqual(['agent-code', 'src', 'main', 'index.ts'])
  })

  it('a raiz sozinha é uma rota de um passo (chamada sem arquivo)', () => {
    const g = buildGraph(TREE, 'p')
    expect(pathToNode(g.root)).toHaveLength(1)
  })
})

describe('stepPhysics', () => {
  it('separa os nós em vez de deixá-los empilhados', () => {
    const g = buildGraph(TREE, 'p')
    const dist = (): number => {
      const a = g.byPath.get('src')!
      const b = g.byPath.get('docs')!
      return Math.hypot(a.x - b.x, a.y - b.y)
    }
    const before = dist()
    for (let i = 0; i < 200; i++) stepPhysics(g, 900, 600, 1)
    expect(dist()).toBeGreaterThan(Math.min(before, 30))
    for (const n of g.nodes) {
      expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true)
    }
  })

  it('alpha 0 congela o layout (é o que deixa o grafo assentar)', () => {
    const g = buildGraph(TREE, 'p')
    for (const n of g.nodes) { n.vx = 0; n.vy = 0 }
    const snap = g.nodes.map((n) => [n.x, n.y])
    stepPhysics(g, 900, 600, 0)
    expect(g.nodes.map((n) => [n.x, n.y])).toEqual(snap)
  })

  it('bounds cobre todos os nós', () => {
    const g = buildGraph(TREE, 'p')
    const b = bounds(g)
    for (const n of g.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(b.minX)
      expect(n.x).toBeLessThanOrEqual(b.maxX)
      expect(n.y).toBeGreaterThanOrEqual(b.minY)
      expect(n.y).toBeLessThanOrEqual(b.maxY)
    }
  })
})

describe('ensureNode / removeNode — o mapa vive durante a sessão', () => {
  it('põe no mapa um arquivo fora do filtro dos recentes, criando as pastas do caminho', () => {
    const g = buildGraph(TREE, 'p')
    const n = ensureNode(g, 'src/main/novo/fundo.ts', false)
    expect(n.name).toBe('fundo.ts')
    expect(g.byPath.get('src/main/novo')!.isDir).toBe(true)
    expect(pathToNode(n).map((x) => x.name)).toEqual(['p', 'src', 'main', 'novo', 'fundo.ts'])
  })

  it('não duplica um nó que já existe', () => {
    const g = buildGraph(TREE, 'p')
    const antes = g.nodes.length
    const a = ensureNode(g, 'src/App.tsx', false)
    expect(a).toBe(g.byPath.get('src/App.tsx'))
    expect(g.nodes).toHaveLength(antes)
  })

  it('nasce na fase pedida (chegando de trás x sendo montado)', () => {
    const g = buildGraph(TREE, 'p')
    expect(ensureNode(g, 'src/a.ts', false, 'arriving').phase).toBe('arriving')
    expect(ensureNode(g, 'src/b.ts', false, 'building').phase).toBe('building')
  })

  it('nasce em cima do pai, pra entrada parecer que veio de dentro do projeto', () => {
    const g = buildGraph(TREE, 'p')
    const pai = g.byPath.get('src/main')!
    const n = ensureNode(g, 'src/main/x.ts', false)
    expect(Math.hypot(n.x - pai.x, n.y - pai.y)).toBeLessThan(20)
  })

  it('remover tira o nó, a aresta, e reencaixa os filhos no avô (nada de aresta solta)', () => {
    const g = buildGraph(TREE, 'p')
    const alvo = g.byPath.get('src/main')!
    const filho = g.byPath.get('src/main/index.ts')!
    removeNode(g, alvo)
    expect(g.byPath.has('src/main')).toBe(false)
    expect(g.nodes).not.toContain(alvo)
    expect(filho.parent).toBe(g.byPath.get('src'))
    for (const l of g.links) {
      expect(g.nodes).toContain(l.a)
      expect(g.nodes).toContain(l.b)
    }
  })
})

describe('advancePhases — nascer, chegar e ser destruído', () => {
  it('a fase termina e o nó volta ao normal', () => {
    const g = buildGraph(TREE, 'p')
    const n = ensureNode(g, 'src/novo.ts', false, 'building')
    advancePhases(g, PHASE_MS.building / 2)
    expect(n.phase).toBe('building')
    expect(n.phaseT).toBeCloseTo(0.5, 2)
    advancePhases(g, PHASE_MS.building)
    expect(n.phase).toBe('idle')
    expect(n.phaseT).toBe(0)
  })

  it('só sai do grafo quando a destruição TERMINA (a animação chega a ser vista)', () => {
    const g = buildGraph(TREE, 'p')
    const n = g.byPath.get('src/App.tsx')!
    n.phase = 'dying'
    advancePhases(g, PHASE_MS.dying * 0.9)
    expect(g.nodes).toContain(n)
    advancePhases(g, PHASE_MS.dying * 0.2)
    expect(g.byPath.has('src/App.tsx')).toBe(false)
    expect(g.nodes).not.toContain(n)
  })

  it('nó parado não é tocado', () => {
    const g = buildGraph(TREE, 'p')
    const n = g.byPath.get('docs')!
    advancePhases(g, 5000)
    expect(n.phase).toBe('idle')
    expect(n.phaseT).toBe(0)
  })
})

describe('marcas: o que o agente fez fica no nó (e não apaga)', () => {
  it('a marca guarda a cor da ação e o turno que a causou', () => {
    const g = buildGraph(TREE, 'p')
    const n = g.byPath.get('src/App.tsx')!
    addMark(n, 'u1', 'Edit', false, 100)
    expect(n.marks).toHaveLength(1)
    expect(n.marks[0]).toMatchObject({ turnId: 'u1', tool: 'Edit', color: ACTION_COLORS.edit })
  })

  it('repetir a MESMA ferramenta no mesmo turno só atualiza a hora (não incha a lista)', () => {
    const g = buildGraph(TREE, 'p')
    const n = g.byPath.get('src/App.tsx')!
    addMark(n, 'u1', 'Read', false, 100)
    addMark(n, 'u1', 'Read', false, 900)
    expect(n.marks).toHaveLength(1)
    expect(n.marks[0].at).toBe(900)
  })

  it('sem filtro, vale a ação mais recente do nó', () => {
    const g = buildGraph(TREE, 'p')
    const n = g.byPath.get('src/App.tsx')!
    addMark(n, 'u1', 'Read', false, 100)
    addMark(n, 'u2', 'Edit', false, 200)
    expect(markFor(n, null)!.tool).toBe('Edit')
  })

  it('com filtro, vale a ação daquela mensagem — as outras não pintam o nó', () => {
    const g = buildGraph(TREE, 'p')
    const n = g.byPath.get('src/App.tsx')!
    addMark(n, 'u1', 'Read', false, 100)
    addMark(n, 'u2', 'Edit', false, 200)
    expect(markFor(n, 'u1')!.tool).toBe('Read')
    expect(markFor(n, 'u3')).toBeUndefined()
  })

  it('nó nunca tocado não acende', () => {
    const g = buildGraph(TREE, 'p')
    expect(markFor(g.byPath.get('docs')!, null)).toBeUndefined()
  })

  it('erro pinta de vermelho, seja qual for a ferramenta', () => {
    const g = buildGraph(TREE, 'p')
    const n = g.byPath.get('src/App.tsx')!
    addMark(n, 'u1', 'Edit', true, 100)
    expect(markFor(n, null)!.color).toBe(ACTION_COLORS.error)
  })
})

describe('filtro por tipo de modificação', () => {
  it('escondendo a leitura, vale a ação anterior que sobrou', () => {
    const g = buildGraph(TREE, 'p')
    const n = g.byPath.get('src/App.tsx')!
    addMark(n, 'u1', 'Edit', false, 100)
    addMark(n, 'u1', 'Read', false, 200)
    const semLeitura = (m: { tool: string }): boolean => m.tool !== 'Read'
    expect(markFor(n, null)!.tool).toBe('Read')
    expect(markFor(n, null, semLeitura)!.tool).toBe('Edit')
  })

  it('nó que só tem a ação escondida apaga', () => {
    const g = buildGraph(TREE, 'p')
    const n = g.byPath.get('src/App.tsx')!
    addMark(n, 'u1', 'Read', false, 100)
    expect(markFor(n, null, (m) => m.tool !== 'Read')).toBeUndefined()
  })

  it('os dois filtros valem juntos (mensagem E tipo)', () => {
    const g = buildGraph(TREE, 'p')
    const n = g.byPath.get('src/App.tsx')!
    addMark(n, 'u1', 'Edit', false, 100)
    addMark(n, 'u2', 'Read', false, 200)
    expect(markFor(n, 'u2', (m) => m.tool !== 'Read')).toBeUndefined()
    expect(markFor(n, 'u1', (m) => m.tool !== 'Read')!.tool).toBe('Edit')
  })
})
