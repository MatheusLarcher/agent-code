/**
 * Página do visualizador (roda no navegador, empacotada pelo esbuild em `app.js`).
 * Lê `window.GRAFO` (de `dados.js`) e desenha as três visões com uma única instância
 * do Sigma, trocando o grafo conforme a aba escolhida.
 */
import Sigma from 'sigma'
import type Graph from 'graphology'
import type { EdgeDisplayData, NodeDisplayData } from 'sigma/types'
import type { Grafo } from './tipos'
import type { Nivel } from './dados'
import {
  COR_APAGADA,
  COR_TINTA,
  grafoArvore,
  grafoMemorias,
  grafoTemas,
  indiceDe,
  normalizar,
  tipoDe
} from './vista'
import { dataBr, esc, painelInicial, painelLigacao, painelMemoria, painelNivel, painelTema } from './painel'

type Visao = 'temas' | 'arvore' | 'memorias'

declare global {
  interface Window {
    GRAFO?: Grafo
  }
}

const porId = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`elemento #${id} não encontrado`)
  return el as T
}

const num = (n: number): string => n.toLocaleString('pt-BR')

/** Aparência comum dos rótulos: sem sombra nem brilho, só uma borda fina. */
const ROTULO: Partial<NodeDisplayData> = {
  labelFont: 'Bahnschrift',
  labelColor: COR_TINTA,
  labelSize: 13,
  backdropColor: '#ffffff',
  backdropShadowBlur: 0,
  backdropShadowColor: 'rgba(0,0,0,0)',
  backdropBorderColor: '#d9dde3',
  backdropBorderWidth: 1,
  backdropPadding: 4,
  backdropCornerRadius: 2,
  cursor: 'pointer'
}

function iniciar(g: Grafo): void {
  const palco = porId('palco')
  const painel = porId('painel')
  const filtro = porId<HTMLSelectElement>('filtro-tema')
  const rotuloFiltro = porId('rotulo-filtro')
  const campoFiltro = porId('campo-filtro')
  const busca = porId<HTMLInputElement>('busca')
  const legenda = porId('legenda')
  const dica = porId('dica')
  const abas = [...document.querySelectorAll<HTMLButtonElement>('[data-visao]')]
  const semMovimento = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const duracao = semMovimento ? 0 : 400

  const estado = {
    visao: 'temas' as Visao,
    temaArvore: 0,
    filtroTema: -1,
    busca: '',
    selecionado: null as string | null,
    ligacao: null as string | null,
    sobre: null as string | null
  }
  let vizinhos = new Set<string>()
  let achados = new Set<string>()

  const temasGrafo = grafoTemas(g)
  const memoriasGrafo = grafoMemorias(g)
  let graph: Graph = temasGrafo

  // ---- resumo do topo ----
  porId('resumo').textContent = `${num(g.memorias.length)} memórias · ${num(g.temas.length)} temas · ${num(g.parecidas.length)} ligações entre memórias parecidas · referência ${dataBr(g.hoje)}`

  const passaFiltro = (no: string): boolean => {
    if (estado.visao !== 'memorias' || estado.filtroTema < 0 || tipoDe(no) !== 'memoria') return true
    return g.memorias[indiceDe(no)].tema === estado.filtroTema
  }

  const MAX_ROTULOS_BUSCA = 15
  const rotuloSempre =(no: string): boolean => estado.visao === 'temas' || (estado.visao === 'arvore' && tipoDe(no) !== 'memoria')

  const renderer = new Sigma(graph, palco, {
    settings: {
      itemSizesReference: 'screen',
      zoomToSizeRatioFunction: Math.sqrt,
      labelRenderedSizeThreshold: 6,
      labelDensity: 0.6,
      enableEdgeEvents: true,
      hideEdgesOnMove: false,
      stagePadding: 40,
      minCameraRatio: 0.05,
      maxCameraRatio: 3,
      enableCameraRotation: false,
      enableCameraMouseRotation: false,
      sharedGestureWheelMessage: 'Use Ctrl + rolagem para aproximar o mapa',
      sharedGestureAppleWheelMessage: 'Use ⌘ + rolagem para aproximar o mapa',
      sharedGestureTouchMessage: 'Use dois dedos para mover o mapa'
    },
    nodeReducer: (no, _dados, _attrs, est) => {
      const r: Partial<NodeDisplayData> = { ...ROTULO }
      const foco = estado.selecionado ?? estado.sobre
      let apagado: boolean
      if (foco) apagado = no !== foco && !vizinhos.has(no)
      else {
        // na árvore, o tema e os níveis são a estrutura: a busca não os apaga
        const estrutura = estado.visao === 'arvore' && tipoDe(no) !== 'memoria'
        apagado = !passaFiltro(no) || (estado.busca !== '' && !achados.has(no) && !estrutura)
      }

      if (apagado && !est.isHovered) {
        r.color = COR_APAGADA
        r.labelVisibility = 'hidden'
        r.zIndex = 0
      } else {
        r.zIndex = 1
        // com muitos achados os rótulos se amontoam: só força o rótulo quando são poucos
        const achadoComRotulo = estado.busca !== '' && achados.has(no) && achados.size <= MAX_ROTULOS_BUSCA
        if (foco || rotuloSempre(no) || achadoComRotulo) r.labelVisibility = 'visible'
      }
      if (no === estado.selecionado) {
        r.highlighted = true
        r.zIndex = 2
        r.labelVisibility = 'visible'
      }
      return r
    },
    edgeReducer: (aresta, _dados, _attrs, est) => {
      const r: Partial<EdgeDisplayData> = {}
      if (estado.ligacao === aresta || est.isHovered) {
        r.color = COR_TINTA
        r.zIndex = 2
        return r
      }
      const foco = estado.selecionado ?? estado.sobre
      const [a, b] = graph.extremities(aresta)
      if (foco) {
        if (a !== foco && b !== foco) {
          if (estado.visao === 'memorias') r.visibility = 'hidden'
          else r.color = COR_APAGADA
        } else if (estado.visao === 'memorias') {
          r.color = '#8b95a1'
        }
        return r
      }
      if (estado.visao === 'memorias' && (estado.filtroTema >= 0 || estado.busca !== '')) {
        const ok = (no: string): boolean => passaFiltro(no) && (estado.busca === '' || achados.has(no))
        if (!ok(a) && !ok(b)) r.visibility = 'hidden'
      }
      return r
    }
  })

  function atualizar(): void {
    const foco = estado.selecionado ?? estado.sobre
    vizinhos = foco && graph.hasNode(foco) ? new Set(graph.neighbors(foco)) : new Set()
    renderer.refresh()
  }

  function irPara(no: string): void {
    const d = renderer.getNodeDisplayData(no)
    if (!d) return
    const camera = renderer.getCamera()
    const ratio = Math.min(camera.getState().ratio, estado.visao === 'memorias' ? 0.35 : 0.8)
    void camera.animate({ x: d.x, y: d.y, ratio }, { duration: duracao })
  }

  // ---- painel ----
  function mostrarPainel(html: string): void {
    painel.innerHTML = html
    painel.scrollTop = 0
  }

  function painelDoNo(no: string): string {
    const tipo = tipoDe(no)
    if (tipo === 'tema') return painelTema(g, indiceDe(no))
    if (tipo === 'nivel') return painelNivel(g, estado.temaArvore, no.slice(2) as Nivel)
    return painelMemoria(g, indiceDe(no))
  }

  function selecionar(no: string | null, mover = false): void {
    estado.selecionado = no
    estado.ligacao = null
    if (no) mostrarPainel(painelDoNo(no))
    else mostrarPainel(painelInicial(g, estado.visao))
    atualizar()
    if (no && mover) irPara(no)
  }

  // ---- legenda, filtro e dica por visão ----
  function desenharLegenda(): void {
    if (estado.visao === 'arvore') {
      const t = g.temas[estado.temaArvore]
      legenda.innerHTML = `<li><span class="marca" style="background:${esc(t.cor)}" aria-hidden="true"></span>Tema e suas memórias</li>
        <li><span class="marca" style="background:#5b6573" aria-hidden="true"></span>Nível com memórias</li>
        <li><span class="marca" style="background:#b8bfc8" aria-hidden="true"></span>Nível vazio</li>`
      return
    }
    const geral = g.temas.find((t) => t.nome === 'geral')
    const cinza = geral ? `<li><span class="marca" style="background:${esc(geral.cor)}" aria-hidden="true"></span>Geral: arquivos fora de pastas</li>` : ''
    legenda.innerHTML =
      estado.visao === 'temas'
        ? `<li>Círculo maior: mais memórias</li><li>Linha mais grossa: assuntos mais próximos</li>${cinza}`
        : `<li>Cor: tema da memória (as cores se repetem; use “Destacar tema”)</li><li>Linha: memórias parecidas</li>${cinza}`
  }

  const DICAS: Record<Visao, string> = {
    temas: 'Clique em um tema ou em uma linha. Role para aproximar; arraste para mover.',
    arvore: 'Clique em um nível para listar as memórias dele, ou em um ponto para abrir a memória.',
    memorias: 'Passe o mouse sobre um ponto para ver as memórias parecidas. Clique para abrir.'
  }

  function prepararFiltro(): void {
    if (estado.visao === 'temas') {
      campoFiltro.hidden = true
      return
    }
    campoFiltro.hidden = false
    const opcoes = g.temas.map((t, i) => `<option value="${i}">${esc(t.nome)} (${num(t.total)})</option>`).join('')
    if (estado.visao === 'arvore') {
      rotuloFiltro.textContent = 'Tema'
      filtro.innerHTML = opcoes
      filtro.value = String(estado.temaArvore)
    } else {
      rotuloFiltro.textContent = 'Destacar tema'
      filtro.innerHTML = `<option value="-1">Todos os temas</option>${opcoes}`
      filtro.value = String(estado.filtroTema)
    }
  }

  function calcularAchados(): void {
    const q = normalizar(estado.busca.trim())
    achados = new Set()
    if (!q) return
    graph.forEachNode((no, attrs) => {
      const tipo = tipoDe(no)
      const alvo =
        tipo === 'memoria'
          ? `${g.memorias[indiceDe(no)].titulo} ${g.memorias[indiceDe(no)].caminho}`
          : tipo === 'tema'
            ? g.temas[indiceDe(no)].nome
            : String(attrs.label ?? '')
      if (normalizar(alvo).includes(q)) achados.add(no)
    })
  }

  // o total acompanha a visão atual (a árvore só tem as memórias de um tema)
  function mostrarTotal(): void {
    porId('busca-total').textContent = estado.busca.trim() ? `${num(achados.size)} encontrado${achados.size === 1 ? '' : 's'}` : ''
  }

  function trocarVisao(visao: Visao, opcoes: { tema?: number; manterSelecao?: boolean } = {}): void {
    if (opcoes.tema !== undefined) estado.temaArvore = opcoes.tema
    estado.visao = visao
    graph = visao === 'temas' ? temasGrafo : visao === 'memorias' ? memoriasGrafo : grafoArvore(g, estado.temaArvore)
    renderer.setGraph(graph)
    renderer.setSetting('labelDensity', visao === 'memorias' ? 0.35 : 1)
    abas.forEach((b) => {
      const ativa = b.dataset.visao === visao
      b.setAttribute('aria-selected', String(ativa))
      b.tabIndex = ativa ? 0 : -1
    })
    palco.setAttribute('aria-label', `Mapa: ${abas.find((b) => b.dataset.visao === visao)?.textContent ?? ''}`)
    dica.textContent = DICAS[visao]
    prepararFiltro()
    desenharLegenda()
    calcularAchados()
    mostrarTotal()
    estado.sobre = null
    if (!opcoes.manterSelecao) selecionar(null)
    renderer.getCamera().setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 })
  }

  // ---- eventos do mapa ----
  renderer.on('enterNode', ({ node }) => {
    estado.sobre = node
    atualizar()
  })
  renderer.on('leaveNode', () => {
    estado.sobre = null
    atualizar()
  })
  renderer.on('clickNode', ({ node }) => selecionar(node))
  renderer.on('clickEdge', ({ edge }) => {
    if (estado.visao !== 'temas' || !edge.startsWith('l:')) return
    estado.selecionado = null
    estado.ligacao = edge
    mostrarPainel(painelLigacao(g, indiceDe(edge)))
    atualizar()
  })
  renderer.on('clickStage', () => selecionar(null))

  // ---- eventos da página ----
  abas.forEach((b) =>
    b.addEventListener('click', () => {
      const v = b.dataset.visao as Visao
      if (v !== estado.visao) trocarVisao(v)
    })
  )
  porId('abas').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const i = abas.findIndex((b) => b.dataset.visao === estado.visao)
    const prox = abas[(i + (e.key === 'ArrowRight' ? 1 : abas.length - 1)) % abas.length]
    prox.focus()
    prox.click()
  })

  filtro.addEventListener('change', () => {
    const v = Number(filtro.value)
    if (estado.visao === 'arvore') trocarVisao('arvore', { tema: v })
    else {
      estado.filtroTema = v
      selecionar(null)
    }
  })

  busca.addEventListener('input', () => {
    estado.busca = busca.value
    calcularAchados()
    mostrarTotal()
    if (estado.selecionado) selecionar(null)
    else atualizar()
  })
  busca.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const primeiro = [...achados][0]
      if (primeiro) selecionar(primeiro, true)
    } else if (e.key === 'Escape') {
      busca.value = ''
      busca.dispatchEvent(new Event('input'))
    }
  })

  porId('aproximar').addEventListener('click', () => void renderer.getCamera().zoomIn({ duration: duracao }))
  porId('afastar').addEventListener('click', () => void renderer.getCamera().zoomOut({ duration: duracao }))
  porId('ver-tudo').addEventListener('click', () => void renderer.getCamera().reset({ duration: duracao }))

  painel.addEventListener('click', (e) => {
    const alvo = (e.target as HTMLElement).closest<HTMLElement>('[data-ir],[data-arvore]')
    if (!alvo) return
    if (alvo.dataset.arvore !== undefined) {
      trocarVisao('arvore', { tema: Number(alvo.dataset.arvore) })
      return
    }
    const no = alvo.dataset.ir ?? ''
    if (tipoDe(no) === 'tema' && estado.visao !== 'temas') trocarVisao('temas', { manterSelecao: true })
    else if (tipoDe(no) === 'memoria' && !graph.hasNode(no)) trocarVisao('memorias', { manterSelecao: true })
    selecionar(no, true)
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.activeElement !== busca) selecionar(null)
  })

  trocarVisao('temas')
}

const grafo = window.GRAFO
if (grafo && Array.isArray(grafo.memorias) && grafo.memorias.length > 0) {
  iniciar(grafo)
} else {
  const palco = document.getElementById('palco')
  if (palco) {
    palco.innerHTML =
      '<p class="erro">Os dados do mapa não foram encontrados. Gere a página de novo com o script gerar.ts e abra o index.html da pasta gerada.</p>'
  }
}
