/**
 * Conteúdo do painel lateral (HTML) para cada coisa selecionada. Todo dado do acervo
 * passa por `esc` antes de entrar no HTML.
 */
import type { Grafo } from './tipos'
import type { Nivel } from './dados'
import { NOME_NIVEL, ORDEM_NIVEIS, REGRA_NIVEL, memoriasPorNivel, parecidasDe } from './vista'

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

const num = (n: number): string => n.toLocaleString('pt-BR')
const dec = (n: number): string => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const plural = (n: number, um: string, varios: string): string => `${num(n)} ${n === 1 ? um : varios}`

export function dataBr(iso: string | null): string {
  if (!iso) return 'sem data'
  const [a, m, d] = iso.split('-')
  return `${d}/${m}/${a}`
}

const ORIGEM: Record<string, string> = { cabecalho: 'do cabeçalho da memória', texto: 'tirada do texto' }

function marca(cor: string): string {
  return `<span class="marca" style="background:${esc(cor)}" aria-hidden="true"></span>`
}

function linhaMemoria(g: Grafo, i: number, extra = ''): string {
  const m = g.memorias[i]
  return `<li><button type="button" class="item" data-ir="m:${i}">${marca(g.temas[m.tema].cor)}<span class="item-texto">${esc(m.titulo)}</span>${extra}</button></li>`
}

export function painelInicial(g: Grafo, visao: string): string {
  const ajuda: Record<string, string> = {
    temas: 'Cada círculo é um tema (a primeira pasta da memória). Clique em um tema para ver quantas memórias ele tem em cada nível e com quais assuntos ele se parece. Clique em uma linha para ver por que os dois temas estão ligados.',
    arvore: 'Escolha um tema na lista acima. Ele aparece à esquerda, dividido nos cinco níveis de memória; à direita ficam as memórias de cada nível, da mais nova para a mais antiga. Clique em um ponto para abrir a memória.',
    memorias: 'Cada ponto é uma memória, na cor do seu tema. Uma linha liga duas memórias que falam de coisas parecidas. Use a lista de temas ou a busca para destacar parte do mapa e clique em um ponto para ver os detalhes.'
  }
  return `<h2>Como ler</h2><p>${ajuda[visao] ?? ''}</p>
  <h3>Níveis de memória</h3>
  <dl class="niveis">${ORDEM_NIVEIS.map((n) => `<div><dt>${NOME_NIVEL[n]}</dt><dd>${REGRA_NIVEL[n]}</dd></div>`).join('')}</dl>
  <p class="nota">O nível sai da data da memória: a do cabeçalho, quando existe; senão, a data mais recente escrita no texto. Sem nenhuma data, a memória fica em Longo. Referência: ${dataBr(g.hoje)}.</p>`
}

function contagemNiveis(porNivel: Record<Nivel, number>): string {
  return `<dl class="contagem">${ORDEM_NIVEIS.map(
    (n) => `<div${n === 'observacoes' ? ' class="vazio"' : ''}><dt>${NOME_NIVEL[n]}</dt><dd>${n === 'observacoes' ? 'vazio' : num(porNivel[n])}</dd></div>`
  ).join('')}</dl>`
}

export function painelTema(g: Grafo, t: number): string {
  const tema = g.temas[t]
  const ligs = g.ligacoesTemas
    .filter((l) => l.a === t || l.b === t)
    .sort((x, y) => y.cosseno - x.cosseno)
  const lista = ligs.length
    ? `<ul class="lista">${ligs
        .map((l) => {
          const outro = l.a === t ? l.b : l.a
          return `<li><button type="button" class="item" data-ir="t:${outro}">${marca(g.temas[outro].cor)}<span class="item-texto">${esc(g.temas[outro].nome)}<small>${esc(l.motivo)}</small></span></button></li>`
        })
        .join('')}</ul>`
    : `<p class="nota">${tema.nome === 'geral' ? 'O tema geral reúne os arquivos soltos, fora de pastas. Por isso ele não é ligado a outros temas.' : 'Nenhum tema parecido o bastante.'}</p>`
  return `<p class="rotulo">Tema</p><h2>${marca(tema.cor)}${esc(tema.nome)}</h2>
  <p class="destaque">${plural(tema.total, 'memória', 'memórias')}</p>
  ${contagemNiveis(tema.porNivel)}
  <h3>Palavras que marcam o tema</h3>
  <p>${tema.palavras.length ? tema.palavras.map((p) => `<span class="palavra">${esc(p)}</span>`).join(' ') : 'nenhuma'}</p>
  <h3>Temas parecidos</h3>${lista}
  <button type="button" class="botao" data-arvore="${t}">Ver a árvore deste tema</button>`
}

export function painelLigacao(g: Grafo, indice: number): string {
  const l = g.ligacoesTemas[indice]
  const a = g.temas[l.a]
  const b = g.temas[l.b]
  return `<p class="rotulo">Ligação entre temas</p>
  <h2>${esc(a.nome)} e ${esc(b.nome)}</h2>
  <p>${esc(l.motivo)}</p>
  <dl class="ficha"><div><dt>Semelhança dos assuntos</dt><dd>${dec(l.cosseno)}</dd></div>
  <div><dt>Pares de memórias parecidas</dt><dd>${num(l.pares)}</dd></div></dl>
  <p class="nota">A semelhança compara o conteúdo médio das memórias de cada tema. Vai de 0 (nada em comum) a 1 (o mesmo assunto).</p>
  <ul class="lista">
    <li><button type="button" class="item" data-ir="t:${l.a}">${marca(a.cor)}<span class="item-texto">Abrir ${esc(a.nome)}</span></button></li>
    <li><button type="button" class="item" data-ir="t:${l.b}">${marca(b.cor)}<span class="item-texto">Abrir ${esc(b.nome)}</span></button></li>
  </ul>`
}

export function painelNivel(g: Grafo, tema: number, nivel: Nivel): string {
  if (nivel === 'observacoes') {
    return `<p class="rotulo">Nível · ${esc(g.temas[tema].nome)}</p><h2>Observações</h2>
    <p class="destaque">Vazio</p>
    <p>Este nível vai guardar observações tiradas das conversas. Ele ainda não existe no conjunto de teste, por isso aparece vazio em todos os temas.</p>`
  }
  const lista = memoriasPorNivel(g, tema)[nivel]
  const corpo = lista.length
    ? `<ul class="lista">${lista.map((i) => linhaMemoria(g, i, `<small class="data">${dataBr(g.memorias[i].data)}</small>`)).join('')}</ul>`
    : `<p class="nota">Nenhuma memória deste tema cai neste nível.</p>`
  return `<p class="rotulo">Nível · ${esc(g.temas[tema].nome)}</p><h2>${NOME_NIVEL[nivel]}</h2>
  <p class="destaque">${plural(lista.length, 'memória', 'memórias')}</p>
  <p class="nota">Regra: ${REGRA_NIVEL[nivel]}.</p>${corpo}`
}

export function painelMemoria(g: Grafo, i: number): string {
  const m = g.memorias[i]
  const tema = g.temas[m.tema]
  const viz = parecidasDe(g, i)
  const origem = m.origemData ? ORIGEM[m.origemData] : 'sem data no cabeçalho nem no texto'
  const parecidas = viz.length
    ? `<ul class="lista">${viz.map((v) => linhaMemoria(g, v.i, `<small class="data">${dec(v.cosseno)}</small>`)).join('')}</ul>`
    : `<p class="nota">Nenhuma memória passou do limite de semelhança (${dec(g.parecida.limiar)}).</p>`
  return `<p class="rotulo">Memória</p><h2>${esc(m.titulo)}</h2>
  ${m.gancho ? `<p class="gancho">${esc(m.gancho)}</p>` : ''}
  <dl class="ficha">
    <div><dt>Tema</dt><dd><button type="button" class="link" data-ir="t:${m.tema}">${marca(tema.cor)}${esc(tema.nome)}</button></dd></div>
    <div><dt>Nível</dt><dd>${NOME_NIVEL[m.nivel]}</dd></div>
    <div><dt>Data</dt><dd>${dataBr(m.data)} <small>(${origem})</small></dd></div>
    <div><dt>Sempre lembrada</dt><dd>${m.sempre ? 'sim' : 'não'}</dd></div>
    <div><dt>Contexto</dt><dd>não registrado no conjunto de teste</dd></div>
    <div><dt>Arquivo</dt><dd class="caminho">${esc(m.caminho)}</dd></div>
  </dl>
  <h3>Memórias parecidas</h3>${parecidas}`
}
