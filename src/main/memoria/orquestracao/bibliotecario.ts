/**
 * O bibliotecário (D11, D26, D28, D31; spec §7; REGRAS-MEMORIA §5): organiza o acervo em
 * temas e no grafo, FORA da conversa, de hora em hora. O memorista grava; ele arruma.
 *
 * Uma passada:
 *  1. temas — memória solta (sem `tema:` e em `geral`/pasta genérica) vai para o tema cujo
 *     perfil de sentido ganha com folga clara (mecânico, D6). Grupos de soltas ligadas entre
 *     si (Louvain) viram SUGESTÃO de tema novo, só no relatório;
 *  2. repetidas — par quase idêntico no mesmo tema: a mais nova fica, recebe o que só a outra
 *     dizia e `substitui: [outra]`; a outra é aposentada (nunca apagada);
 *  3. layout novo (D48) — datas vêm do banco (D42); gatilhos/termos das memórias antigas, pela
 *     IA, em lote, com teto de memórias por passada;
 *  4. níveis — por regra (fichas.ts), só contados no relatório; nada a gravar (D9, fase 1).
 *
 * Limites (o "não pode"): nunca apaga; nunca muda o corpo de uma memória além de ACRESCENTAR
 * o texto da repetida que ela absorve (D49); não mexe em `tema:` já declarado; não toca em
 * memória `sempre`; toda escrita passa pelo serviço de memória (CAS + varredura de segredos).
 * Modo `simulacao` (padrão, E2) só escreve o relatório: o Erick aprova antes de ligar.
 */
import { comCampos, dataCabecalho, faltaLayoutNovo, lerCampos, separar } from '../cabecalho'
import type { MemoryEntry } from '../../persistence/types'
import type { BibliotecarioModo } from '../../../shared/ipc'
import type { MemoryProposeInput } from '../../memory/memoryModel'
import { gruposSemTema, precisaDeTema } from './bibliotecarioTemas'
import { NIVEIS, type Nivel } from './fichas'
import type { BuscaPreparada } from './preparar'

export type ModoBibliotecario = BibliotecarioModo
export const BIBLIOTECARIO_AGENT = 'bibliotecario'

export interface OpcoesPassada {
  /** Cosseno mínimo para duas memórias contarem como repetidas (padrão 0,95: conservador). */
  corteRepetida?: number
  /** Teto de junções por passada (padrão 5). */
  maxJuncoes?: number
  /** Teto de memórias enviadas à IA por passada, num lote só (padrão 10). */
  loteIA?: number
  /** Pastas que não são tema (padrão `PASTAS_GENERICAS`). */
  pastasGenericas?: readonly string[]
}

export interface PlanoPassada {
  temas: Array<{ relPath: string; de: string; para: string; nota: number }>
  repetidas: Array<{ fica: string; sai: string; cos: number }>
  /** Memórias no layout antigo e o que falta em cada. */
  completar: Array<{ relPath: string; tema: boolean; datas: boolean; gatilhos: boolean }>
  gruposNovos: string[][]
  niveis: Record<Nivel, number>
}

/** Entrada mínima que a passada lê de cada memória (do serviço de memória). */
export type EntradaBibliotecario = Pick<MemoryEntry, 'relPath' | 'title' | 'hook' | 'body' | 'revision' | 'status' | 'createdAt' | 'updatedAt'> &
  Partial<Pick<MemoryEntry, 'originAgent'>>

/**
 * Pastas que agrupam por tipo, não por assunto: nunca viram tema e as memórias delas são
 * tratadas como soltas (P38). A comparação ignora maiúsculas e acentos.
 */
export const PASTAS_GENERICAS = ['projetos', 'projects', 'outros', 'misc', 'diversos', 'notas', 'inbox', 'geral', 'memorias', 'memories', 'temp']

/**
 * De onde vêm as datas do cabeçalho (D42). Memória IMPORTADA de arquivo e nunca editada no
 * banco tem `created_at` = hora da importação, não a idade real: aí vale a data do arquivo.
 * Sem data confiável, não inventa (devolve null e o campo fica vazio).
 */
export function datasConfiaveis(e: EntradaBibliotecario, mtime: number | null): { criada: number; modificada: number } | null {
  if (e.originAgent === 'import' && e.revision <= 1) return mtime === null ? null : { criada: mtime, modificada: mtime }
  const criada = Date.parse(e.createdAt)
  const modificada = Date.parse(e.updatedAt)
  return Number.isFinite(criada) && Number.isFinite(modificada) ? { criada, modificada } : null
}

/** O que a passada precisa decidir: só leitura, sem efeito. Determinístico. */
export function planejarPassada(entries: readonly EntradaBibliotecario[], prep: BuscaPreparada, o: OpcoesPassada = {}): PlanoPassada {
  const { fichas, sentido, grafos } = prep.ctx
  const ativas = new Map(entries.filter((e) => e.status === 'active').map((e) => [e.relPath, e]))
  const fichaDe = new Map(fichas.map((f) => [f.id, f]))
  const temas = prep.sugestoes
    .filter((s) => s.para && s.para !== s.de && ativas.has(s.id) && !fichaDe.get(s.id)?.sempre)
    .map((s) => ({ relPath: s.id, de: s.de, para: s.para!, nota: Number(s.nota.toFixed(3)) }))

  const corte = o.corteRepetida ?? 0.95
  const repetidas: PlanoPassada['repetidas'] = []
  const usadas = new Set<string>()
  const candidatas = fichas.filter((f) => ativas.has(f.id) && !f.sempre)
  for (let i = 0; i < candidatas.length; i++) {
    for (let j = i + 1; j < candidatas.length; j++) {
      const a = candidatas[i]
      const b = candidatas[j]
      if (a.tema !== b.tema || usadas.has(a.id) || usadas.has(b.id)) continue
      if (grafos.contradiz(a.id).includes(b.id)) continue // conflito declarado não é repetição
      const cos = sentido.cos(sentido.vetor(a.id), sentido.vetor(b.id))
      if (cos < corte) continue
      // Fica a modificada por último (é a versão vigente); empate → a de texto maior.
      const ma = a.modificadaEm ?? a.criadaEm ?? 0
      const mb = b.modificadaEm ?? b.criadaEm ?? 0
      const [fica, sai] = ma > mb || (ma === mb && a.texto.length >= b.texto.length) ? [a, b] : [b, a]
      repetidas.push({ fica: fica.id, sai: sai.id, cos: Number(cos.toFixed(3)) })
      usadas.add(a.id)
      usadas.add(b.id)
    }
  }
  repetidas.sort((x, y) => y.cos - x.cos || x.fica.localeCompare(y.fica))

  const sai = new Set(repetidas.map((r) => r.sai))
  const completar = [...ativas.values()]
    .filter((e) => !sai.has(e.relPath) && !fichaDe.get(e.relPath)?.sempre)
    .map((e) => ({ relPath: e.relPath, ...faltaLayoutNovo(e.body) }))
    .filter((c) => c.tema || c.datas || c.gatilhos)
    .sort((a, b) => a.relPath.localeCompare(b.relPath))

  const movidas = new Set(temas.map((t) => t.relPath))
  const genericas = new Set(o.pastasGenericas ?? PASTAS_GENERICAS)
  const semTema = new Set(fichas.filter((f) => precisaDeTema(f, genericas) && !movidas.has(f.id)).map((f) => f.id))
  const niveis = Object.fromEntries(NIVEIS.map((n) => [n, 0])) as Record<Nivel, number>
  for (const f of fichas) niveis[f.nivel]++
  return { temas, repetidas, completar, gruposNovos: gruposSemTema(grafos.memorias, semTema), niveis }
}

/** Pergunta à IA (caminho do app, sem chave de API). `null` = sem resposta. */
export type PerguntarIA = (prompt: string) => Promise<string | null>

export const PROMPT_LAYOUT = `Você prepara memórias de um assistente de programação para serem ACHADAS depois.
Para cada memória, escreva:
- "tema": o projeto ou assunto, genérico e curto, em kebab-case (ex.: "agent-code", "apura", "opti", "geral"). Prefira um de TEMAS EXISTENTES. "geral" só para o que vale em qualquer projeto.
- "gatilhos": 3 a 6 frases curtas de como o usuário pediria algo em que esta memória importa, do jeito informal dele (curto, como numa conversa). Varie: pedido direto, reclamação, pergunta curta.
- "termos": até 10 nomes próprios, números, siglas e sinônimos que apareceriam numa conversa sobre isso.
Nunca copie senha, token ou chave para esses campos.
Responda SOMENTE com JSON: {"<caminho>": {"tema": "...", "gatilhos": ["..."], "termos": ["..."]}}`

export interface LayoutIA {
  tema?: string
  gatilhos: string[]
  termos: string[]
}

/**
 * O juiz da resposta da IA: código, não "parece certo". Só caminhos pedidos; de 1 a 6
 * gatilhos e até 10 termos, curtos, sem repetição; tema em kebab-case. O resto é descartado.
 */
export function lerLayoutIA(resposta: string, pedidos: ReadonlySet<string>): Map<string, LayoutIA> {
  const out = new Map<string, LayoutIA>()
  const json = /\{[\s\S]*\}/.exec(resposta ?? '')?.[0]
  if (!json) return out
  let dados: unknown
  try {
    dados = JSON.parse(json)
  } catch {
    return out
  }
  if (!dados || typeof dados !== 'object') return out
  const lista = (v: unknown, max: number): string[] =>
    Array.isArray(v)
      ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean))].slice(0, max)
      : []
  for (const [caminho, v] of Object.entries(dados as Record<string, unknown>)) {
    if (!pedidos.has(caminho) || !v || typeof v !== 'object') continue
    const d = v as Record<string, unknown>
    const gatilhos = lista(d.gatilhos, 6)
    if (!gatilhos.length) continue
    const tema = typeof d.tema === 'string' ? d.tema.trim().toLowerCase() : ''
    out.set(caminho, { gatilhos, termos: lista(d.termos, 10), ...(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tema) ? { tema } : {}) })
  }
  return out
}

export interface MudancaPassada {
  relPath: string
  acao: 'tema' | 'juntar' | 'aposentar' | 'datas' | 'gatilhos'
  detalhe: string
}

export interface PortaMemoria {
  propose(input: MemoryProposeInput): Promise<unknown>
  applyPending(): Promise<unknown>
}

export interface DepsAplicar {
  memory: PortaMemoria
  perguntar?: PerguntarIA
  /** Varredura de segredos antes de gravar (o mesmo `sanitizeProposal` do memorista). */
  sanitize(input: MemoryProposeInput): Promise<MemoryProposeInput>
  temasExistentes: readonly string[]
  now: number
  /** Data de modificação do arquivo da memória (ms), ou null. Ver `datasConfiaveis`. */
  mtime?(relPath: string): number | null
}

export interface ResultadoAplicar {
  mudancas: MudancaPassada[]
  /** Memórias que a IA deveria completar e ficaram para a próxima passada. */
  pendentesIA: number
  chamadasIA: number
  falhas: number
}

/**
 * Executa o plano (modo `ligado`). Junta todas as mudanças de uma memória numa versão só,
 * com o bibliotecário como autor; propostas recusadas não derrubam as outras.
 */
export async function aplicarPassada(
  plano: PlanoPassada,
  entries: readonly EntradaBibliotecario[],
  deps: DepsAplicar,
  o: OpcoesPassada = {}
): Promise<ResultadoAplicar> {
  const porCaminho = new Map(entries.filter((e) => e.status === 'active').map((e) => [e.relPath, e]))
  const corpo = new Map<string, string>()
  const mudancas: MudancaPassada[] = []
  const texto = (relPath: string): string => corpo.get(relPath) ?? porCaminho.get(relPath)!.body
  const declarou = (relPath: string): boolean => !!lerCampos(porCaminho.get(relPath)?.body ?? '').tema

  // 2. repetidas: a que fica absorve o que só a outra dizia; a outra é aposentada.
  const aposentar: string[] = []
  for (const r of plano.repetidas.slice(0, o.maxJuncoes ?? 5)) {
    if (!porCaminho.has(r.fica) || !porCaminho.has(r.sai)) continue
    const extra = separar(porCaminho.get(r.sai)!.body).corpo.trim()
    const atual = texto(r.fica)
    const somado = atual.includes(extra) ? atual : `${atual.trimEnd()}\n\n${extra}\n`
    const antes = lerCampos(somado).substitui ?? []
    corpo.set(r.fica, comCampos(somado, { substitui: [...new Set([...antes, r.sai])] }))
    aposentar.push(r.sai)
    mudancas.push({ relPath: r.fica, acao: 'juntar', detalhe: `absorveu ${r.sai} (cosseno ${r.cos})` })
    mudancas.push({ relPath: r.sai, acao: 'aposentar', detalhe: `repetida de ${r.fica}` })
  }
  const saindo = new Set(aposentar)

  // 1. temas das soltas (mecânico).
  for (const t of plano.temas) {
    if (saindo.has(t.relPath) || !porCaminho.has(t.relPath) || declarou(t.relPath)) continue
    corpo.set(t.relPath, comCampos(texto(t.relPath), { tema: t.para }))
    mudancas.push({ relPath: t.relPath, acao: 'tema', detalhe: `${t.de} → ${t.para} (nota ${t.nota})` })
  }

  // 3a. datas do banco (D42) ou do arquivo, sem IA; sem data confiável, não escreve.
  for (const c of plano.completar) {
    const e = porCaminho.get(c.relPath)
    if (!c.datas || !e || saindo.has(c.relPath)) continue
    const fonte = datasConfiaveis(e, deps.mtime?.(c.relPath) ?? null)
    if (!fonte) continue
    const atuais = lerCampos(texto(c.relPath))
    const criada = atuais.criada ?? dataCabecalho(fonte.criada)
    const modificada = atuais.modificada ?? dataCabecalho(fonte.modificada)
    corpo.set(c.relPath, comCampos(texto(c.relPath), { criada, modificada }))
    mudancas.push({ relPath: c.relPath, acao: 'datas', detalhe: `criada ${criada}, modificada ${modificada}` })
  }

  // 3b. gatilhos/termos pela IA, um lote por passada (o freio do laço).
  const faltamGatilhos = plano.completar.filter((c) => c.gatilhos && porCaminho.has(c.relPath) && !saindo.has(c.relPath))
  const lote = faltamGatilhos.slice(0, o.loteIA ?? 10)
  let chamadasIA = 0
  if (lote.length && deps.perguntar) {
    chamadasIA = 1
    const pergunta = `TEMAS EXISTENTES: ${deps.temasExistentes.join(', ') || '(nenhum)'}\n\n# MEMÓRIAS\n\n${lote
      .map((c) => `### ${c.relPath}\n${separar(porCaminho.get(c.relPath)!.body).corpo.slice(0, 2500)}`)
      .join('\n\n')}`
    let resposta: string | null = null
    try {
      resposta = await deps.perguntar(`${PROMPT_LAYOUT}\n\n---\n\n${pergunta}`)
    } catch {
      resposta = null
    }
    const layout = lerLayoutIA(resposta ?? '', new Set(lote.map((c) => c.relPath)))
    for (const [relPath, d] of layout) {
      const tema = d.tema && !declarou(relPath) && !plano.temas.some((t) => t.relPath === relPath) ? d.tema : undefined
      corpo.set(relPath, comCampos(texto(relPath), { gatilhos: d.gatilhos, termos: d.termos.length ? d.termos : undefined, ...(tema ? { tema } : {}) }))
      mudancas.push({ relPath, acao: 'gatilhos', detalhe: `${d.gatilhos.length} gatilhos${tema ? `, tema ${tema}` : ''}` })
    }
  }

  let falhas = 0
  let gravou = false
  const base = { proposedBy: BIBLIOTECARIO_AGENT, originAgent: BIBLIOTECARIO_AGENT }
  for (const [relPath, body] of corpo) {
    const e = porCaminho.get(relPath)!
    try {
      await deps.memory.propose(await deps.sanitize({ op: 'update', relPath, title: e.title, hook: e.hook, body, expectedRevision: e.revision, ...base }))
      gravou = true
    } catch {
      falhas++
    }
  }
  for (const relPath of aposentar) {
    try {
      await deps.memory.propose({ op: 'retire', relPath, expectedRevision: porCaminho.get(relPath)!.revision, ...base })
      gravou = true
    } catch {
      falhas++
    }
  }
  if (gravou) await deps.memory.applyPending()
  const completadas = new Set(mudancas.filter((m) => m.acao === 'gatilhos').map((m) => m.relPath))
  return { mudancas, pendentesIA: faltamGatilhos.filter((c) => !completadas.has(c.relPath)).length, chamadasIA, falhas }
}

/** Relatório legível da passada (o que o Erick lê para aprovar a simulação). */
export function relatorioMarkdown(modo: ModoBibliotecario, plano: PlanoPassada, quando: number, r?: ResultadoAplicar): string {
  const l: string[] = [`# Bibliotecário — passada de ${new Date(quando).toLocaleString('pt-BR')}`, '', `Modo: **${modo}**${modo === 'simulacao' ? ' (nada foi gravado)' : ''}`, '']
  l.push(`## Temas para memórias soltas (${plano.temas.length})`, ...plano.temas.map((t) => `- ${t.relPath}: ${t.de} → **${t.para}** (nota ${t.nota})`), '')
  l.push(`## Repetidas (${plano.repetidas.length})`, ...plano.repetidas.map((x) => `- fica **${x.fica}**, sai ${x.sai} (cosseno ${x.cos})`), '')
  const conta = (k: 'tema' | 'datas' | 'gatilhos'): number => plano.completar.filter((c) => c[k]).length
  l.push(`## Layout antigo`, `- sem tema declarado: ${conta('tema')} · sem datas: ${conta('datas')} · sem gatilhos: ${conta('gatilhos')}`, '')
  l.push(`## Sugestões de tema novo (${plano.gruposNovos.length})`, ...plano.gruposNovos.map((g) => `- ${g.join(', ')}`), '')
  l.push(`## Níveis (regra)`, `- ${NIVEIS.map((n) => `${n}: ${plano.niveis[n]}`).join(' · ')}`, '')
  if (r) {
    l.push(`## O que foi gravado (${r.mudancas.length})`, ...r.mudancas.map((m) => `- ${m.acao} · ${m.relPath}: ${m.detalhe}`), '')
    l.push(`Chamadas à IA: ${r.chamadasIA} · ficaram para a próxima: ${r.pendentesIA} · recusadas: ${r.falhas}`)
  }
  return l.join('\n')
}
